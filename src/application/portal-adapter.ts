/**
 * Phase 6Q — PortalApplicationAdapter interface + strategy chain.
 *
 * Common contract every portal/ATS site adapter implements. Strategy order
 * (strict):
 *   1. site-specific adapter   (per-portal selectors/flow)
 *   2. ATS-specific adapter    (Greenhouse/Lever/Ashby/Workable patterns)
 *   3. semantic fallback       (label/role/meaning-based generic flow)
 *   4. human escalation        (PAUSE_FOR_USER — never guess through a wall)
 *
 * These adapters supply SITE-SPECIFIC INTERACTION BEHAVIOR ONLY. They do NOT
 * own navigation, state machines, uploads, or submission — the existing
 * optimized ApplicationEngine does (6P: one engine, no second engine).
 */

import type { Page } from 'playwright';
import { logger } from '../core/logger.ts';
import type { ChallengeKind } from './challenge-guard.ts';

export interface PortalAdapterContext {
  page: Page | null;
  applicationId: string;
  jobId: string;
  /** Discovery source of the job (registry id). */
  source: string;
  /** Application URL chosen by ApplicationRouteResolver (6G). */
  applicationUrl: string;
  /** ATS detected behind the URL, if any. */
  ats?: string;
}

export interface PortalFormAnalysis {
  fieldCount: number;
  fileInputs: number;
  submitButtons: number;
  /** Login/CAPTCHA/MFA wall observed while analyzing (6K/6L). */
  challenge?: ChallengeKind;
}

export interface PortalFormFillResult {
  success: boolean;
  filledFields: number;
  adapter: string;
  /** Fields this adapter deliberately skipped (site-specific rules). */
  skipped?: string[];
}

export interface PortalSubmissionDetection {
  submitted: boolean;
  adapter: string;
  detail: string;
}

export interface PortalConfirmation {
  found: boolean;
  confirmationId?: string;
  adapter: string;
  detail: string;
}

export interface PortalSessionSnapshot {
  adapter: string;
  savedAt: string;
  /** Opaque adapter payload; the engine owns actual browser state persistence. */
  payload?: Record<string, unknown>;
}

export interface PortalApplicationAdapter {
  readonly id: string;
  readonly displayName: string;
  /** Strategy tier: site-specific runs before ATS-specific runs before semantic. */
  readonly tier: 'site' | 'ats' | 'semantic' | 'human';
  /** 6Q `detect` — can this adapter handle the given context? */
  canHandle(ctx: PortalAdapterContext): boolean;
  /** 6Q `loginRequired` — does the application flow need a user session? */
  loginRequired(ctx: PortalAdapterContext): boolean;
  /** 6Q `openApplication` — final URL to open (site-specific normalization). */
  openApplication(ctx: PortalAdapterContext): string;
  /** 6Q `analyzeForm` — site-aware form survey (may report challenges). */
  analyzeForm(ctx: PortalAdapterContext): Promise<PortalFormAnalysis>;
  /** 6Q `fillFields` — site-specific fill rules on top of generic filling. */
  fillFields(ctx: PortalAdapterContext, values: Record<string, string>): Promise<PortalFormFillResult>;
  /** 6Q `handleUploads` — site-specific upload behavior (file chooser, etc). */
  handleUploads(ctx: PortalAdapterContext, files: Array<{ fieldName: string; path: string }>): Promise<{ success: boolean; adapter: string; detail: string }>;
  /** 6Q `handleQuestions` — site-specific handling of free-text questions. */
  handleQuestions(ctx: PortalAdapterContext, questions: Array<{ id: string; label: string }>): Promise<{ answered: number; adapter: string }>;
  /** 6Q `detectSubmission` — did the site actually accept the submission? */
  detectSubmission(ctx: PortalAdapterContext): Promise<PortalSubmissionDetection>;
  /** 6Q `extractConfirmation` — confirmation/reference code if shown. */
  extractConfirmation(ctx: PortalAdapterContext): Promise<PortalConfirmation>;
  /** 6Q `saveSession` / `restoreSession` — adapter-level state (engine keeps browser state). */
  saveSession(ctx: PortalAdapterContext): Promise<PortalSessionSnapshot>;
  restoreSession(ctx: PortalAdapterContext, snapshot: PortalSessionSnapshot): Promise<void>;
  /** 6Q `escalationRequired` — true when a human must take over (never guess). */
  escalationRequired(ctx: PortalAdapterContext): boolean;
}

// ---------------------------------------------------------------------------
// Semantic fallback — default behavior (delegates to the existing engine
// flow; the adapter only reports generic facts).
// ---------------------------------------------------------------------------

export class SemanticFallbackAdapter implements PortalApplicationAdapter {
  readonly id = 'semantic-fallback';
  readonly displayName = 'Semantic fallback (generic label/role based)';
  readonly tier = 'semantic' as const;

  canHandle(_ctx?: PortalAdapterContext): boolean { return true; }
  loginRequired(_ctx?: PortalAdapterContext): boolean { return false; }
  openApplication(ctx: PortalAdapterContext): string { return ctx.applicationUrl; }

  async analyzeForm(ctx: PortalAdapterContext): Promise<PortalFormAnalysis> {
    if (!ctx.page) return { fieldCount: 0, fileInputs: 0, submitButtons: 0 };
    try {
      const fieldCount = await ctx.page.locator('input:not([type=hidden]):not([type=submit]), textarea, select').count();
      const fileInputs = await ctx.page.locator('input[type=file]').count();
      const submitButtons = await ctx.page.locator('button[type=submit], input[type=submit]').count();
      return { fieldCount, fileInputs, submitButtons };
    } catch {
      return { fieldCount: 0, fileInputs: 0, submitButtons: 0 };
    }
  }

  async fillFields(_ctx: PortalAdapterContext, _values: Record<string, string>): Promise<PortalFormFillResult> {
    // Generic filling is performed by BrowserController.fillForm inside the
    // engine — this adapter signals "no site-specific rules applied".
    return { success: true, filledFields: 0, adapter: this.id };
  }

  async handleUploads(_ctx: PortalAdapterContext, _files: Array<{ fieldName: string; path: string }>): Promise<{ success: boolean; adapter: string; detail: string }> {
    return { success: true, adapter: this.id, detail: 'generic upload path (engine)' };
  }

  async handleQuestions(_ctx: PortalAdapterContext, _questions: Array<{ id: string; label: string }>): Promise<{ answered: number; adapter: string }> {
    return { answered: 0, adapter: this.id };
  }

  async detectSubmission(_ctx: PortalAdapterContext): Promise<PortalSubmissionDetection> {
    return { submitted: false, adapter: this.id, detail: 'engine submission result governs' };
  }

  async extractConfirmation(_ctx: PortalAdapterContext): Promise<PortalConfirmation> {
    return { found: false, adapter: this.id, detail: 'engine confirmation check governs' };
  }

  async saveSession(ctx: PortalAdapterContext): Promise<PortalSessionSnapshot> {
    return { adapter: this.id, savedAt: new Date().toISOString(), payload: { applicationId: ctx.applicationId } };
  }

  async restoreSession(_ctx: PortalAdapterContext, _snapshot: PortalSessionSnapshot): Promise<void> { /* engine restores browser state */ }

  escalationRequired(): boolean { return false; }
}

// ---------------------------------------------------------------------------
// Human escalation — last resort when nothing else can handle the context.
// ---------------------------------------------------------------------------

export class HumanEscalationAdapter implements PortalApplicationAdapter {
  readonly id = 'human-escalation';
  readonly displayName = 'Human escalation (PAUSE_FOR_USER)';
  readonly tier = 'human' as const;

  canHandle(): boolean { return true; }
  loginRequired(): boolean { return true; }
  openApplication(ctx: PortalAdapterContext): string { return ctx.applicationUrl; }

  async analyzeForm(): Promise<PortalFormAnalysis> {
    return { fieldCount: 0, fileInputs: 0, submitButtons: 0 };
  }
  async fillFields(_ctx: PortalAdapterContext, _values: Record<string, string>): Promise<PortalFormFillResult> {
    return { success: false, filledFields: 0, adapter: this.id, skipped: ['all'] };
  }
  async handleUploads(_ctx: PortalAdapterContext, _files: Array<{ fieldName: string; path: string }>): Promise<{ success: boolean; adapter: string; detail: string }> {
    return { success: false, adapter: this.id, detail: 'human takeover required' };
  }
  async handleQuestions(_ctx: PortalAdapterContext, _questions: Array<{ id: string; label: string }>): Promise<{ answered: number; adapter: string }> {
    return { answered: 0, adapter: this.id };
  }
  async detectSubmission(_ctx: PortalAdapterContext): Promise<PortalSubmissionDetection> {
    return { submitted: false, adapter: this.id, detail: 'human takeover required' };
  }
  async extractConfirmation(_ctx: PortalAdapterContext): Promise<PortalConfirmation> {
    return { found: false, adapter: this.id, detail: 'human takeover required' };
  }
  async saveSession(ctx: PortalAdapterContext): Promise<PortalSessionSnapshot> {
    return { adapter: this.id, savedAt: new Date().toISOString(), payload: { applicationId: ctx.applicationId } };
  }
  async restoreSession(_ctx: PortalAdapterContext, _snapshot: PortalSessionSnapshot): Promise<void> { /* engine restores browser state */ }
  escalationRequired(): boolean { return true; }
}

// ---------------------------------------------------------------------------
// Site-specific adapters (tier 1) — only for sources whose public flow has
// been measured. Selector sets are data, not hardcoded engine branches.
// ---------------------------------------------------------------------------

interface SiteRules {
  /** CSS for the primary apply button on the portal's own apply flow. */
  applyButton?: string;
  /** CSS for the confirmation reference shown after submit. */
  confirmation?: string;
  /** True when the portal requires its own account to apply. */
  requiresAccount: boolean;
  /** URL normalization (portal apply URL -> employer/ATS target if listed). */
  normalizeUrl?: (url: string) => string;
}

const SITE_RULES: Record<string, SiteRules> = {
  // Shine: server-rendered listings link to employer/ATS pages for apply.
  shine: {
    requiresAccount: false,
    applyButton: 'a[href*="/apply"], button:has-text("Apply"), a:has-text("Apply now")',
    confirmation: '[class*="success"], [class*="applied"]',
    normalizeUrl: (url) => url,
  },
  // Apna: applying requires an Apna account (6K — pause for user, no bypass).
  apna: {
    requiresAccount: true,
    applyButton: 'button:has-text("Apply"), a[href*="apply"]',
    normalizeUrl: (url) => url,
  },
  freshersworld: {
    requiresAccount: true,
    applyButton: 'a:has-text("Apply"), button:has-text("Apply")',
  },
  linkedin: {
    requiresAccount: true,
    applyButton: 'button.jobs-apply-button, button:has-text("Easy Apply")',
    confirmation: '[data-test="easy-apply-submitted"], .artdeco-inline-feedback--success',
  },
};

export class SiteSpecificAdapter implements PortalApplicationAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly tier: PortalApplicationAdapter['tier'] = 'site';
  private rules: SiteRules;

  constructor(sourceId: string, rules: SiteRules) {
    this.id = `site:${sourceId}`;
    this.displayName = `Site-specific: ${sourceId}`;
    this.rules = rules;
  }

  canHandle(ctx: PortalAdapterContext): boolean {
    return ctx.source in SITE_RULES || ctx.applicationUrl.includes(this.id.replace('site:', ''));
  }

  loginRequired(): boolean { return this.rules.requiresAccount; }

  openApplication(ctx: PortalAdapterContext): string {
    return this.rules.normalizeUrl ? this.rules.normalizeUrl(ctx.applicationUrl) : ctx.applicationUrl;
  }

  async analyzeForm(ctx: PortalAdapterContext): Promise<PortalFormAnalysis> {
    if (!ctx.page) return { fieldCount: 0, fileInputs: 0, submitButtons: 0 };
    try {
      const fieldCount = await ctx.page.locator('input:not([type=hidden]):not([type=submit]), textarea, select').count();
      const fileInputs = await ctx.page.locator('input[type=file]').count();
      const submitButtons = this.rules.applyButton
        ? await ctx.page.locator(this.rules.applyButton).count()
        : await ctx.page.locator('button[type=submit], input[type=submit]').count();
      return { fieldCount, fileInputs, submitButtons };
    } catch {
      return { fieldCount: 0, fileInputs: 0, submitButtons: 0 };
    }
  }

  async fillFields(_ctx: PortalAdapterContext, _values: Record<string, string>): Promise<PortalFormFillResult> {
    // Site adapters never replace the engine's generic fill — they only add
    // skip/prefer rules. No site-specific rules measured yet => no-ops.
    return { success: true, filledFields: 0, adapter: this.id };
  }

  async handleUploads(_ctx: PortalAdapterContext, _files: Array<{ fieldName: string; path: string }>): Promise<{ success: boolean; adapter: string; detail: string }> {
    return { success: true, adapter: this.id, detail: 'generic upload path (engine)' };
  }

  async handleQuestions(_ctx: PortalAdapterContext, _questions: Array<{ id: string; label: string }>): Promise<{ answered: number; adapter: string }> {
    return { answered: 0, adapter: this.id };
  }

  async detectSubmission(_ctx: PortalAdapterContext): Promise<PortalSubmissionDetection> {
    return { submitted: false, adapter: this.id, detail: 'engine submission result governs' };
  }

  async extractConfirmation(ctx: PortalAdapterContext): Promise<PortalConfirmation> {
    if (!this.rules.confirmation || !ctx.page) {
      return { found: false, adapter: this.id, detail: 'no site confirmation selector' };
    }
    try {
      const el = ctx.page.locator(this.rules.confirmation).first();
      if (await el.count() > 0) {
        const text = ((await el.textContent()) || '').trim().slice(0, 120);
        const ref = text.match(/(?:ref|reference|confirmation|id)[:#\\s]*([A-Z0-9-]{6,})/i)?.[1];
        return { found: true, confirmationId: ref, adapter: this.id, detail: text };
      }
    } catch { /* fall through */ }
    return { found: false, adapter: this.id, detail: 'selector absent' };
  }

  async saveSession(ctx: PortalAdapterContext): Promise<PortalSessionSnapshot> {
    return { adapter: this.id, savedAt: new Date().toISOString(), payload: { applicationId: ctx.applicationId } };
  }
  async restoreSession(_ctx: PortalAdapterContext, _snapshot: PortalSessionSnapshot): Promise<void> { /* engine restores browser state */ }

  escalationRequired(): boolean { return false; }
}

// ---------------------------------------------------------------------------
// ATS-specific adapters (tier 2) — pattern-driven per ATS family.
// ---------------------------------------------------------------------------

const ATS_RULES: Record<string, SiteRules> = {
  greenhouse: {
    requiresAccount: false,
    applyButton: 'button[type=submit], button:has-text("Submit application")',
    confirmation: '[class*="success"], [class*="confirmation"]',
  },
  lever: {
    requiresAccount: false,
    applyButton: 'button[data-qa="btn-submit"], button[type=submit]',
  },
  ashby: {
    requiresAccount: false,
    applyButton: 'button[type=submit], button:has-text("Submit")',
  },
  workday: { requiresAccount: false, applyButton: 'button[data-automation-id="bottom-navigation-next-button"], button[type=submit]' },
  workable: { requiresAccount: false, applyButton: 'button[type=submit]' },
  smartrecruiters: { requiresAccount: false, applyButton: 'button[type=submit], button:has-text("Apply")' },
};

export class AtsApplicationAdapter extends SiteSpecificAdapter {
  override readonly tier: PortalApplicationAdapter['tier'] = 'ats';

  constructor(atsId: string, rules: SiteRules) {
    super(`ats:${atsId}`, rules);
  }

  override canHandle(ctx: PortalAdapterContext): boolean {
    return !!ctx.ats && this.displayName.toLowerCase().includes(ctx.ats.toLowerCase());
  }
}

// ---------------------------------------------------------------------------
// Router — strategy order: site-specific -> ATS-specific -> semantic -> human.
// ---------------------------------------------------------------------------

export class PortalApplicationRouter {
  private semantic = new SemanticFallbackAdapter();
  private human = new HumanEscalationAdapter();

  private siteAdapters = Object.entries(SITE_RULES)
    .map(([id, rules]) => [id, new SiteSpecificAdapter(id, rules)] as const);
  private atsAdapters = Object.entries(ATS_RULES)
    .map(([id, rules]) => [id, new AtsApplicationAdapter(id, rules)] as const);

  /** Registered custom adapters (later-discovered legitimate portals). */
  private custom: PortalApplicationAdapter[] = [];

  register(adapter: PortalApplicationAdapter): void {
    this.custom.push(adapter);
    logger.info('Portal adapter registered', { id: adapter.id, tier: adapter.tier });
  }

  /** Strict strategy order (6Q). Never returns null — human is the floor. */
  detect(ctx: PortalAdapterContext): PortalApplicationAdapter {
    // Custom adapters first (explicit registration beats heuristic).
    for (const a of this.custom) {
      if (a.tier !== 'human' && a.canHandle(ctx)) return a;
    }
    // 1. site-specific
    for (const [id, adapter] of this.siteAdapters) {
      if (ctx.source === id && adapter.canHandle(ctx)) return adapter;
    }
    // 2. ATS-specific
    if (ctx.ats) {
      for (const [id, adapter] of this.atsAdapters) {
        if (id === ctx.ats && adapter.canHandle(ctx)) return adapter;
      }
      // Generic ATS tier: any detected ATS gets an ATS-tier adapter keyed by
      // the ATS id (ruleset when known, semantic behavior otherwise).
      const known = ATS_RULES[ctx.ats];
      if (known) return new AtsApplicationAdapter(ctx.ats, known);
    }
    // 3. semantic fallback
    if (this.semantic.canHandle(ctx)) return this.semantic;
    // 4. human escalation (unreachable today: semantic always handles)
    return this.human;
  }

  /** 6Q `escalationRequired` convenience for the engine pre-submit hook. */
  escalationRequired(ctx: PortalAdapterContext): boolean {
    return this.detect(ctx).escalationRequired(ctx);
  }
}

export const portalApplicationRouter = new PortalApplicationRouter();
