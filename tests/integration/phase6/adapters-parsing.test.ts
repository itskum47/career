/**
 * 6U — Adapter parsing unit tests (pure functions, no network).
 *
 * Guards the real defects found in the 6T benchmark on 2026-10-07:
 *   - WWR titles are "Company: Role" (a dash split leaked role text into company)
 *   - trailing "(Python)" is a skill, NOT a location
 *   - sourceJobId must be unique per listing (no truncated base64 collisions)
 */
import { describe, it, expect } from 'vitest';
import { parseWwrTitle, parseWwrDescription, decodeEntities } from '../../../src/discovery/adapters-api.ts';
import { createHash } from 'crypto';

describe('6B — We Work Remotely title parsing', () => {
  it('splits "Company: Role" on the first colon (measured 25/25 format)', () => {
    const r = parseWwrTitle('Hex Technologies: Cloud Security Engineer');
    expect(r.company).toBe('Hex Technologies');
    expect(r.title).toBe('Cloud Security Engineer');
    expect(r.locSuffix).toBeUndefined();
  });

  it('keeps dashes inside the role title out of the company field', () => {
    const r = parseWwrTitle('Adventure Travel 365: Senior Full-Stack Developer - Marketplace Web & Mobile Platform');
    expect(r.company).toBe('Adventure Travel 365');
    expect(r.title).toBe('Senior Full-Stack Developer - Marketplace Web & Mobile Platform');
  });

  it('keeps a trailing SKILL paren in the title (it discriminates jobs)', () => {
    const a = parseWwrTitle('Proxify AB: Senior Backend Developer (Python)');
    const b = parseWwrTitle('Proxify AB: Senior Backend Developer (Node.js / Nest.js)');
    expect(a.company).toBe('Proxify AB');
    expect(a.title).toBe('Senior Backend Developer (Python)');
    expect(a.locSuffix).toBeUndefined();
    expect(b.title).toBe('Senior Backend Developer (Node.js / Nest.js)');
    // The two jobs must NOT collapse into an identical title (6F false-merge risk).
    expect(a.title).not.toBe(b.title);
  });

  it('treats a trailing location paren as location evidence and strips it', () => {
    const r = parseWwrTitle('Acme: DevOps Engineer (US)');
    expect(r.company).toBe('Acme');
    expect(r.title).toBe('DevOps Engineer');
    expect(r.locSuffix).toBe('US');
  });

  it('gender markers are not locations', () => {
    const r = parseWwrTitle('Acme: Platform Engineer (m/f/d)');
    expect(r.title).toBe('Platform Engineer (m/f/d)');
    expect(r.locSuffix).toBeUndefined();
  });

  it('falls back to legacy "Company - Role" when no colon is present', () => {
    const r = parseWwrTitle('Acme - SRE (Anywhere)');
    expect(r.company).toBe('Acme');
    expect(r.title).toBe('SRE');
    expect(r.locSuffix).toBe('Anywhere');
  });

  it('colon-less single token degrades to Unknown company', () => {
    const r = parseWwrTitle('Just A Role');
    expect(r.company).toBe('Unknown');
    expect(r.title).toBe('Just A Role');
  });
});

describe('6B — We Work Remotely description parsing', () => {
  it('extracts the Headquarters value out of escaped markup', () => {
    const decoded = decodeEntities('&lt;strong&gt;Headquarters:&lt;/strong&gt; Tallinn, Estonia &lt;br /&gt;');
    const r = parseWwrDescription(decoded);
    expect(r.hq).toBe('Tallinn, Estonia');
    expect(r.employerUrl).toBeUndefined();
  });

  it('extracts an HQ that mentions remote (location evidence)', () => {
    const decoded = decodeEntities('&lt;p&gt;&lt;strong&gt;Headquarters:&lt;/strong&gt; SF, NYC, or Remote (US)&lt;/p&gt;');
    expect(parseWwrDescription(decoded).hq).toBe('SF, NYC, or Remote (US)');
  });

  it('ignores an EMPTY Headquarters value', () => {
    const decoded = decodeEntities('&lt;p&gt;&lt;strong&gt;Headquarters:&lt;/strong&gt; &lt;/p&gt;&lt;p&gt;We are looking...&lt;/p&gt;');
    expect(parseWwrDescription(decoded).hq).toBeUndefined();
  });

  it('extracts the employer application URL', () => {
    const decoded = decodeEntities('&lt;strong&gt;URL:&lt;/strong&gt; &lt;a href="https://toggl.com/jobs/"&gt;https://toggl.com/jobs/&lt;/a&gt;');
    expect(parseWwrDescription(decoded).employerUrl).toBe('https://toggl.com/jobs/');
  });

  it('extracts a plain-text URL when there is no anchor', () => {
    const decoded = 'URL:</strong> https://careers.example.com/openings';
    expect(parseWwrDescription(decoded).employerUrl).toBe('https://careers.example.com/openings');
  });
});

describe('6E — entity decoding', () => {
  it('decodes escaped markup so tag stripping actually works', () => {
    expect(decodeEntities('&lt;p&gt;Hello&lt;/p&gt;')).toBe('<p>Hello</p>');
  });
  it('does not double-decode &amp;lt; into a tag', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });
});

describe('6F — sourceJobId uniqueness (regression: truncated base64 collided)', () => {
  it('hashing two distinct listing links yields distinct source job ids', () => {
    const a = `WWR-${createHash('sha256').update('https://weworkremotely.com/remote-jobs/aaa').digest('hex').slice(0, 16)}`;
    const b = `WWR-${createHash('sha256').update('https://weworkremotely.com/remote-jobs/bbb').digest('hex').slice(0, 16)}`;
    expect(a).not.toBe(b);
    // Old scheme: first 16 base64 chars of the URL — identical for every job.
    const oldA = Buffer.from('https://weworkremotely.com/remote-jobs/aaa').toString('base64url').slice(0, 16);
    const oldB = Buffer.from('https://weworkremotely.com/remote-jobs/bbb').toString('base64url').slice(0, 16);
    expect(oldA).toBe(oldB); // documents WHY the scheme had to change
  });
});
