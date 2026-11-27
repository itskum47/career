/**
 * Phase 8 — per-application approval gate.
 *
 * A real Submit click is irreversible, so the operator must approve the SPECIFIC
 * application first (company, role, ATS, job id, artifacts, blockers). A generic
 * "apply to jobs" never satisfies this gate.
 *
 * The gate is a pure function so its rules are trivially testable, and it is
 * evaluated immediately BEFORE the submission journal entry and the click — so an
 * application that has not been approved cannot even journal an intent.
 */

export interface ApprovalRequest {
  applicationId: string;
  jobId: string;
  company: string;
  role: string;
  ats: string;
  applicationUrl: string;
  resumePath?: string;
  coverLetterPath?: string;
  /** Attestation/sensitive questions that must be answered by the human. */
  sensitiveQuestions: string[];
  attachmentGate: { ok: boolean; resume?: string; coverLetter?: string };
  duplicateCheck: { clear: boolean; reason?: string };
  journal: { clickBearing: boolean; lastPhase?: string };
  blockers: string[];
}

export interface ApprovalDecision {
  /** True when the click may proceed. */
  approved: boolean;
  /** True when a human must still approve this specific application. */
  requiresApproval: boolean;
  reason: string;
  /** Job ids explicitly approved (approval is per application/job, never blanket). */
  approvedJobId?: string;
}

/**
 * Evaluate approval for one application.
 *
 * @param required        REQUIRE_APPROVAL (production rollout mode)
 * @param approvedJobId   APPROVED_JOB_ID — the single job the operator approved
 * @param jobId           the job about to be submitted
 * @param blockers        form/attestation blockers discovered for this application
 */
export function evaluateApproval(input: {
  required: boolean;
  approvedJobId?: string;
  jobId: string;
  blockers?: string[];
}): ApprovalDecision {
  const blockers = input.blockers ?? [];

  // A blocker (attestation / visa / work-auth / AI declaration) can never be
  // approved away: the answer would have to come from the human, on the form.
  if (blockers.length > 0) {
    return {
      approved: false,
      requiresApproval: true,
      reason: `application has ${blockers.length} blocker(s) that require the human personally: ${blockers.join('; ')}`,
    };
  }

  if (!input.required) {
    return { approved: true, requiresApproval: false, reason: 'approval not required in this mode' };
  }

  if (input.approvedJobId && input.approvedJobId === input.jobId) {
    return {
      approved: true,
      requiresApproval: false,
      reason: `operator approved this specific application (${input.jobId})`,
      approvedJobId: input.approvedJobId,
    };
  }

  return {
    approved: false,
    requiresApproval: true,
    reason: input.approvedJobId
      ? `operator approved ${input.approvedJobId}, NOT ${input.jobId} — approval is per application`
      : 'no operator approval recorded for this application yet',
  };
}

/** Chat-facing approval prompt (what the human sees before deciding). */
export function renderApprovalRequest(req: ApprovalRequest): string {
  const lines = [
    'READY FOR YOUR APPROVAL — nothing will be submitted without it.',
    '',
    `Company:            ${req.company}`,
    `Role:               ${req.role}`,
    `Job ID:             ${req.jobId}`,
    `Application ID:     ${req.applicationId}`,
    `ATS / route:        ${req.ats}`,
    `Application URL:    ${req.applicationUrl}`,
    `CV:                 ${req.resumePath ?? '(none)'}`,
    `Cover letter:       ${req.coverLetterPath ?? '(none)'}`,
    `Attachment gate:    ${req.attachmentGate.ok ? 'PASSED' : 'FAILED — ' + JSON.stringify(req.attachmentGate)}`,
    `Duplicate check:    ${req.duplicateCheck.clear ? 'clear — no prior submission' : 'BLOCKED — ' + (req.duplicateCheck.reason ?? '')}`,
    `Submission journal: ${req.journal.clickBearing ? 'CLICK-BEARING — retry refused' : `no click recorded (last phase: ${req.journal.lastPhase ?? 'none'})`}`,
    `Sensitive questions: ${req.sensitiveQuestions.length ? req.sensitiveQuestions.join(' | ') : 'none outstanding'}`,
    `Blockers:           ${req.blockers.length ? req.blockers.join('; ') : 'none'}`,
  ];
  return lines.join('\n');
}