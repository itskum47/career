/**
 * Phase 8 — per-application approval gate.
 *
 * The gate stands between a prepared application and an irreversible Submit
 * click. These tests prove: no approval ⇒ no click path; approval is per
 * application (never blanket); and a blocker (attestation / visa / work auth /
 * AI declaration) can never be approved away.
 */
import { describe, it, expect } from 'vitest';
import { evaluateApproval, renderApprovalRequest, type ApprovalRequest } from '../../../src/application/approval-gate.ts';

const JOB = 'JOB-greenhouse:singlestore:cloud-platform-engineer';

describe('8 — approval gate', () => {
  it('blocks the click path when approval is required but absent', () => {
    const d = evaluateApproval({ required: true, jobId: JOB });
    expect(d.approved).toBe(false);
    expect(d.requiresApproval).toBe(true);
    expect(d.reason).toContain('no operator approval');
  });

  it('blocks a blanket approval from being applied to another application', () => {
    const d = evaluateApproval({ required: true, approvedJobId: 'JOB-other', jobId: JOB });
    expect(d.approved).toBe(false);
    expect(d.reason).toContain('approval is per application');
  });

  it('allows the click only for the exact approved job', () => {
    const d = evaluateApproval({ required: true, approvedJobId: JOB, jobId: JOB });
    expect(d.approved).toBe(true);
    expect(d.requiresApproval).toBe(false);
  });

  it('never approves away an attestation / visa / work-auth / AI-declaration blocker', () => {
    for (const blocker of [
      'AI-authorship declaration: "use only your own words"',
      'visa sponsorship question',
      'work authorisation question',
    ]) {
      const d = evaluateApproval({ required: true, approvedJobId: JOB, jobId: JOB, blockers: [blocker] });
      expect(d.approved).toBe(false);
      expect(d.reason).toContain('require the human personally');
    }
  });

  it('does not gate when approval is not required (non-rollout modes)', () => {
    const d = evaluateApproval({ required: false, jobId: JOB });
    expect(d.approved).toBe(true);
  });

  it('renders an approval request the human can act on', () => {
    const req: ApprovalRequest = {
      applicationId: 'APP-1',
      jobId: JOB,
      company: 'SingleStore',
      role: 'Cloud Platform Engineer',
      ats: 'greenhouse',
      applicationUrl: 'https://job-boards.greenhouse.io/singlestore/jobs/8212152',
      resumePath: '/cv/SingleStore_Cloud_Platform_Engineer.pdf',
      coverLetterPath: '/cv/CoverLetter_SingleStore_Cloud_Platform_Engineer.pdf',
      sensitiveQuestions: ['nationality', 'linkedin'],
      attachmentGate: { ok: true, resume: 'committed', coverLetter: 'committed' },
      duplicateCheck: { clear: true },
      journal: { clickBearing: false },
      blockers: [],
    };
    const text = renderApprovalRequest(req);
    for (const must of ['SingleStore', 'Cloud Platform Engineer', 'JOB-greenhouse', 'APP-1', 'CV:', 'Attachment gate:    PASSED', 'Duplicate check:    clear', 'Submission journal:', 'nothing will be submitted without it']) {
      expect(text).toContain(must);
    }
    // A click-bearing journal must be surfaced, never hidden.
    const risky = renderApprovalRequest({ ...req, journal: { clickBearing: true, lastPhase: 'uncertain' } });
    expect(risky).toContain('CLICK-BEARING');
  });
});