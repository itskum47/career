/**
 * Browser Controller - manages Playwright browser sessions for job applications.
 */

import { chromium, type Browser, type BrowserContext, type Page, type ElementHandle } from 'playwright';
import type { BrowserConfig, BrowserSession, PageState, FormField, BrowserActionResult, NavigationResult, FormFillResult, FormFieldError, FileUploadResult, SubmissionResult, BrowserSessionStateSnapshot, ATSSignature, BrowserCookie, FormFieldType, FieldSource, AccessibilityNode, ButtonElement, LinkElement, FileInputMeta, AttachmentUploadResult, SubmissionTransportEntry } from './types.ts';
import type { Application } from '../core/types.ts';
import { config } from '../core/config.ts';
import { generateSessionId } from '../core/ids.ts';
import { logger } from '../core/logger.ts';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { startTimer, performanceCollector } from '../performance/index.ts';
import { STAGES } from '../performance/stages.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Attachment lifecycle bounds. Two questions, two bounds:
//   1) "did this site start a separate upload?" — answered by the REQUEST
//      starting, which is immediate (S3 presigned POST). A short probe keeps
//      portals that post files WITH the form (no upload lifecycle) fast —
//      measured: a 10s response-first probe made a form-post pipeline take
//      42.5s instead of 1.9s.
//   2) "did that upload finish OK?" — only relevant once an upload is under
//      way, so it gets the long bound.
const UPLOAD_START_PROBE_MS = 2000;
const UPLOAD_RESPONSE_TIMEOUT_MS = 30000;
const UPLOAD_CHIP_TIMEOUT_MS = 20000;

const ATS_SIGNATURES: ATSSignature[] = [
  {
    name: 'Greenhouse',
    selectors: ['[data-qa="application-form"]', '.application-form', '#application_form'],
    urlPatterns: ['/jobs/', '/careers/', 'greenhouse.io'],
    indicators: ['greenhouse', 'gh_jid'],
  },
  {
    name: 'Lever',
    selectors: ['.lever-application-form', '[data-qa="application-form"]', '.application-form'],
    urlPatterns: ['/jobs/', 'lever.co'],
    indicators: ['lever', 'lever.co'],
  },
  {
    name: 'Ashby',
    selectors: ['[data-testid="application-form"]', '.ashby-application-form'],
    urlPatterns: ['/careers/', 'ashbyhq.com'],
    indicators: ['ashby', 'ashbyhq'],
  },
  {
    name: 'Workday',
    selectors: ['[data-automation-id="jobApplication"]', '.wd-application-form'],
    urlPatterns: ['/job/', 'myworkdayjobs.com'],
    indicators: ['workday', 'myworkdayjobs'],
  },
  {
    name: 'iCIMS',
    selectors: ['.icims-apply-form', '#icims_content_iframe'],
    urlPatterns: ['/jobs/', 'icims.com'],
    indicators: ['icims'],
  },
];

export class BrowserController {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private config: BrowserConfig;
  private session: BrowserSession | null = null;

  constructor(browserConfig?: Partial<BrowserConfig>) {
    this.config = {
      profilePath: browserConfig?.profilePath || config.browser.profilePath,
      headless: browserConfig?.headless ?? config.browser.headless,
      slowMo: browserConfig?.slowMo ?? config.browser.slowMo,
      backend: browserConfig?.backend ?? config.browser.backend,
      obscuraPort: browserConfig?.obscuraPort ?? config.browser.obscuraPort,
      obscuraStealth: browserConfig?.obscuraStealth ?? config.browser.obscuraStealth,
      obscuraBin: browserConfig?.obscuraBin ?? config.browser.obscuraBin,
      defaultTimeout: browserConfig?.defaultTimeout ?? config.browser.defaultTimeout,
      navigationTimeout: browserConfig?.navigationTimeout ?? config.browser.navigationTimeout,
      viewport: browserConfig?.viewport ?? config.browser.viewport,
      userAgent: browserConfig?.userAgent ?? config.browser.userAgent,
      locale: browserConfig?.locale ?? config.browser.locale,
      timezoneId: browserConfig?.timezoneId ?? config.browser.timezoneId,
    };
  }

  private obscuraProcess: any = null;

  async initialize(): Promise<void> {
    const timer = startTimer({ stage: STAGES.BROWSER_LAUNCH });
    logger.info('Initializing browser', { backend: this.config.backend, headless: this.config.headless });

    // Ensure profile directory exists
    const profileDir = path.dirname(this.config.profilePath);
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }

    const ctxTimer = startTimer({ stage: STAGES.BROWSER_CONTEXT_CREATE });

    if (this.config.backend === 'obscura') {
      // Spawn obscura serve and connect over CDP.
      const { spawn } = await import('child_process');
      const args = ['serve', '--port', String(this.config.obscuraPort)];
      if (this.config.obscuraStealth) args.push('--stealth');
      this.obscuraProcess = spawn(this.config.obscuraBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      // Wait for readiness
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('obscura serve did not become ready in time')), 30000);
        const onData = (data: Buffer) => {
          const text = data.toString();
          if (text.includes('listening') || text.includes('ws://') || text.includes('ready')) {
            clearTimeout(timeout);
            this.obscuraProcess.stdout.off('data', onData);
            resolve();
          }
        };
        this.obscuraProcess.stdout.on('data', onData);
        this.obscuraProcess.on('error', (err: any) => { clearTimeout(timeout); reject(err); });
        this.obscuraProcess.on('exit', (code: number) => {
          if (code !== 0 && code !== null) { clearTimeout(timeout); reject(new Error(`obscura exited with code ${code}`)); }
        });
      }).catch((e) => {
        logger.warn('Obscura readiness probe timed out; attempting connection anyway', { error: String(e) });
      });
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.config.obscuraPort}`);
      this.browser = browser;
      const contexts = browser.contexts();
      this.context = contexts.length ? contexts[0] : await browser.newContext();
      this.page = this.context.pages()[0] || await this.context.newPage();
      ctxTimer.end(true);
    } else {
    this.context = await chromium.launchPersistentContext(this.config.profilePath, {
      headless: this.config.headless,
      slowMo: this.config.slowMo,
      viewport: this.config.viewport,
      userAgent: this.config.userAgent,
      locale: this.config.locale,
      timezoneId: this.config.timezoneId,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    });
    ctxTimer.end(true);

    this.browser = this.context.browser();
    this.page = this.context.pages()[0] || await this.context.newPage();
    }
    
    // Set default timeouts
    this.page!.setDefaultTimeout(this.config.defaultTimeout);
    this.page!.setDefaultNavigationTimeout(this.config.navigationTimeout);

    timer.end(true);
    performanceCollector.record({ stage: STAGES.BROWSER_LAUNCH, durationMs: timer.getDurationMs(), success: true });
    logger.info('Browser initialized successfully');
  }

  async createSession(applicationId: string, jobId: string, url: string): Promise<BrowserSession> {
    this.session = {
      sessionId: generateSessionId(),
      applicationId,
      jobId,
      url,
      state: 'navigating',
      cookies: [],
      localStorage: {},
      screenshotPaths: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    return this.session;
  }

  async navigate(url: string): Promise<NavigationResult> {
    if (!this.page) throw new Error('Browser not initialized');
    const timer = startTimer({ stage: STAGES.BROWSER_NAVIGATE });

    try {
      logger.info('Navigating to URL', { url });
      this.updateSessionState('navigating');

      // Phase 4A: sub-stage instrumentation — measure each step, don't guess
      const gotoTimer = startTimer({ stage: STAGES.BROWSER_NAV_GOTO });
      const response = await this.page.goto(url, { 
        waitUntil: 'domcontentloaded',
        timeout: this.config.navigationTimeout 
      });
      gotoTimer.end(!!response && response.status() < 400);

      if (!response) {
        timer.end(false, 'No response');
        return { success: false, error: 'No response from navigation', url, title: '' };
      }

      if (response.status() >= 400) {
        timer.end(false, `HTTP ${response.status()}`);
        return { success: false, error: `HTTP ${response.status()}`, url, title: '' };
      }

      // Targeted readiness wait instead of networkidle.
      // Phase 4A measured root cause: waitForSelector resolves matches in DOM
      // order and waits for the FIRST match to be visible. The first element
      // matching the old selector was <input type="hidden" name="jobId"> —
      // which can never be visible — so this wait ALWAYS burned its full
      // 5000ms timeout (measured 5002ms/job = 98.3% of browser.navigate)
      // even though the DOM was ready in 32-63ms. The :visible filter makes
      // the first match an actually-visible form control: same deterministic
      // intent (wait until an interactive control exists), real latency only.
      const readyTimer = startTimer({ stage: STAGES.BROWSER_NAV_READINESS });
      try {
        await this.page.waitForSelector(
          'input:visible, textarea:visible, select:visible, button[type="submit"]:visible, button[type="button"]:visible, [role="button"]:visible',
          { timeout: 5000 }
        ).catch(() => {});
      } catch (e) {
        // Fallback - wait a bit more
        await this.page.waitForTimeout(1000);
      }
      readyTimer.end(true);

      const titleTimer = startTimer({ stage: STAGES.BROWSER_NAV_TITLE });
      const title = await this.page.title();
      titleTimer.end(true);

      // Phase 4A: the engine performs the authoritative capturePageState
      // immediately after navigation (engine.ts) and no consumer reads the
      // navigate-time capture (verified by grep: navResult.pageState and
      // session.pageState have no readers; saveSessionState captures fresh).
      // Removing this duplicate serialized the full HTML + walked the DOM +
      // scanned forms twice per job (measured 11ms/job).

      this.updateSessionState('loading');
      this.session!.url = this.page.url();

      logger.info('Navigation successful', { url: this.page.url(), title });
      timer.end(true);
      return {
        success: true,
        url: this.page.url(),
        title,
      };
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.error('Navigation failed', { url, error: err });
      this.updateSessionState('failed');
      timer.end(false, err);
      return { success: false, error: err, url, title: '' };
    }
  }

  async capturePageState(): Promise<PageState> {
    if (!this.page) throw new Error('No page available');

    const capTimer = startTimer({ stage: STAGES.BROWSER_CAPTURE_PAGE_STATE });
    const [html, accessibilityTree, forms, buttons, links] = await Promise.all([
      this.page.content(),
      this.getAccessibilityTree(),
      this.detectForms(),
      this.detectButtons(),
      this.detectLinks(),
    ]);
    capTimer.end(true);

    return {
      url: this.page.url(),
      title: await this.page.title(),
      html,
      accessibilityTree,
      forms,
      buttons,
      links,
      capturedAt: new Date(),
    };
  }

  private async getAccessibilityTree(): Promise<AccessibilityNode[]> {
    try {
      // Use evaluate to get accessibility tree instead of page.accessibility
      const snapshot = await this.page!.evaluate(() => {
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_ELEMENT,
          null
        );
        
        const nodes: any[] = [];
        let node = walker.nextNode();
        while (node) {
          const el = node as HTMLElement;
          const role = el.getAttribute('role') || el.tagName.toLowerCase();
          nodes.push({
            role,
            name: el.getAttribute('aria-label') || el.getAttribute('name') || el.textContent?.trim().slice(0, 100),
            description: el.getAttribute('aria-describedby'),
            value: (el as HTMLInputElement).value,
            states: [],
            children: [],
            uid: `acc_${Math.random().toString(36).slice(2)}`,
            boundingBox: el.getBoundingClientRect(),
          });
          node = walker.nextNode();
        }
        return nodes;
      });
      
      return this.flattenAccessibilityTree(snapshot);
    } catch {
      return [];
    }
  }

  private flattenAccessibilityTree(nodes: any[], result: AccessibilityNode[] = []): AccessibilityNode[] {
    for (const node of nodes) {
      if (!node) continue;
      
      result.push({
        role: node.role,
        name: node.name,
        description: node.description,
        value: node.value,
        states: node.states || [],
        children: [],
        uid: node.uid || Math.random().toString(36).slice(2),
        boundingBox: node.boundingBox,
      });

      if (node.children && node.children.length > 0) {
        this.flattenAccessibilityTree(node.children, result);
      }
    }
    return result;
  }

  private async detectForms(): Promise<FormField[]> {
    const fields = await this.page!.evaluate(() => {
      const elements = document.querySelectorAll('input, textarea, select');
      return Array.from(elements).map((el, idx) => {
        const input = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        const label = input.labels?.[0]?.textContent?.trim() || 
                     input.getAttribute('aria-label') || 
                     input.getAttribute('placeholder') || 
                     input.getAttribute('name') || 
                     input.id || 
                     `field_${idx}`;
        
        let type = input.type || input.tagName.toLowerCase();
        if (type === 'select-one' || type === 'select-multiple') type = 'select';
        
        let options: string[] | undefined;
        if (input.tagName === 'SELECT') {
          options = Array.from((input as HTMLSelectElement).options).map(o => o.value);
        }
        
        let placeholder: string | undefined;
        if (input.tagName !== 'SELECT') {
          placeholder = (input as HTMLInputElement).placeholder || undefined;
        }
        
        // fillField's fallback selector is [uid="…"]; expose the synthetic uid
        // on elements that have neither id nor name (e.g. Greenhouse's
        // unnamed required proxy inputs) so answered fields are locatable.
        if (!input.id && !input.name) {
          input.setAttribute('uid', `field_${idx}`);
        }

        return {
          uid: `field_${idx}`,
          label: label,
          type: type as FormFieldType,
          name: input.name,
          id: input.id,
          placeholder: placeholder,
          required: input.required || false,
          options: options,
          value: input.value || undefined,
          confidence: 0.8,
          source: 'dom' as FieldSource,
        };
      });
    });

    return fields;
  }

  private async detectButtons(): Promise<ButtonElement[]> {
    return this.page!.evaluate(() => {
      const buttons = document.querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"]');
      return Array.from(buttons).map((btn, idx) => {
        const el = btn as HTMLElement;
        const text = el.textContent?.trim() || el.getAttribute('value') || '';
        let type = el.tagName === 'A' ? 'link' : (el.getAttribute('type') || 'button');
        if (type !== 'submit' && type !== 'button' && type !== 'link' && type !== 'next' && type !== 'back' && type !== 'continue' && type !== 'upload') {
          type = 'other';
        }
        return {
          uid: `btn_${idx}`,
          text,
          type: type as ButtonElement['type'],
          enabled: !el.hasAttribute('disabled'),
          primary: el.classList.contains('primary') || el.classList.contains('btn-primary'),
        };
      });
    });
  }

  private async detectLinks(): Promise<LinkElement[]> {
    return this.page!.evaluate(() => {
      const links = document.querySelectorAll('a[href]');
      return Array.from(links).slice(0, 50).map((link, idx) => {
        const el = link as HTMLAnchorElement;
        return {
          uid: `link_${idx}`,
          text: el.textContent?.trim() || '',
          href: el.href,
          external: el.hostname !== window.location.hostname,
        };
      });
    });
  }

  async fillForm(fields: FormField[], profileData: Record<string, string>): Promise<FormFillResult> {
    if (!this.page) throw new Error('Browser not initialized');

    this.updateSessionState('filling');
    let filledFields: number = 0;
    const failedFields: FormFieldError[] = [];

    // Phase 5C/5E: fields are filled SEQUENTIALLY in original DOM order.
    // A measured attempt to run independent fills concurrently (Promise.all,
    // scripts/concurrent-fill-probe.ts scenario 2) was REVERTED: Playwright's
    // fill() focuses each element and inserts into whatever holds focus, so
    // concurrent fills race on the shared document.activeElement — values
    // landed in the WRONG fields (fullName/email left empty, phone contained
    // three concatenated values) and validation failed 5/5. Rule 4: a change
    // is kept only if measured performance improves WITHOUT correctness loss.
    for (const field of fields) {
      // File inputs are handled by uploadDocuments/setInputFiles, never text-filled
      if (field.type === 'file') continue;
      // Phase 5C: per-field timing (dynamic stage name = field identity).
      const fieldTimer = startTimer({ stage: STAGES.FILL_FIELD(this.fieldStageName(field)) });
      try {
        const prepTimer = startTimer({ stage: STAGES.FILL_PREP });
        const value = this.mapFieldToValue(field, profileData);
        prepTimer.end(true);
        if (!value) {
          // Skip fields with no matching profile data (not an error for optional fields)
          if (field.required) {
            failedFields.push({ field, error: 'No matching profile data' });
            fieldTimer.end(false, 'No matching profile data');
          } else {
            fieldTimer.end(true, 'skipped_no_value');
          }
          continue;
        }
        await this.fillField(field, value);
        filledFields++;
        fieldTimer.end(true);
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        fieldTimer.end(false, err);
        failedFields.push({ field, error: err });
      }
    }

    this.updateSessionState('filling');
    
    return {
      success: failedFields.length === 0,
      filledFields,
      failedFields,
    };
  }

  mapFieldToValue(field: FormField, profileData: Record<string, string>): string | null {
    if (field.mappedProfileField && profileData[field.mappedProfileField]) {
      return profileData[field.mappedProfileField];
    }

    const label = field.label.toLowerCase();
    const name = field.name?.toLowerCase() || '';

    const mappings: Record<string, string> = {
      'first name': 'firstName',
      'last name': 'lastName',
      'fullname': 'fullName',
      'full name': 'fullName',
      'lastname': 'lastName',
      'email': 'email',
      'phone': 'phone',
      'telephone': 'phone',
      'mobile': 'phone',
      'address': 'address',
      'city': 'city',
      'state': 'state',
      'zip': 'zipCode',
      'postal code': 'zipCode',
      'country': 'country',
      'linkedin': 'linkedin',
      'github': 'github',
      'portfolio': 'portfolio',
      'website': 'website',
      'summary': 'summary',
      'objective': 'summary',
      'coverletter': 'coverLetter',
      'cover letter': 'coverLetter',
      'current company': 'currentCompany',
      'current title': 'currentTitle',
      'years of experience': 'yearsExperience',
      'salary': 'expectedSalary',
      'notice period': 'noticePeriod',
    };

    for (const [key, profileKey] of Object.entries(mappings)) {
      if (label.includes(key) || name.includes(key)) {
        return profileData[profileKey] || null;
      }
    }

    return null;
  }

  /** Stable, stat-friendly identity for a form field (Phase 5C). */
  private fieldStageName(field: FormField): string {
    const raw = field.name || field.label || field.uid || 'unknown';
    return raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
  }

  async fillField(field: FormField, value: string): Promise<void> {
    if (!this.page) throw new Error('No page available');

    const selector = field.id ? `#${field.id}` : field.name ? `[name="${field.name}"]` : `[uid="${field.uid}"]`;

    // Phase 5C/5D: split selector resolution from the fill action, and time the
    // fallback cascade separately so each can be measured and optimized alone.
    const selTimer = startTimer({ stage: STAGES.FILL_SELECTOR });
    let element: Awaited<ReturnType<Page['waitForSelector']>> = null;
    let resolveError: unknown = null;
    try {
      element = await this.page.waitForSelector(selector, { timeout: 5000 });
    } catch (e) {
      resolveError = e;
    }
    if (!element) {
      selTimer.end(false, resolveError ? String(resolveError) : `Element not found: ${selector}`);
      const fbTimer = startTimer({ stage: STAGES.FILL_FALLBACK });
      const filled = await this.tryFallbackFill(field, value);
      fbTimer.end(filled);
      if (filled) return;
      throw resolveError instanceof Error ? resolveError : new Error(`Element not found: ${selector}`);
    }
    selTimer.end(true);

    const actTimer = startTimer({ stage: STAGES.FILL_ACTION });
    try {
      switch (field.type) {
        case 'select':
          await element.selectOption(value);
          break;
        case 'checkbox':
        case 'radio':
          if (value === 'true' || value === 'yes' || value === '1') {
            await element.check();
          } else {
            await element.uncheck();
          }
          break;
        case 'file':
          await element.setInputFiles(value);
          break;
        default: {
          // Combobox dropdowns (react-select & friends, common on Greenhouse/
          // Lever/Ashby): typing alone never commits a value — the menu option
          // must be clicked. Detect via role/aria and drive the full select.
          const role = await element.getAttribute('role');
          const hasPopup = await element.getAttribute('aria-haspopup');
          if (role === 'combobox' || hasPopup === 'listbox') {
            await this.fillCombobox(element, value);
          } else {
            await element.fill(value);
          }
          break;
        }
      }
      actTimer.end(true);
    } catch (error) {
      actTimer.end(false, error instanceof Error ? error.message : String(error));
      const fbTimer = startTimer({ stage: STAGES.FILL_FALLBACK });
      const filled = await this.tryFallbackFill(field, value);
      fbTimer.end(filled);
      if (filled) return;
      throw error;
    }
  }

  /** Existing alt-selector cascade, extracted so both failure paths share it (Phase 5C). */
  private async tryFallbackFill(field: FormField, value: string): Promise<boolean> {
    const altSelectors = [
      `input[placeholder*="${field.placeholder}"]`,
      `input[aria-label*="${field.label}"]`,
      `label:has-text("${field.label}") >> input`,
    ];
    for (const altSelector of altSelectors) {
      try {
        const el = await this.page!.waitForSelector(altSelector, { timeout: 2000 });
        if (el) {
          await el.fill(value);
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  }

  /**
   * Drive a combobox (react-select style — the dropdown Greenhouse uses for
   * its custom questions) to a COMMITTED selection: set filter text, open the
   * menu, then CLICK the matching option. Typing alone never commits — the
   * dropdown's state would stay unset and the submitted form would silently
   * miss required answers (measured 2026-10-07/08).
   *
   * Measured on the live Greenhouse form: fill() does NOT open the menu
   * (aria-expanded stays false); click() from closed opens it, but click()
   * while open TOGGLES it closed — so each open strategy is tried in order
   * with a wait between them. Only VISIBLE options are matched: the intl
   * phone widget keeps ~244 invisible [role="option"] entries in the DOM
   * (e.g. "India+91") that would otherwise be partial-matched.
   */
  private async fillCombobox(
    element: Awaited<ReturnType<Page['waitForSelector']>>,
    value: string,
  ): Promise<void> {
    if (!element || !this.page) throw new Error('No page available');

    const waitVisible = (ms: number) =>
      this.page!
        .waitForSelector('[role="option"]:visible', { timeout: ms })
        .catch(() => null);

    let opened = null;
    // 1) Type the filter text — opens menus on input-driven comboboxes.
    await element.fill(value);
    opened = await waitVisible(700);
    // 2) Click to open (closed menus, e.g. Greenhouse react-select).
    if (!opened) {
      await element.click();
      opened = await waitVisible(1200);
    }
    // 3) Clear the filter — some widgets open on clear (also guarantees the
    //    full unfiltered option list for matching).
    if (!opened) {
      await element.fill('');
      opened = await waitVisible(800);
    }
    // 4) One more toggle click (menu is closed again at this point).
    if (!opened) {
      await element.click();
      opened = await waitVisible(1200);
    }
    if (!opened) throw new Error(`Combobox opened no options for "${value}"`);

    const wanted = value.trim().toLowerCase();
    let chosen: (typeof opened) | null = null;
    let partial: (typeof opened) | null = null;
    for (const opt of await this.page.$$('[role="option"]:visible')) {
      const text = ((await opt.textContent()) || '').trim().toLowerCase();
      if (!text) continue;
      if (text === wanted) { chosen = opt; break; }
      if (!partial && text.includes(wanted)) partial = opt;
    }
    const finalChoice = chosen || partial;
    if (!finalChoice) {
      await this.page.keyboard.press('Escape').catch(() => undefined);
      throw new Error(`No combobox option matches "${value}"`);
    }
    await finalChoice.click();

    // Confirm the menu closed (selection committed); non-fatal if slow.
    await this.page
      .waitForSelector('[role="option"]:visible', { state: 'detached', timeout: 2000 })
      .catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Attachment lifecycle (Phase 6W/6X — Greenhouse attachment commit)
  //
  // Greenhouse (LOTUS renderer) commits an attachment only through its own
  // flow: hidden file input change → presigned multipart XHR → 2xx → the app
  // stores {name, url} → only then does its validator consider the field
  // present ("Resume/CV is required." otherwise). Setting files and returning
  // is NOT upload success, and a visual chip alone is not proof either.
  // -------------------------------------------------------------------------

  /**
   * Resolve which file input is the resume and which is the cover letter.
   * Pure (no DOM) so the rule is unit-testable.
   *
   * Greenhouse inputs carry an `id` and NO `name`
   * (`#resume`, `#cover_letter`). Matching on `name` alone therefore collapsed
   * both onto the first input: the cover letter was written into the resume
   * input and wiped the resume attachment state (measured 2026-10-08,
   * APP-20261008-000099 — "Resume/CV is required." with a stale chip).
   * Rule: id → name → deterministic order (first = resume, second = cover),
   * and the two targets may never resolve to the same input.
   */
  static resolveFileInputTargets(meta: FileInputMeta[]): { resume?: FileInputMeta; coverLetter?: FileInputMeta } {
    const usable = meta.filter(
      m => m.accept === '' || m.accept.includes('pdf') || m.accept.includes('doc') || m.accept.includes('*'),
    );
    const isResume = (m: FileInputMeta) => /resume|\bcv\b|curriculum/i.test(m.id) || /resume|\bcv\b|curriculum/i.test(m.name);
    const isCover = (m: FileInputMeta) => /cover|letter/i.test(m.id) || /cover|letter/i.test(m.name);

    let resume = usable.find(isResume);
    let coverLetter = usable.find(isCover);

    // Never let both targets be the same input (the measured defect).
    if (resume && coverLetter && resume.index === coverLetter.index) {
      coverLetter = usable.find(m => m.index !== resume!.index && isCover(m));
    }
    // Deterministic order fallback keeps the two attachments distinct even when
    // the markup carries no usable id/name.
    if (!resume) resume = usable[0];
    if (!coverLetter) coverLetter = usable.find(m => m.index !== resume?.index);

    return { resume, coverLetter };
  }

  /** One DOM scan for every file input: index, id, name, accept. */
  async scanFileInputs(): Promise<{ meta: FileInputMeta[]; handles: ElementHandle[] }> {
    const meta: FileInputMeta[] = await this.page!.$$eval('input[type="file"]', els =>
      els.map((el, index) => {
        const input = el as HTMLInputElement;
        return {
          index,
          id: input.id || '',
          name: (input.name || '').toLowerCase(),
          accept: (input.accept || '').toLowerCase(),
        };
      }),
    );
    const handles = meta.length > 0 ? await this.page!.$$('input[type="file"]') : [];
    return { meta, handles };
  }

  /**
   * Attach one file through the page's own input and PROVE the upload
   * lifecycle completed: the presigned multipart response is observed and the
   * site renders the committed attachment (filename chip). Never reports
   * success on `setInputFiles` alone.
   */
  async attachAttachment(
    handle: ElementHandle,
    meta: FileInputMeta,
    filePath: string,
    kind: 'resume' | 'cover_letter',
  ): Promise<AttachmentUploadResult> {
    const expectedName = filePath.split(/[\\/]/).pop() || '';
    const result: AttachmentUploadResult = {
      kind,
      inputId: meta.id,
      inputIndex: meta.index,
      filePath,
      expectedName,
      fileAttached: false,
      uploadObserved: false,
      uploadStatus: null,
      uploadHost: null,
      uploadPath: null,
      chipPresent: false,
      committed: false,
      verdict: 'unknown',
    };

    // A classic multipart form post sends its files WITH the submission, so there is
    // no separate upload lifecycle to observe — detected from the markup so this
    // costs nothing (measured: a 2s probe per attachment made a form-post pipeline
    // take 9.9s instead of 1.9s; Greenhouse's own form is `method="get"` with no
    // enctype because the JS app uploads attachments separately).
    const postsFilesWithForm = await handle
      .evaluate(el => {
        const form = (el as HTMLInputElement).closest('form');
        if (!form) return false;
        const enctype = (form.getAttribute('enctype') || '').toLowerCase();
        const method = (form.getAttribute('method') || 'get').toLowerCase();
        return method === 'post' && enctype.includes('multipart/form-data');
      })
      .catch(() => false);

    // Armed BEFORE the file is set: a fast upload must not be missed. Detection is
    // two-stage — the REQUEST starting proves the site has a separate upload
    // lifecycle (short probe), and only then is its RESPONSE awaited (long bound).
    const isMultipartUpload = (r: any) =>
      r.method() === 'POST' && (r.headers()['content-type'] || '').toLowerCase().includes('multipart/form-data');
    const uploadStart = postsFilesWithForm
      ? null
      : this.page!.waitForRequest(isMultipartUpload as any, { timeout: UPLOAD_START_PROBE_MS }).catch(() => null);

    try {
      await handle.setInputFiles(filePath);
      result.fileAttached = await handle.evaluate(el => {
        const input = el as HTMLInputElement;
        return !!input.files && input.files.length > 0 && input.files[0].name.length > 0;
      });
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      return result;
    }

    const uploadRequest = uploadStart ? await uploadStart : null;
    const response = uploadRequest
      ? await Promise.race([
          uploadRequest.response(),
          new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), UPLOAD_RESPONSE_TIMEOUT_MS)),
        ])
      : null;
    if (response === undefined) {
      result.verdict = 'failed';
      result.error = `upload started but no response within ${UPLOAD_RESPONSE_TIMEOUT_MS}ms`;
      logger.warn(`Attachment ${kind} upload timed out`, { inputId: result.inputId, fileName: expectedName });
      return result;
    }
    if (response) {
      result.uploadObserved = true;
      result.uploadStatus = response.status();
      result.uploadHost = this.hostOf(response.url());
      try {
        result.uploadPath = new URL(response.url()).pathname;
      } catch {
        result.uploadPath = null;
      }
      // A rejected upload can never commit — fail fast instead of waiting out
      // the chip timeout.
      if (result.uploadStatus < 200 || result.uploadStatus >= 300) {
        result.verdict = 'failed';
        result.error = `upload rejected with HTTP ${result.uploadStatus}`;
        logger.warn(`Attachment ${kind} rejected`, {
          inputId: result.inputId,
          fileName: expectedName,
          uploadStatus: result.uploadStatus,
          uploadHost: result.uploadHost,
          uploadPath: result.uploadPath,
        });
        return result;
      }
    }

    // Commit evidence as rendered by the site itself: the attachment chip
    // (filename) appears only after the upload succeeded. Greenhouse sets it
    // inside the upload success callback, so a chip that never renders means the
    // upload never completed.
    if (result.uploadObserved) {
      result.chipPresent = await this.page!
        .waitForFunction(name => document.body?.innerText?.includes(String(name)) === true, expectedName, {
          timeout: UPLOAD_CHIP_TIMEOUT_MS,
        })
        .then(() => true)
        .catch(() => false);
    } else {
      // No upload request observed: check the rendered state once, without waiting.
      result.chipPresent = await this.page!
        .evaluate(name => document.body?.innerText?.includes(String(name)) === true, expectedName)
        .catch(() => false);
    }

    if (result.chipPresent) {
      result.committed = true;
      result.verdict = 'committed';
      if (!result.uploadObserved) {
        // Some portals upload through a mechanism this listener cannot see; the
        // rendered attachment is then the only available proof (logged, not hidden).
        logger.warn(`Attachment ${kind} committed without an observed upload response`, {
          inputId: result.inputId,
          fileName: expectedName,
        });
      }
    } else if (result.uploadObserved) {
      // The site DID upload (2xx) but never rendered the attachment.
      result.verdict = 'failed';
      result.error = `upload returned ${result.uploadStatus} but no committed attachment was rendered for ${kind}`;
    } else {
      // No separate upload request was observed within the window: the site very
      // likely submits the files WITH the form (classic multipart form post).
      // Nothing failed, so this must not block a submission — but it is reported.
      result.verdict = 'unknown';
    }

    logger.info(`Attachment ${kind}`, {
      inputId: result.inputId,
      fileName: expectedName,
      fileAttached: result.fileAttached,
      uploadObserved: result.uploadObserved,
      uploadStatus: result.uploadStatus,
      uploadHost: result.uploadHost,
      chipPresent: result.chipPresent,
      verdict: result.verdict,
      committed: result.committed,
      error: result.error,
    });
    return result;
  }

  /** Which attachment sections the site marks required (rendered asterisk). */
  async detectRequiredAttachments(): Promise<{ resume: boolean; coverLetter: boolean }> {
    const text = await this.page!.evaluate(() => document.body?.innerText || '');
    return {
      resume: /Resume\s*\/?\s*CV\s*\*/i.test(text),
      coverLetter: /Cover\s+Letter\s*\*/i.test(text),
    };
  }

  async uploadFile(fieldName: string, filePath: string): Promise<FileUploadResult> {
    if (!this.page) throw new Error('Browser not initialized');

    try {
      const input = await this.page.waitForSelector(`input[type="file"][name="${fieldName}"], input[type="file"]`, { timeout: 10000 });
      if (!input) throw new Error('File input not found');

      await input.setInputFiles(filePath);
      
      return {
        success: true,
        filePath,
        fieldName,
      };
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: err,
        filePath,
        fieldName,
      };
    }
  }

  async submit(): Promise<SubmissionResult> {
    if (!this.page) throw new Error('Browser not initialized');

    this.updateSessionState('submitting');

    try {
      // Phase 5A: sub-stage instrumentation — measure before changing anything.
      const clickTimer = startTimer({ stage: STAGES.SUBMIT_CLICK });
      const submitSelectors = [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Submit")',
        'button:has-text("Apply")',
        'button:has-text("Send")',
        '[role="button"]:has-text("Submit")',
      ];

      // Phase 5D: selector-resolution phase measured separately from the press.
      const findTimer = startTimer({ stage: STAGES.SUBMIT_FIND });
      let btn: Awaited<ReturnType<Page['waitForSelector']>> = null;
      for (const selector of submitSelectors) {
        try {
          const el = await this.page.waitForSelector(selector, { timeout: 3000 });
          if (el && await el.isEnabled()) {
            btn = el;
            break;
          }
        } catch {
          continue;
        }
      }
      findTimer.end(!!btn);

      // Diagnostics captured BEFORE the click so a post-submit change can be
      // proven even when no navigation happens. Body TEXT LENGTH only — no
      // user data is read into logs.
      const bodyLenBefore = await this.page.evaluate(() => document.body?.innerText?.length ?? 0);
      const urlBefore = this.page.url();

      // Attempt 5 fix (APP-20261008-000099, measured submit.response_wait=1ms):
      // the old post-click wait raced confirmation text against
      // waitForLoadState('networkidle'). The form page was ALREADY network-idle
      // when the click returned (the last request was the document upload), so
      // that branch resolved instantly and checkConfirmation() ran 4ms after
      // the click — before Greenhouse's submit request even existed.
      // networkidle is now ONLY a post-signal settle, never the trigger.
      // The trigger is a real post-click signal, armed BEFORE the click so a
      // fast response can never be missed:
      //   1) confirmation text appearing (patterns unchanged),
      //   2) a submission-shaped response (see isSubmissionRequest below),
      //   3) a main-frame navigation (classic form POST).
      const POST_CLICK_WAIT_MS = 15000;
      const POST_SIGNAL_SETTLE_MS = 5000;
      let clickedAt = 0;

      // Submission transport signature (measured from the ATS's own code,
      // Attempt 6): the application is POSTed as JSON to a CROSS-ORIGIN submit
      // path (Greenhouse: boards.greenhouse.io), while the form lives on
      // job-boards.greenhouse.io. Matching on content-type instead of origin
      // therefore covers ATSs that submit cross-origin, and still excludes the
      // multipart attachment uploads (multipart/form-data) and third-party
      // analytics (text/plain / form-encoded).
      const isSubmissionRequest = (r: { request(): { method(): string; headers(): Record<string, string> } }) =>
        r.request().method() !== 'GET' &&
        (r.request().headers()['content-type'] || '').toLowerCase().includes('application/json');

      // Submission transport inventory (Attempt 6 gap): every non-GET request/response
      // after the click is recorded as method/host/path/status/timing — no
      // headers, cookies, bodies or query strings. Instrumentation is defensive:
      // a listener must never be able to fail an application (measured 2026-10-08,
      // APP-20261008-000099: a listener assuming the Response shape on the
      // `request` event threw `r.request is not a function` and killed the run).
      const submissionLog: SubmissionTransportEntry[] = [];
      const logTransport = (event: 'request' | 'response', method: string, url: string, status: number | null, resourceType: string | null, isRedirect: boolean, location?: string | null) => {
        const entry: SubmissionTransportEntry = {
          event,
          method,
          host: this.hostOf(url),
          path: this.hostPathForLog(url).replace(/^[^/]+/, ''),
          status,
          resourceType,
          elapsedMs: Date.now() - clickedAt,
        };
        if (isRedirect) {
          entry.isRedirect = true;
          // Redirect targets can carry tokens — only host+path is ever recorded.
          entry.redirect = location ? this.hostPathForLog(location).replace(/^[^/]+/, '') : null;
        }
        submissionLog.push(entry);
        logger.info('Post-click transport', entry);
      };
      const onRequest = (req: any) => {
        try {
          if (req.method() !== 'GET') logTransport('request', req.method(), req.url(), null, req.resourceType(), false);
        } catch { /* never fail an application from a listener */ }
      };
      const onResponse = (res: any) => {
        try {
          if (res.request().method() !== 'GET') {
            const isRedirect = typeof res.isRedirect === 'function' ? res.isRedirect() : false;
            logTransport('response', res.request().method(), res.url(), res.status(), res.request().resourceType(), isRedirect, res.headers()['location']);
          }
        } catch { /* never fail an application from a listener */ }
      };
      this.page.on('request', onRequest);
      this.page.on('response', onResponse);

      const armedSignals: Promise<string>[] = [
        this.page
          .waitForFunction(
            () => /confirmation|application submitted|thank you/i.test(document.body?.innerText || ''),
            { timeout: POST_CLICK_WAIT_MS },
          )
          .then(() => 'confirmation_text')
          .catch(() => 'confirmation_text:not_seen'),
        this.page
          .waitForResponse(isSubmissionRequest as any, { timeout: POST_CLICK_WAIT_MS })
          .then(r => `submit_response:${r.status()}`)
          .catch(() => 'submit_response:not_seen'),
        this.page
          .waitForEvent('framenavigated', { timeout: POST_CLICK_WAIT_MS })
          .then(() => 'navigation')
          .catch(() => 'navigation:not_seen'),
      ];

      let submitted = false;
      if (btn) {
        const pressTimer = startTimer({ stage: STAGES.SUBMIT_PRESS });
        clickedAt = Date.now();
        await btn.click();
        pressTimer.end(true);
        submitted = true;
      }
      clickTimer.end(submitted);

      if (!submitted) {
        return { success: false, error: 'No submit button found', submitted: false, uncertain: true };
      }

      // Sub-stage: wait for a REAL post-click signal, then settle deterministically.
      const respTimer = startTimer({ stage: STAGES.SUBMIT_RESPONSE_WAIT });
      const signal = await Promise.race(armedSignals);
      await this.page
        .waitForLoadState('networkidle', { timeout: POST_SIGNAL_SETTLE_MS })
        .catch(() => undefined);
      respTimer.end(true, signal);

      // Sub-stage: confirmation readiness + detection + confirmation ID extraction.
      const confTimer = startTimer({ stage: STAGES.BROWSER_CONFIRMATION });
      const confirmation = await this.checkConfirmation();
      const bodyLenAfter = await this.page.evaluate(() => document.body?.innerText?.length ?? 0);
      confTimer.end(confirmation.found);
      this.page.off('request', onRequest);
      this.page.off('response', onResponse);

      const urlAfter = this.page.url();
      const observability = {
        signal,
        clickToDetectionMs: Date.now() - clickedAt,
        urlChanged: urlAfter !== urlBefore,
        bodyTextChanged: bodyLenAfter !== bodyLenBefore,
        bodyLenBefore,
        bodyLenAfter,
        url: this.hostPathForLog(urlAfter),
        urlAfter: this.hostPathForLog(urlAfter),
        submissionRequests: submissionLog,
        confirmationFound: confirmation.found,
        confirmationIdPresent: !!confirmation.id,
      };
      if (confirmation.found) {
        logger.info('Post-submit verification — confirmation detected', observability);
      } else {
        logger.warn('Post-submit verification — no confirmation found', observability);
      }

      // Diagnostic capture ONLY on the failure path (never on success): the
      // post-submit page state is the evidence for an uncertain submission.
      if (!confirmation.found) {
        try {
          await this.takeScreenshot('submission-uncertain');
        } catch (shotError) {
          logger.warn('Post-submit diagnostic screenshot failed (non-fatal)', {
            error: shotError instanceof Error ? shotError.message : String(shotError),
          });
        }
      }

      return {
        success: true,
        submitted: true,
        uncertain: !confirmation.found,
        transport: submissionLog,
        confirmationId: confirmation.id,
        confirmationUrl: urlAfter,
      };
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      return { success: false, error: err, submitted: false, uncertain: true };
    }
  }

  private async checkConfirmation(): Promise<{ found: boolean; id?: string }> {
    if (!this.page) return { found: false };

    const confirmationPatterns = [
      /confirmation\s*(?:number|id|code)[:#\s]*([A-Z0-9\-]{6,})/i,
      /application\s*(?:submitted|received|confirmed)/i,
      /thank you for (?:applying|your application)/i,
      /your application has been (?:received|submitted)/i,
    ];

    const text = await this.page.textContent('body') || '';
    
    for (const pattern of confirmationPatterns) {
      const match = text.match(pattern);
      if (match) {
        return { found: true, id: match[1] };
      }
    }

    const url = this.page.url();
    if (url.includes('confirm') || url.includes('success') || url.includes('thank')) {
      return { found: true };
    }

    return { found: false };
  }

  /** Host of a URL ('' when unparseable) — scopes post-submit response signals. */
  private hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  }

  /** host+path for logs — query strings may carry tokens and are never logged. */
  private hostPathForLog(url: string): string {
    try {
      const u = new URL(url);
      return `${u.host}${u.pathname}`;
    } catch {
      return url.split('?')[0];
    }
  }

  async takeScreenshot(name: string): Promise<string> {
    if (!this.page || !this.session) throw new Error('No session or page');

    const screenshotDir = path.join(__dirname, '../../applications', this.session.applicationId, 'screenshots');
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    const fileName = `${name}_${Date.now()}.png`;
    const filePath = path.join(screenshotDir, fileName);

    await this.page.screenshot({ path: filePath, fullPage: true });
    this.session.screenshotPaths.push(filePath);

    return filePath;
  }

  async saveSessionState(): Promise<BrowserSessionStateSnapshot> {
    if (!this.page || !this.session) throw new Error('No session or page');

    // Phase 5G: decompose session_save (measured 15.4% of application.total).
    const snapTimer = startTimer({ stage: STAGES.SESSION_SNAPSHOT });
    const pwCookies = await this.context!.cookies();
    const cookies: BrowserCookie[] = pwCookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite?.toLowerCase() as 'strict' | 'lax' | 'none',
    }));

    const localStorageData = await this.page.evaluate(() => {
      const data: Record<string, string> = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (key) data[key] = window.localStorage.getItem(key) || '';
      }
      return data;
    });
    snapTimer.end(true);

    const shotTimer = startTimer({ stage: STAGES.SESSION_SCREENSHOT });
    const screenshotPath = await this.takeScreenshot('session_state');
    shotTimer.end(true);

    // capturePageState records its own browser.capturePageState stage.
    const pageState = await this.capturePageState();

    const writeTimer = startTimer({ stage: STAGES.SESSION_WRITE });
    const snapshot: BrowserSessionStateSnapshot = {
      sessionId: this.session.sessionId,
      applicationId: this.session.applicationId,
      url: this.page.url(),
      cookies,
      localStorage,
      screenshotPath,
      pageState,
      timestamp: new Date(),
    };

    const stateDir = path.join(__dirname, '../../applications', this.session.applicationId, 'browser-state');
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
    
    const stateFile = path.join(stateDir, `state_${Date.now()}.json`);
    await fs.promises.writeFile(stateFile, JSON.stringify(snapshot, null, 2));
    writeTimer.end(true);

    return snapshot;
  }

  async restoreSessionState(snapshot: BrowserSessionStateSnapshot): Promise<void> {
    if (!this.page || !this.context) throw new Error('Browser not initialized');

    // Restore cookies - convert back to Playwright format.
    // Optional: escalation pause snapshots carry a captured PageState (url/forms)
    // instead of a full browser session snapshot, so cookies may be absent.
    if (Array.isArray(snapshot.cookies)) {
      const pwCookies = snapshot.cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: (c.sameSite.charAt(0).toUpperCase() + c.sameSite.slice(1)) as 'Strict' | 'Lax' | 'None',
      }));
      if (pwCookies.length > 0) {
        await this.context.addCookies(pwCookies);
      }
    }

    // Restore localStorage (optional in escalation snapshots)
    if (snapshot.localStorage && typeof snapshot.localStorage === 'object') {
      await this.page.evaluate((data) => {
        for (const [key, value] of Object.entries(data)) {
          localStorage.setItem(key, value);
        }
      }, snapshot.localStorage);
    }

    // Navigate to URL
    if (snapshot.url) {
      await this.page.goto(snapshot.url, { waitUntil: 'domcontentloaded' });
      // Phase 5J measured: this networkidle wait was the bulk of resume.restore
      // (533ms). Deterministic readiness: race visible form controls against the
      // network-settle fallback (identical worst case as before) — form fields
      // are what the resumed fill actually needs. :visible filter required —
      // unfiltered first match is the hidden jobId input (Phase 4 root cause).
      await Promise.race([
        this.page.waitForSelector('input:visible, select:visible, textarea:visible', { timeout: 10000 }).catch(() => {}),
        this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {}),
      ]);
    }
  }

  async detectATS(): Promise<string | null> {
    if (!this.page) return null;

    const atsTimer = startTimer({ stage: STAGES.BROWSER_ATS_DETECT });
    const url = this.page.url();
    const html = await this.page.content();

    for (const signature of ATS_SIGNATURES) {
      if (signature.urlPatterns.some(p => url.includes(p))) {
        atsTimer.end(true);
        return signature.name;
      }
      if (signature.indicators.some(i => html.toLowerCase().includes(i.toLowerCase()))) {
        atsTimer.end(true);
        return signature.name;
      }
    }

    atsTimer.end(true);
    return null;
  }

  async waitForSelector(selector: string, timeout?: number): Promise<boolean> {
    if (!this.page) return false;
    
    try {
      await this.page.waitForSelector(selector, { timeout: timeout || this.config.defaultTimeout });
      return true;
    } catch {
      return false;
    }
  }

  async click(selector: string): Promise<BrowserActionResult> {
    if (!this.page) return { success: false, error: 'No page' };
    
    try {
      await this.page.click(selector);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async type(selector: string, text: string): Promise<BrowserActionResult> {
    if (!this.page) return { success: false, error: 'No page' };
    
    try {
      await this.page.type(selector, text);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
      this.browser = null;
      this.page = null;
    }
    if (this.obscuraProcess) {
      try { this.obscuraProcess.kill(); } catch {}
      this.obscuraProcess = null;
    }
    logger.info('Browser closed');
  }

  private updateSessionState(state: BrowserSession['state']): void {
    if (this.session) {
      this.session.state = state;
      this.session.updatedAt = new Date();
    }
  }

  getSession(): BrowserSession | null {
    return this.session;
  }

  getPage(): Page | null {
    return this.page;
  }
}
