/**
 * Phase 6U — Source registry tests (6A/6B/6C/6D).
 *
 * Fixtures only — no network. Proves the Phase 2 bug class (hardcoded
 * always-enabled adapters / mock hiding beside real sources) cannot return.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry, configFromEnv } from '../../../src/discovery/registry.ts';
import {
  SOURCE_CATALOG,
  ALL_SOURCE_IDS,
  ROLE_FAMILIES,
  SEARCH_LOCATIONS,
} from '../../../src/discovery/catalog.ts';

describe('6A — JobSourceRegistry is config-driven', () => {
  it('enables supported API sources by default and keeps mock OFF', () => {
    const reg = createRegistry();
    const enabled = reg.enabledSources().map(e => e.source);
    expect(enabled).toContain('greenhouse');
    expect(enabled).toContain('lever');
    expect(enabled).toContain('ashby');
    // Phase 2 bug guard: mock is never implicitly enabled beside real sources.
    expect(enabled).not.toContain('mock');
  });

  it('onlyMock isolates discovery to the fixture source exactly', () => {
    const reg = createRegistry({ onlyMock: true });
    expect(reg.enabledSources().map(e => e.source)).toEqual(['mock']);
  });

  it('throws on unknown source ids in config (typo never silently disables)', () => {
    expect(() => createRegistry({ onlySources: ['not-a-source'] })).toThrow(/unknown source id/);
    expect(() => createRegistry({ excludeSources: ['not-a-source'] })).toThrow(/unknown source id/);
    expect(() => createRegistry({ enable: ['nope'] })).toThrow(/unknown source id/);
  });

  it('excludeSources disables exactly that source, nothing else', () => {
    const reg = createRegistry({ excludeSources: ['linkedin'] });
    expect(reg.get('linkedin').enabled).toBe(false);
    expect(reg.get('greenhouse').enabled).toBe(true);
  });

  it('onlySources restricts to exactly the allowlist', () => {
    const reg = createRegistry({ onlySources: ['greenhouse'] });
    expect(reg.enabledSources().map(e => e.source)).toEqual(['greenhouse']);
  });

  it('onlySources naming a discovery:none source fails loudly', () => {
    const none = SOURCE_CATALOG.find(d => d.capabilities.discovery === 'none');
    expect(none).toBeDefined();
    expect(() => createRegistry({ onlySources: [none!.id] })).toThrow(/discovery capability is 'none'/);
  });

  it('setEnabled cannot enable a source whose discovery capability is none', () => {
    const reg = createRegistry();
    const none = SOURCE_CATALOG.find(d => d.capabilities.discovery === 'none')!;
    expect(() => reg.setEnabled(none.id, true)).toThrow(/discovery capability is none/);
  });

  it('per-source config exposes priority, rate limit, timeout, caps (6M)', () => {
    const reg = createRegistry({ maxJobsPerSource: 7, sourceConcurrency: 2 });
    const entry = reg.get('greenhouse');
    expect(entry.maxJobsPerSource).toBe(7);
    expect(entry.concurrency).toBeGreaterThan(0);
    expect(entry.concurrency).toBeLessThanOrEqual(2);
    expect(entry.rateLimitMs).toBeGreaterThan(0);
    expect(entry.timeoutMs).toBeGreaterThan(0);
    expect(entry.priority).toBeGreaterThan(0);
    const policy = reg.policyFor('greenhouse');
    expect(policy.rateLimitMs).toBeGreaterThan(0);
    expect(policy.failureThreshold).toBeGreaterThan(0);
    expect(policy.retryAttempts).toBeGreaterThanOrEqual(0);
    expect(reg.capFor('greenhouse')).toBe(7);
  });

  it('env bridge maps DISCOVERY_* variables into registry config', () => {
    const cfg = configFromEnv({
      DISCOVERY_ONLY_MOCK: 'true',
      DISCOVERY_MAX_PER_SOURCE: '7',
      DISCOVERY_EXCLUDE_SOURCES: 'linkedin,indeed',
    } as NodeJS.ProcessEnv);
    expect(cfg.onlyMock).toBe(true);
    expect(cfg.maxJobsPerSource).toBe(7);
    expect(cfg.excludeSources).toEqual(['linkedin', 'indeed']);
  });
});

describe('6B — explicit capability reporting (no fake implementations)', () => {
  it('capability report covers every catalog source with explicit status', () => {
    const report = createRegistry().capabilityReport();
    expect(report.length).toBe(SOURCE_CATALOG.length);
    for (const r of report) {
      expect(ALL_SOURCE_IDS).toContain(r.source);
      expect(['supported', 'partial', 'deferred', 'blocked']).toContain(r.support);
      expect(typeof r.discovery).toBe('string');
      expect(typeof r.application).toBe('boolean');
      expect(typeof r.loginRequired).toBe('boolean');
      expect(typeof r.priority).toBe('number');
      // Anything not actually supported must state WHY (no fake claims).
      if (r.support === 'deferred' || r.support === 'blocked') {
        expect((r.reason ?? '').length).toBeGreaterThan(0);
      }
      // A source that cannot discover must never report enabled discovery.
      if (r.discovery === 'none') expect(r.enabled).toBe(false);
    }
  });

  it('every blocked source records a probe reason (never bypassed)', () => {
    const blocked = SOURCE_CATALOG.filter(d => d.support === 'blocked');
    expect(blocked.length).toBeGreaterThan(0);
    for (const d of blocked) {
      expect((d.reason ?? '').length).toBeGreaterThan(0);
      expect(d.capabilities.discovery).toBe('none');
      expect(d.defaults.enabled).toBe(false);
    }
  });

  it('supported API sources carry measured probe evidence', () => {
    for (const id of ['greenhouse', 'lever', 'ashby', 'remoteok', 'remotive']) {
      const d = SOURCE_CATALOG.find(x => x.id === id)!;
      expect(d.support).toBe('supported');
      expect(d.probeEvidence?.measured).toBeTruthy();
      expect(d.defaults.enabled).toBe(true);
    }
  });
});

describe('6C/6D — role families and location coverage', () => {
  it('has 19+ DevOps role families with synonyms (not exact-title-only)', () => {
    expect(ROLE_FAMILIES.length).toBeGreaterThanOrEqual(19);
    for (const f of ROLE_FAMILIES) {
      expect(f.family.length).toBeGreaterThan(0);
      expect(f.synonyms.length).toBeGreaterThan(0);
    }
    const all = ROLE_FAMILIES.flatMap(f => f.synonyms.map(s => s.toLowerCase()));
    expect(all).toContain('sre');
    expect(all).toContain('devops');
    expect(all).toContain('platform engineer');
  });

  it('covers Remote India plus the required metro hubs', () => {
    const labels = SEARCH_LOCATIONS.map(l => l.label);
    expect(labels).toContain('Remote India');
    expect(SEARCH_LOCATIONS.find(l => l.label === 'Remote India')?.remote).toBe(true);
    for (const city of ['Pune', 'Bengaluru', 'Hyderabad', 'Delhi NCR', 'Gurgaon', 'Noida',
                        'Mumbai', 'Chennai', 'Kolkata', 'Jaipur', 'Ahmedabad', 'Kochi', 'Chandigarh']) {
      expect(labels).toContain(city);
    }
    // Bengaluru synonyms must accept "Bangalore" (common spelling).
    expect(SEARCH_LOCATIONS.find(l => l.label === 'Bengaluru')?.synonyms).toContain('bangalore');
  });
});
