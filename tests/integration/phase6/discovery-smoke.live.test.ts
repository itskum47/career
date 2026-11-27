/**
 * 6V — LIVE discovery smoke test against legitimate public sources.
 *
 * Gated behind LIVE_DISCOVERY_SMOKE=1 so the default suite stays hermetic
 * (no network). Run explicitly:
 *
 *   LIVE_DISCOVERY_SMOKE=1 npx vitest run tests/integration/phase6/discovery-smoke.live.test.ts
 *
 * Verifies the full discovery chain on REAL sources:
 *   discover -> normalize -> dedupe -> complete JD -> route resolution
 * and then STOPS BEFORE SUBMISSION (6I/6V): the discovery orchestrator has no
 * application code path, and this test guards that structurally.
 *
 * Sources used: Greenhouse boards (gitlab/airtable/discord), We Work Remotely
 * category RSS, Remote OK, Remotive — all measured public endpoints (6B).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DiscoveryOrchestrator, type DiscoveryRunResult } from '../../../src/discovery/orchestrator.ts';

const LIVE = process.env.LIVE_DISCOVERY_SMOKE === '1';

// Legitimate public sources only — never a login-gated or challenge-guarded one.
const ONLY_SOURCES = ['greenhouse', 'weworkremotely', 'remoteok', 'remotive'];

describe.skipIf(!LIVE)('6V — live discovery smoke (public sources, STOP before submission)', () => {
  let result: DiscoveryRunResult;

  beforeAll(async () => {
    if (!process.env.GREENHOUSE_BOARD_TOKENS) process.env.GREENHOUSE_BOARD_TOKENS = 'gitlab,airtable,discord';
    const orch = new DiscoveryOrchestrator({
      config: { onlySources: ONLY_SOURCES, maxJobsPerSource: 8 },
      fetchFullJd: true,
    });
    result = await orch.run({
      keywords: ['devops', 'sre', 'site reliability', 'platform engineer', 'cloud engineer', 'kubernetes'],
      locations: ['Remote India', 'India', 'Pune', 'Bengaluru', 'Hyderabad', 'Mumbai', 'Chennai'],
      maxResults: 8,
    });
  }, 180_000);

  it('discovers real jobs from the configured public sources', () => {
    expect(result.searchesFailed).toBe(0);
    expect(result.rawJobsDiscovered).toBeGreaterThan(0);
    expect(result.sourcesQueried.sort()).toEqual([...ONLY_SOURCES].sort());
  });

  it('normalizes every raw job (6E) with distinct internal vs source ids', () => {
    expect(result.normalizedJobs).toBe(result.rawJobsDiscovered);
    const internalIds = new Set(result.records.map(r => r.job.internalJobId));
    expect(internalIds.size).toBe(result.uniqueJobs);
    for (const r of result.records) {
      expect(r.job.internalJobId).toMatch(/^JOB-/);
      expect(r.job.sourceJobId).toBeTruthy();
      expect(r.job.sourceUrl).toMatch(/^https?:\/\//);
      expect(r.job.canonicalJobUrl).toBeTruthy();
      expect(ONLY_SOURCES).toContain(r.job.source);
    }
    // Source job ids must be unique per source listing (no collisions).
    const sourceIds = result.records.map(r => `${r.job.source}:${r.job.sourceJobId}`);
    expect(new Set(sourceIds).size).toBe(sourceIds.length);
  });

  it('dedupes to canonical opportunities while keeping unique <= raw (6F)', () => {
    expect(result.uniqueJobs).toBeLessThanOrEqual(result.normalizedJobs);
    for (const r of result.records) {
      expect(r.canonical.canonicalKey).toBeTruthy();
      expect(r.canonical.dedupeConfidence).toBeGreaterThan(0);
      expect(r.canonical.occurrences.length).toBeGreaterThanOrEqual(1);
    }
    expect(result.duplicates + result.uniqueJobs).toBe(result.normalizedJobs);
  });

  it('retrieves a complete, verified JD for every canonical job before any apply gate (6H)', () => {
    expect(result.completeJdCount).toBe(result.uniqueJobs);
    expect(result.completeJdRate).toBe(1);
    for (const r of result.records) {
      expect(r.jd.ready).toBe(true);
      expect(r.job.jdComplete).toBe(true);
      expect(r.job.description.length).toBeGreaterThanOrEqual(400);
    }
  });

  it('resolves an application route for every canonical job (6G)', () => {
    expect(result.routesResolved).toBe(result.uniqueJobs);
    expect(result.routeAvailability).toBe(1);
    for (const r of result.records) {
      expect(r.route.route).not.toBe('UNKNOWN');
      expect(r.route.discoveredFrom).toBeTruthy();
      expect(r.route.canonicalSource).toBeTruthy();
      expect(r.route.applicationUrl).toMatch(/^https?:\/\//);
      // 6G: routes must never label a board as an ATS.
      expect(['remoteok', 'remotive', 'weworkremotely']).not.toContain(r.route.ats);
    }
  });

  it('never assumes remote permits India — gated jobs are retained, not queued (6D/6O)', () => {
    expect(result.eligibility.eligible + result.eligibility.ineligible).toBe(result.uniqueJobs);
    expect(result.queue.length).toBe(result.eligibility.eligible);
    const queuedCountryLists = result.queue.map(r => r.job.allowedCountries).filter(Boolean) as string[][];
    for (const list of queuedCountryLists) {
      expect(list).toContain('India');
    }
  });

  it('STOP BEFORE SUBMISSION: the discovery pipeline has no application code path (6I/6V)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/discovery/orchestrator.ts'), 'utf8');
    expect(src).not.toMatch(/application\/engine/);
    expect(src).not.toMatch(/application\/portal-adapter/);
    // No application state exists on discovery records at all.
    for (const r of result.queue) {
      expect('applicationStatus' in r.job).toBe(false);
      expect('confirmationId' in r.job).toBe(false);
    }
  });
});
