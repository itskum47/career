/**
 * Phase 6K/6L — Login / CAPTCHA / MFA / bot-challenge detection + PAUSE protocol.
 *
 * Rules (never violated):
 *   - NEVER bypass CAPTCHA, MFA, bot challenges, anti-abuse checks, login
 *     walls, access restrictions, or private APIs.
 *   - NEVER request or store a password / OTP.
 *   - When a challenge is detected: PAUSE_FOR_USER, save the exact state
 *     (URL, screenshot, browser session state, job ID, source, application
 *     state), let the user complete the step manually in the visible
 *     browser, then resume the SAME browser session.
 *   - Only the affected session pauses; unrelated applications continue.
 *
 * Design: detection is a pure function over HTML + URL (fixtures testable in
 * 6U) with a thin browser wrapper that captures state.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../core/logger.ts';

export type ChallengeKind =
  | 'LOGIN_REQUIRED'   // credentials wall (6K)
  | 'CAPTCHA'          // human-verification widget (6L)
  | 'MFA'              // OTP / two-factor step (6L)
  | 'BOT_CHALLENGE'    // anti-bot interstitial / JS challenge (6L)
  | 'RATE_LIMIT';      // 429-style throttle (6M interaction)

export interface ChallengeDetection {
  detected: boolean;
  kind?: ChallengeKind;
  /** Human-readable evidence (selector / marker observed). Never secret data. */
  evidence: string;
  url: string;
}

/**
 * Detection markers. Kept as data (not scattered selectors) so tests can
 * assert coverage directly.
 */
export const CHALLENGE_MARKERS: Record<ChallengeKind, RegExp[]> = {
  CAPTCHA: [
    // A widget/challenge must be PRESENT: rendered widget iframe, widget
    // container class, or challenge copy. A plain
    // <script src="...recaptcha..."> library include is DELIBERATELY NOT a
    // marker — measured false positive: every clean Greenhouse form page
    // ships recaptcha/enterprise.js (invisible) while rendering no challenge
    // (screenshot-verified 2026-10-07, APP-20261007-000093; real page fixture
    // in tests/fixtures/greenhouse-clean-page.html). We never bypass an
    // actual challenge — widget/overlay/text markers above still fire.
    // Passive reCAPTCHA badge EXEMPTION (measured 2026-10-08, APP-20261008-000098):
    // Greenhouse renders <div class="grecaptcha-badge"><div class="grecaptcha-logo">
    // <iframe title="reCAPTCHA" src="recaptcha.net/..."> at page load — the passive
    // "protected by reCAPTCHA" logo for an INVISIBLE widget. It is not interactive;
    // there is nothing a human can solve before submit. Real widgets/challenges
    // (api2/anchor checkbox, api2/bframe dialog, .g-recaptcha container) render
    // OUTSIDE those wrappers and still fire below — the badge exemption applies
    // only to matches whose nearest preceding markup is the badge/logo.
    /<iframe[^>]+src="[^"]*recaptcha/i,
    /<iframe[^>]+src="[^"]*hcaptcha/i,
    // Class terminator required: the passive response textarea
    // class="g-recaptcha-response" (present on every clean page with the
    // widget) must NOT match — only a real class="g-recaptcha" container.
    /class="[^\"]*\bg-recaptcha[\s"]/i,
    /class="[^"]*h-captcha[\s"]/i,
    /data-hcaptcha-widget-id/i,
    /class="[^"]*cf-turnstile/i,
    /id="challenge-form"[^>]*>[\s\S]{0,400}captcha/i,
    /verify you are human/i,
    /are you a robot/i,
    /i.?m not a robot/i,
    /unusual traffic from your (?:computer|network|ip)/i,
  ],
  MFA: [
    /autocomplete="one-time-code"/i,
    /autocomplete="otp"/i,
    /name="(otp|totp|mfa[_-]?code|verification[_-]?code)"/i,
    /two[- ]factor (?:authentication|verification)/i,
    /\b2fa\b/i,
    /enter the (?:code|verification code) we sent/i,
    /authenticator app/i,
    /security code/i,
  ],
  LOGIN_REQUIRED: [
    /type="password"/i,
    /name="password"/i,
    /id="password"/i,
    /sign in to (?:view|apply|continue|submit)/i,
    /log in to (?:view|apply|continue|submit)/i,
    /please (?:sign|log) in/i,
    /login (?:is )?required/i,
    /members? only/i,
    /session expired.*sign in/i,
  ],
  BOT_CHALLENGE: [
    /cf-browser-verification/i,
    /id="cf-chl-/i,
    /checking (?:if )?your browser/i,
    /just a moment\.\.\./i,
    /enable javascript and cookies to continue/i,
    /ddos protection by (?:cloudflare|guardian)/i,
    /captcha-delivery\.com/i,
    /_cf_chl_opt/i,
  ],
  RATE_LIMIT: [
    /too many requests/i,
    /rate limit (?:exceeded|reached)/i,
    /try again later.*request/i,
    /429[^0-9]/,
  ],
};

/** URL patterns that imply a login wall regardless of body content. */
const LOGIN_URL_PATTERN =
  /\/(?:login|log-in|signin|sign-in|sign_in|auth|authenticate|sso|account\/login)(?:[/?]|$)/i;

const CAPTCHA_URL_PATTERN =
  /\/(?:captcha|challenge|verify|check)(?:[/?]|$)/i;

/**
 * Pure detection: classify a page from its HTML + URL.
 * Order of precedence: BOT_CHALLENGE > CAPTCHA > MFA > LOGIN_REQUIRED > RATE_LIMIT.
 * (An interstitial must be classified as what it is before weaker markers.)
 */
export function detectChallengeFromHtml(html: string, url: string): ChallengeDetection {
  // Body text without scripts/styles for text-marker matching, but keep the
  // full HTML for widget/iframe/script markers (they live in markup).
  const body = html.slice(0, 400_000);

  const ordered: ChallengeKind[] = ['BOT_CHALLENGE', 'CAPTCHA', 'MFA', 'LOGIN_REQUIRED', 'RATE_LIMIT'];
  for (const kind of ordered) {
    for (const marker of CHALLENGE_MARKERS[kind]) {
      const m = body.match(marker);
      if (m) {
        // CAPTCHA iframe markers: the first match may be the PASSIVE
        // reCAPTCHA badge — scan forward for the first ACTIVE match.
        let effective = m;
        if (kind === 'CAPTCHA' && /^<iframe/i.test(m[0])) {
          const re = new RegExp(marker.source, marker.flags.includes('g') ? marker.flags : `${marker.flags}g`);
          let found: RegExpExecArray | null = null;
          let scan: RegExpExecArray | null;
          while ((scan = re.exec(body))) {
            if (!isPassiveRecaptchaBadge(body, scan.index)) { found = scan; break; }
          }
          if (!found) continue; // only the passive badge is present
          effective = found;
        }
        // LOGIN marker needs structural reinforcement on non-login URLs:
        // a password field on an application form with many other fields is a
        // normal "create account" step, not a wall. Require either a login URL
        // or a password field WITHOUT other input fields nearby (wall-style).
        if (kind === 'LOGIN_REQUIRED') {
          const looksLikeWall =
            LOGIN_URL_PATTERN.test(url) ||
            /type="password"/i.test(m[0]) && countInputsWithoutPassword(body) <= 3 ||
            /sign in to|log in to|please (?:sign|log) in|login (?:is )?required|members? only/i.test(m[0]);
          if (!looksLikeWall) continue;
        }
        return {
          detected: true,
          kind,
          evidence: describeMarker(kind, effective[0]),
          url,
        };
      }
    }
  }

  if (LOGIN_URL_PATTERN.test(url)) {
    return { detected: true, kind: 'LOGIN_REQUIRED', evidence: `login URL pattern: ${safeHostPath(url)}`, url };
  }
  if (CAPTCHA_URL_PATTERN.test(url) && /captcha|challenge|verify/i.test(html)) {
    return { detected: true, kind: 'CAPTCHA', evidence: `challenge URL pattern: ${safeHostPath(url)}`, url };
  }

  return { detected: false, evidence: '', url };
}

function countInputsWithoutPassword(html: string): number {
  const inputs = html.match(/<input\b[^>]*>/gi) ?? [];
  return inputs.filter(i => !/type="password"/i.test(i)).length;
}

/**
 * True when the recaptcha iframe at `index` sits inside the PASSIVE badge
 * markup: <div class="grecaptcha-badge"><div class="grecaptcha-logo"><iframe>.
 * Measured on the live Greenhouse application form 2026-10-08
 * (APP-20261008-000098): badge/logo wrappers immediately wrap the iframe.
 * Active widgets (api2/anchor checkbox, api2/bframe challenge dialog) render
 * outside those wrappers — if any element tag intervenes between the last
 * badge/logo opening tag and the iframe, this is NOT the passive badge.
 */
function isPassiveRecaptchaBadge(html: string, index: number): boolean {
  const before = html.slice(Math.max(0, index - 800), index);
  const last = Math.max(before.lastIndexOf('grecaptcha-badge'), before.lastIndexOf('grecaptcha-logo'));
  if (last === -1) return false;
  const afterClass = before.slice(last);
  const tagClose = afterClass.indexOf('>');
  if (tagClose === -1) return false;
  // Only attribute styling between the wrapper's opening tag and the iframe
  // means the iframe is the wrapper's immediate child = passive badge.
  return !afterClass.slice(tagClose + 1).includes('<');
}

function describeMarker(kind: ChallengeKind, matched: string): string {
  const clean = matched.replace(/\s+/g, ' ').trim();
  return `${kind} marker: ${clean.length > 140 ? clean.slice(0, 140) + '…' : clean}`;
}

/** Never leak query strings (may contain tokens) into saved state. */
function safeHostPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url.split('?')[0];
  }
}

// ---------------------------------------------------------------------------
// Pause state persistence (6K/6L)
// ---------------------------------------------------------------------------

export interface ChallengePauseState {
  applicationId: string;
  jobId: string;
  source: string;
  applicationState: string;
  kind: ChallengeKind;
  /** URL with query stripped (tokens never persisted). */
  url: string;
  evidence: string;
  screenshotPath?: string;
  /** Browser session snapshot (Playwright context storage — not credentials). */
  sessionSnapshotPath?: string;
  escalationId?: string;
  savedAt: string;
  /** Where the user should complete the step (only ever the visible browser). */
  instructions: string;
  resumedAt?: string;
  resumeOutcome?: string;
}

export function challengePauseDir(): string {
  return path.join(process.cwd(), 'data', 'challenge-pauses');
}

export function saveChallengePause(state: ChallengePauseState): string {
  const dir = challengePauseDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${state.applicationId}.json`);
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
  logger.warn('Challenge pause state saved — waiting for user (no bypass)', {
    applicationId: state.applicationId,
    kind: state.kind,
    jobId: state.jobId,
    source: state.source,
    url: state.url,
    file,
  });
  return file;
}

export function loadChallengePause(applicationId: string): ChallengePauseState | null {
  const file = path.join(challengePauseDir(), `${applicationId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ChallengePauseState;
  } catch {
    return null;
  }
}

export function markChallengePauseResolved(applicationId: string, outcome: string): void {
  const state = loadChallengePause(applicationId);
  if (!state) return;
  state.resumedAt = new Date().toISOString();
  state.resumeOutcome = outcome;
  const file = path.join(challengePauseDir(), `${applicationId}.json`);
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
}

export const CHALLENGE_INSTRUCTIONS: Record<ChallengeKind, string> = {
  LOGIN_REQUIRED:
    'The application needs your account. Complete the sign-in manually in the visible browser window, then confirm — the SAME browser session resumes. The agent never asks for or stores your password.',
  CAPTCHA:
    'Solve the human-verification widget manually in the visible browser window, then confirm — the SAME browser session resumes. The agent never solves or bypasses CAPTCHAs.',
  MFA:
    'Enter your one-time code / approve the prompt manually in the visible browser window, then confirm — the SAME browser session resumes. The agent never handles OTPs or MFA devices.',
  BOT_CHALLENGE:
    'The site is running a browser verification. Let it complete in the visible browser window (or complete it manually), then confirm — the SAME session resumes. The agent never bypasses anti-bot checks.',
  RATE_LIMIT:
    'The source throttled the session. Wait for the cooldown, then confirm to resume the SAME session. No requests are sent during cooldown.',
};
