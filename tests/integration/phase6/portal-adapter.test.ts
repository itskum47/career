/**
 * Phase 6U — PortalApplicationAdapter interface + strategy chain (6Q/6P).
 *
 * Strategy order is strict: site-specific -> ATS-specific -> semantic
 * fallback -> human escalation. Adapters supply site-specific interaction
 * behavior only; the existing optimized ApplicationEngine remains the one
 * engine (6P).
 */
import { describe, it, expect } from 'vitest';
import {
  PortalApplicationRouter,
  SemanticFallbackAdapter,
  HumanEscalationAdapter,
  SiteSpecificAdapter,
  portalApplicationRouter,
} from '../../../src/application/portal-adapter.ts';
import type {
  PortalAdapterContext,
  PortalApplicationAdapter,
} from '../../../src/application/portal-adapter.ts';

function ctx(overrides: Partial<PortalAdapterContext> = {}): PortalAdapterContext {
  return {
    page: null,
    applicationId: 'APP-6U-1',
    jobId: 'JOB-6U-1',
    source: 'greenhouse',
    applicationUrl: 'https://boards.greenhouse.io/acme/jobs/12345678',
    ...overrides,
  };
}

describe('6Q — strategy chain order', () => {
  it('site-specific adapter wins for a known portal source', () => {
    const a = portalApplicationRouter.detect(ctx({ source: 'linkedin', applicationUrl: 'https://www.linkedin.com/jobs/view/1' }));
    expect(a.tier).toBe('site');
    expect(a.id).toBe('site:linkedin');
  });

  it('ATS-specific adapter is used when an ATS is detected', () => {
    const a = portalApplicationRouter.detect(ctx({ source: 'remoteok', ats: 'lever', applicationUrl: 'https://jobs.lever.co/acme/x' }));
    expect(a.tier).toBe('ats');
    expect(a.id).toContain('lever');
  });

  it('semantic fallback handles unknown sources without an ATS', () => {
    const a = portalApplicationRouter.detect(ctx({ source: 'some-new-board', ats: undefined, applicationUrl: 'https://some-new-board.test/jobs/1' }));
    expect(a.tier).toBe('semantic');
    expect(a.id).toBe('semantic-fallback');
  });

  it('semantic fallback also handles unknown ATS families', () => {
    const a = portalApplicationRouter.detect(ctx({ source: 'some-new-board', ats: 'icims', applicationUrl: 'https://careers.acme.test/jobs/1' }));
    expect(a.tier).toBe('semantic');
  });

  it('human escalation adapter always requires a human (floor of the chain)', async () => {
    const human = new HumanEscalationAdapter();
    expect(human.tier).toBe('human');
    expect(human.escalationRequired()).toBe(true);
    expect((await human.detectSubmission(ctx())).submitted).toBe(false);
    expect((await human.fillFields(ctx(), { x: 'y' })).success).toBe(false);
  });
});

describe('6Q — login requirements and escalation', () => {
  it('account-walled portals report loginRequired=true (6K)', () => {
    for (const source of ['apna', 'freshersworld', 'linkedin']) {
      const a = portalApplicationRouter.detect(ctx({ source, applicationUrl: `https://${source}.example/apply` }));
      expect(a.loginRequired(ctx()), source).toBe(true);
    }
  });

  it('open direct-apply portals report loginRequired=false', () => {
    const a = portalApplicationRouter.detect(ctx({ source: 'shine', applicationUrl: 'https://www.shine.com/careers/x' }));
    expect(a.loginRequired(ctx())).toBe(false);
  });

  it('ATS and semantic adapters do not demand escalation up-front', () => {
    const ats = portalApplicationRouter.detect(ctx({ source: 'remoteok', ats: 'ashby', applicationUrl: 'https://jobs.ashbyhq.com/acme/x' }));
    expect(ats.escalationRequired(ctx())).toBe(false);
    const sem = portalApplicationRouter.detect(ctx({ source: 'unknown' }));
    expect(sem.escalationRequired(ctx())).toBe(false);
    expect(portalApplicationRouter.escalationRequired(ctx({ source: 'unknown' }))).toBe(false);
  });
});

describe('6Q — adapter contract behaviors', () => {
  it('openApplication returns the resolved application URL (site normalization hook)', () => {
    const u = 'https://boards.greenhouse.io/acme/jobs/12345678';
    expect(portalApplicationRouter.detect(ctx({ applicationUrl: u })).openApplication(ctx({ applicationUrl: u }))).toBe(u);
  });

  it('analyzeForm with no page returns a zero survey (never throws)', async () => {
    const a = new SemanticFallbackAdapter();
    const survey = await a.analyzeForm(ctx());
    expect(survey).toEqual({ fieldCount: 0, fileInputs: 0, submitButtons: 0 });
  });

  it('site-specific analysis with no page is safe', async () => {
    const a = new SiteSpecificAdapter('shine', { requiresAccount: false });
    const survey = await a.analyzeForm(ctx({ source: 'shine' }));
    expect(survey.fieldCount).toBe(0);
    expect(a.canHandle(ctx({ source: 'shine' }))).toBe(true);
  });

  it('generic fill/upload/confirm paths defer to the existing engine (6P: one engine)', async () => {
    const a = new SemanticFallbackAdapter();
    const fill = await a.fillFields(ctx(), { fullName: 'X' });
    expect(fill.success).toBe(true);
    expect(fill.adapter).toBe('semantic-fallback');

    const sub = await a.detectSubmission(ctx());
    expect(sub.submitted).toBe(false); // engine submission result governs

    const conf = await a.extractConfirmation(ctx());
    expect(conf.found).toBe(false);
  });

  it('session save/restore round-trips adapter payload (engine owns browser state)', async () => {
    const a = new SemanticFallbackAdapter();
    const snap = await a.saveSession(ctx());
    expect(snap.adapter).toBe('semantic-fallback');
    expect(snap.savedAt).toBeTruthy();
    await expect(a.restoreSession(ctx(), snap)).resolves.toBeUndefined();
  });

  it('custom adapters can be registered and take precedence (legitimate later discoveries)', async () => {
    const custom: PortalApplicationAdapter = {
      id: 'site:custom-portal',
      displayName: 'Custom portal',
      tier: 'site',
      canHandle: c => c.source === 'custom-portal',
      loginRequired: () => true,
      openApplication: c => c.applicationUrl,
      analyzeForm: async () => ({ fieldCount: 1, fileInputs: 0, submitButtons: 1 }),
      fillFields: async () => ({ success: true, filledFields: 1, adapter: 'site:custom-portal' }),
      handleUploads: async () => ({ success: true, adapter: 'site:custom-portal', detail: '' }),
      handleQuestions: async () => ({ answered: 1, adapter: 'site:custom-portal' }),
      detectSubmission: async () => ({ submitted: false, adapter: 'site:custom-portal', detail: '' }),
      extractConfirmation: async () => ({ found: false, adapter: 'site:custom-portal', detail: '' }),
      saveSession: async () => ({ adapter: 'site:custom-portal', savedAt: new Date().toISOString() }),
      restoreSession: async () => {},
      escalationRequired: () => false,
    };
    const router = new PortalApplicationRouter();
    router.register(custom);
    const detected = router.detect(ctx({ source: 'custom-portal' }));
    expect(detected.id).toBe('site:custom-portal');
    expect(detected.loginRequired(ctx({ source: 'custom-portal' }))).toBe(true);
  });
});
