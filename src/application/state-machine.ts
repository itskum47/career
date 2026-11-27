/**
 * Phase 7 — Application submission state machine.
 *
 * Formalises the lifecycle and, crucially, the SAFETY RULES as code so no
 * caller can drift:
 *
 *   DISCOVERED → QUALIFIED → ARTIFACTS_READY → FORM_STARTED → WAITING_FOR_USER
 *     → READY_TO_SUBMIT → SUBMISSION_STARTED → SUBMISSION_ATTEMPTED
 *     → SUBMITTED → CONFIRMED
 *   with failure/safety branches: FAILED, BLOCKED, SUBMISSION_UNKNOWN,
 *   SUBMISSION_UNCERTAIN.
 *
 * Rules encoded here (previously implicit in call sites):
 *   - SUBMISSION_UNKNOWN / SUBMISSION_UNCERTAIN → NEVER automatically retried.
 *   - SUBMITTED / CONFIRMED → terminal, never submit again.
 *   - FAILED is retryable ONLY when the failure is provably pre-submit (or the
 *     journal proves no click happened); otherwise it is escalated.
 *   - The submission journal is consulted for every decision about retrying.
 */

export const APPLICATION_STATES = [
  'DISCOVERED',
  'QUALIFIED',
  'ARTIFACTS_READY',
  'FORM_STARTED',
  'WAITING_FOR_USER',
  'READY_TO_SUBMIT',
  'SUBMISSION_STARTED',
  'SUBMISSION_ATTEMPTED',
  'SUBMISSION_UNKNOWN',
  'SUBMISSION_UNCERTAIN',
  'SUBMITTED',
  'CONFIRMED',
  'FAILED',
  'BLOCKED',
] as const;

export type ApplicationLifecycleState = (typeof APPLICATION_STATES)[number];

/** Allowed transitions. Anything not listed is refused (illegal state change). */
const TRANSITIONS: Record<ApplicationLifecycleState, ApplicationLifecycleState[]> = {
  DISCOVERED: ['QUALIFIED', 'FAILED', 'BLOCKED'],
  QUALIFIED: ['ARTIFACTS_READY', 'FAILED', 'BLOCKED'],
  ARTIFACTS_READY: ['FORM_STARTED', 'FAILED', 'BLOCKED'],
  FORM_STARTED: ['WAITING_FOR_USER', 'READY_TO_SUBMIT', 'FAILED', 'BLOCKED'],
  // A pause must be able to return to the form it paused in.
  WAITING_FOR_USER: ['FORM_STARTED', 'READY_TO_SUBMIT', 'FAILED', 'BLOCKED'],
  READY_TO_SUBMIT: ['SUBMISSION_STARTED', 'FAILED', 'BLOCKED'],
  // Once a click intent is journalled, the only forward move is the attempt.
  SUBMISSION_STARTED: ['SUBMISSION_ATTEMPTED', 'SUBMISSION_UNKNOWN', 'FAILED', 'BLOCKED'],
  SUBMISSION_ATTEMPTED: ['SUBMITTED', 'CONFIRMED', 'SUBMISSION_UNKNOWN', 'SUBMISSION_UNCERTAIN', 'FAILED'],
  // Outcomes after an attempt with no confirmation — never auto-retried.
  SUBMISSION_UNKNOWN: ['SUBMITTED', 'CONFIRMED', 'BLOCKED'],
  SUBMISSION_UNCERTAIN: ['SUBMITTED', 'CONFIRMED', 'BLOCKED'],
  SUBMITTED: ['CONFIRMED', 'SUBMISSION_UNCERTAIN'],
  CONFIRMED: [],
  FAILED: ['QUALIFIED', 'FORM_STARTED', 'BLOCKED'],
  BLOCKED: ['QUALIFIED', 'FORM_STARTED'],
};

/** States in which a submit click has (possibly) already happened. */
export const CLICK_BEARING_STATES: readonly ApplicationLifecycleState[] = [
  'SUBMISSION_STARTED',
  'SUBMISSION_ATTEMPTED',
  'SUBMISSION_UNKNOWN',
  'SUBMISSION_UNCERTAIN',
  'SUBMITTED',
  'CONFIRMED',
];

/** States that must never be retried automatically. */
export const NO_AUTO_RETRY_STATES: readonly ApplicationLifecycleState[] = [
  'SUBMISSION_UNKNOWN',
  'SUBMISSION_UNCERTAIN',
  'SUBMITTED',
  'CONFIRMED',
];

export function isTerminal(state: ApplicationLifecycleState): boolean {
  return state === 'CONFIRMED';
}

export function canTransition(from: ApplicationLifecycleState, to: ApplicationLifecycleState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export interface TransitionDecision {
  allowed: boolean;
  reason?: string;
}

export function assertTransition(from: ApplicationLifecycleState, to: ApplicationLifecycleState): TransitionDecision {
  if (from === to) return { allowed: true };
  if (canTransition(from, to)) return { allowed: true };
  return {
    allowed: false,
    reason: `illegal transition ${from} → ${to}`,
  };
}

export interface RetryDecision {
  /** True only when it is provably safe to retry without a human. */
  safeToAutoRetry: boolean;
  requiresHuman: boolean;
  reason: string;
}

/**
 * Retry policy. The journal is the authority: if any click-bearing phase exists
 * for the job, a retry requires a human and is never automatic.
 */
export function decideRetry(input: {
  state: ApplicationLifecycleState;
  /** True when the submission journal holds a click-bearing entry for this job. */
  journalClickBearing: boolean;
  /** True when the failure is provably pre-submit (validation, attachment, question, artifact…). */
  provablyPreSubmit?: boolean;
  failureCode?: string;
}): RetryDecision {
  if (NO_AUTO_RETRY_STATES.includes(input.state)) {
    return {
      safeToAutoRetry: false,
      requiresHuman: true,
      reason: `${input.state} is never retried automatically — a Submit click may already have reached the employer`,
    };
  }
  if (input.journalClickBearing) {
    return {
      safeToAutoRetry: false,
      requiresHuman: true,
      reason: 'submission journal records a click-bearing attempt for this job',
    };
  }
  if (input.state === 'FAILED' && input.provablyPreSubmit) {
    return {
      safeToAutoRetry: true,
      requiresHuman: false,
      reason: `failure ${input.failureCode ?? 'unknown'} is provably pre-submit and no click was journalled`,
    };
  }
  if (input.state === 'FAILED') {
    return {
      safeToAutoRetry: false,
      requiresHuman: true,
      reason: 'failure was not proven pre-submit — human review required before retry',
    };
  }
  return {
    safeToAutoRetry: false,
    requiresHuman: false,
    reason: `state ${input.state} is not a retryable terminal state`,
  };
}

/** Map a legacy engine state onto the lifecycle state (best effort). */
export function toLifecycleState(engineState: string): ApplicationLifecycleState {
  switch (engineState) {
    case 'DISCOVERED':
    case 'VERIFIED':
    case 'ANALYZED':
      return 'DISCOVERED';
    case 'MATCHED':
    case 'READY_TO_APPLY':
      return 'QUALIFIED';
    case 'RESUME_GENERATED':
    case 'RESUME_VALIDATED':
      return 'ARTIFACTS_READY';
    case 'BROWSER_STARTED':
    case 'FORM_ANALYZING':
    case 'FORM_FILLING':
      return 'FORM_STARTED';
    case 'PAUSED_FOR_USER':
      return 'WAITING_FOR_USER';
    case 'READY_TO_SUBMIT':
      return 'READY_TO_SUBMIT';
    case 'SUBMITTED':
      return 'SUBMITTED';
    case 'CONFIRMED':
      return 'CONFIRMED';
    case 'SUBMISSION_UNCERTAIN':
      return 'SUBMISSION_UNCERTAIN';
    case 'BLOCKED':
      return 'BLOCKED';
    case 'ERROR':
      return 'FAILED';
    default:
      return 'DISCOVERED';
  }
}