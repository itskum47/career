/**
 * Phase 6U — Login / CAPTCHA / MFA / bot-challenge detection + pause state (6K/6L).
 *
 * Fixtures only. The agent NEVER bypasses these walls; it detects, saves
 * state, and pauses for the user.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import {
  detectChallengeFromHtml,
  saveChallengePause,
  loadChallengePause,
  markChallengePauseResolved,
  challengePauseDir,
  CHALLENGE_INSTRUCTIONS,
  CHALLENGE_MARKERS,
} from '../../../src/application/challenge-guard.ts';
import type { ChallengePauseState } from '../../../src/application/challenge-guard.ts';

describe('6L — challenge detection from page fixtures', () => {
  it('detects reCAPTCHA as CAPTCHA', () => {
    const r = detectChallengeFromHtml(
      '<html><body><form>Apply<input name="q"><iframe src="https://www.google.com/recaptcha/api.js"></iframe></form></body></html>',
      'https://jobs.example.com/apply',
    );
    expect(r.detected).toBe(true);
    expect(r.kind).toBe('CAPTCHA');
    expect(r.evidence).toContain('CAPTCHA');
  });

  it('detects hCaptcha and Cloudflare Turnstile', () => {
    expect(detectChallengeFromHtml('<div class="h-captcha" data-sitekey="x"></div>', 'https://x.test/a').kind).toBe('CAPTCHA');
    expect(detectChallengeFromHtml('<div class="cf-turnstile" data-sitekey="x"></div>', 'https://x.test/a').kind).toBe('CAPTCHA');
  });

  it('detects a login wall (password field on a login URL)', () => {
    const r = detectChallengeFromHtml(
      '<html><body><form><input type="email" name="u"><input type="password" name="p"><button>Sign in</button></form></body></html>',
      'https://portal.example.com/login',
    );
    expect(r.detected).toBe(true);
    expect(r.kind).toBe('LOGIN_REQUIRED');
  });

  it('detects login-wall copy on any URL ("sign in to apply")', () => {
    const r = detectChallengeFromHtml(
      '<html><body><p>Sign in to apply to this job</p></body></html>',
      'https://jobs.example.com/view/1',
    );
    expect(r.kind).toBe('LOGIN_REQUIRED');
  });

  it('detects MFA / OTP steps', () => {
    const r = detectChallengeFromHtml(
      '<html><body><h1>Two-factor authentication</h1><input autocomplete="one-time-code" name="code"></body></html>',
      'https://portal.example.com/verify',
    );
    expect(r.kind).toBe('MFA');
    expect(CHALLENGE_MARKERS.MFA.some(m => m.test('<input autocomplete="one-time-code">'))).toBe(true);
  });

  it('detects anti-bot interstitials as BOT_CHALLENGE', () => {
    const r = detectChallengeFromHtml(
      '<html><body><h1>Just a moment...</h1><script>var _cf_chl_opt={}</script></body></html>',
      'https://jobs.example.com/apply',
    );
    expect(r.kind).toBe('BOT_CHALLENGE');
  });

  it('BOT_CHALLENGE wins over CAPTCHA when both markers are present (precedence)', () => {
    const r = detectChallengeFromHtml(
      '<html><body>Just a moment...<iframe src="https://www.google.com/recaptcha/api.js"></iframe></body></html>',
      'https://jobs.example.com/apply',
    );
    expect(r.kind).toBe('BOT_CHALLENGE');
  });

  it('detects rate limiting', () => {
    const r = detectChallengeFromHtml(
      '<html><body><h1>429 Too Many Requests</h1><p>Rate limit exceeded, try again later.</p></body></html>',
      'https://jobs.example.com/api',
    );
    expect(r.kind).toBe('RATE_LIMIT');
  });

  it('does NOT flag a normal application form as a wall', () => {
    const r = detectChallengeFromHtml(
      `<html><body><form>
        <label>Full name<input name="fullName" type="text"></label>
        <label>Email<input name="email" type="email"></label>
        <label>Phone<input name="phone" type="tel"></label>
        <label>LinkedIn<input name="linkedin" type="url"></label>
        <label>Why do you want this role?<textarea name="why"></textarea></label>
        <label>Resume<input type="file" name="resume"></label>
        <button type="submit">Submit application</button>
      </form></body></html>`,
      'https://jobs.example.com/view/123/apply',
    );
    expect(r.detected).toBe(false);
  });

  it('does NOT flag a REAL clean Greenhouse application page (measured fixture, 2026-10-07)', () => {
    // Every clean Greenhouse form page ships recaptcha/enterprise.js
    // (invisible) while rendering no challenge. Screenshot-verified
    // APP-20261007-000093: the <script src=...recaptcha> marker was a false
    // positive that paused a clean page. Widget/overlay/text markers remain.
    const html = fs.readFileSync('tests/fixtures/greenhouse-clean-page.html', 'utf8');
    const r = detectChallengeFromHtml(html, 'https://job-boards.greenhouse.io/gitlab/jobs/8730125002');
    expect(r.detected).toBe(false);
    // The page genuinely includes the invisible reCAPTCHA library — proving
    // the library include itself is not treated as a challenge.
    expect(html).toMatch(/recaptcha/);
  });

  it('does NOT flag the PASSIVE reCAPTCHA badge or its response textarea (measured live, 2026-10-08)', () => {
    // Live-measured markup (APP-20261008-000098): the invisible widget's
    // badge renders at load — nothing for a human to solve — yet its iframe
    // fired the CAPTCHA marker and paused a clean run before submit.
    const badge =
      '<div class="grecaptcha-badge" style="visibility: hidden;"><div class="grecaptcha-logo" style="width: 256px; height: 60px;">' +
      '<iframe title="reCAPTCHA" width="256" height="60" src="https://www.recaptcha.net/recaptcha/api2/anchor?k=abc"></iframe>' +
      '</div><div class="grecaptcha-error"></div></div>' +
      '<textarea id="g-recaptcha-response-100000" class="g-recaptcha-response" style="display: none;"></textarea>';
    const r = detectChallengeFromHtml(`<html><body><form>Apply<input name="q">${badge}</form></body></html>`, 'https://jobs.example.com/apply');
    expect(r.detected).toBe(false);
  });

  it('still detects a REAL widget rendered outside the badge wrappers', () => {
    // v2 checkbox container — interactive, a human can (and must) solve it.
    const widget =
      '<div class="g-recaptcha" data-sitekey="x" data-callback="cb">' +
      '<iframe title="reCAPTCHA" width="304" height="78" src="https://www.google.com/recaptcha/api2/anchor?k=abc"></iframe></div>';
    expect(detectChallengeFromHtml(`<html><body>${widget}</body></html>`, 'https://jobs.example.com/apply').kind).toBe('CAPTCHA');
    // Challenge dialog (api2/bframe) appearing LATER than the badge must be
    // found — detection scans forward past the passive badge.
    const withBadgeAndChallenge =
      '<div class="grecaptcha-badge"><div class="grecaptcha-logo"><iframe title="reCAPTCHA" src="https://www.recaptcha.net/recaptcha/api2/anchor?k=b"></iframe></div></div>' +
      '<div style="position:absolute;"><iframe title="reCAPTCHA" src="https://www.recaptcha.net/recaptcha/api2/bframe?k=b"></iframe></div>';
    expect(detectChallengeFromHtml(`<html><body>${withBadgeAndChallenge}</body></html>`, 'https://jobs.example.com/apply').kind).toBe('CAPTCHA');
  });

  it('does NOT flag a signup-style form with a password among many fields on a job page', () => {
    const r = detectChallengeFromHtml(
      `<html><body><form>
        <input name="fullName"><input name="email"><input name="phone">
        <input name="city"><input name="notice"><input name="ctc">
        <input name="password" type="password"><input name="confirm" type="password">
      </form></body></html>`,
      'https://jobs.example.com/view/123/apply',
    );
    expect(r.detected).toBe(false);
  });

  it('never claims it will bypass: instructions are user-completion only', () => {
    const all = ['LOGIN_REQUIRED', 'CAPTCHA', 'MFA', 'BOT_CHALLENGE', 'RATE_LIMIT'] as const;
    // All kinds resume the SAME session after the user acts.
    for (const kind of all) {
      expect(CHALLENGE_INSTRUCTIONS[kind].toLowerCase()).toContain('same');
    }
    expect(CHALLENGE_INSTRUCTIONS.LOGIN_REQUIRED.toLowerCase()).toContain('manual');
    expect(CHALLENGE_INSTRUCTIONS.LOGIN_REQUIRED).toMatch(/never asks for or stores your password/i);
    expect(CHALLENGE_INSTRUCTIONS.CAPTCHA.toLowerCase()).toContain('manual');
    expect(CHALLENGE_INSTRUCTIONS.CAPTCHA).toMatch(/never solves or bypasses/i);
    expect(CHALLENGE_INSTRUCTIONS.MFA.toLowerCase()).toContain('manual');
    expect(CHALLENGE_INSTRUCTIONS.MFA).toMatch(/never handles OTPs/i);
    expect(CHALLENGE_INSTRUCTIONS.BOT_CHALLENGE.toLowerCase()).toContain('manual');
    expect(CHALLENGE_INSTRUCTIONS.BOT_CHALLENGE).toMatch(/never bypasses anti-bot/i);
    expect(CHALLENGE_INSTRUCTIONS.RATE_LIMIT.toLowerCase()).toContain('cooldown');
  });
});

describe('6K/6L — pause state persistence (URL, screenshot, browser state, job, source)', () => {
  const appId = 'APP-6U-PAUSE-TEST';

  afterAll(() => {
    try { fs.rmSync(`${challengePauseDir()}/${appId}.json`); } catch { /* already gone */ }
  });

  it('round-trips pause state and marks resolution', () => {
    const state: ChallengePauseState = {
      applicationId: appId,
      jobId: 'JOB-6U-1',
      source: 'linkedin',
      applicationState: 'PAUSED_FOR_USER',
      kind: 'CAPTCHA',
      url: 'https://www.linkedin.com/jobs/view/123',
      evidence: 'CAPTCHA marker: iframe recaptcha',
      screenshotPath: 'applications/x/shot.png',
      sessionSnapshotPath: 'applications/x/browser-state',
      escalationId: 'ESC-1',
      savedAt: new Date().toISOString(),
      instructions: CHALLENGE_INSTRUCTIONS.CAPTCHA,
    };

    const file = saveChallengePause(state);
    expect(fs.existsSync(file)).toBe(true);

    const loaded = loadChallengePause(appId);
    expect(loaded).not.toBeNull();
    expect(loaded!.jobId).toBe('JOB-6U-1');
    expect(loaded!.source).toBe('linkedin');
    expect(loaded!.kind).toBe('CAPTCHA');
    expect(loaded!.applicationState).toBe('PAUSED_FOR_USER');
    expect(loaded!.url).not.toContain('?'); // query strings (tokens) never persisted
    expect(loaded!.screenshotPath).toBeTruthy();
    expect(loaded!.sessionSnapshotPath).toBeTruthy();

    markChallengePauseResolved(appId, 'user completed captcha in visible browser');
    const resolved = loadChallengePause(appId)!;
    expect(resolved.resumedAt).toBeTruthy();
    expect(resolved.resumeOutcome).toContain('user completed');
  });

  it('load returns null for an unknown application', () => {
    expect(loadChallengePause('APP-DOES-NOT-EXIST')).toBeNull();
  });
});
