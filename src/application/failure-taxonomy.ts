/**
 * Phase 7 — Failure taxonomy.
 *
 * Every failure names its FIRST failing stage with a stable code, so operations
 * never collapse distinct problems into "application failed" and so retry
 * decisions, dashboards and chat explanations all speak the same language.
 *
 * Classification is deterministic (stage + error text), pure, and unit-tested.
 */

export const FAILURE_CODES = [
  'DISCOVERY_FAILURE',
  'JD_FAILURE',
  'ARTIFACT_FAILURE',
  'FORM_FAILURE',
  'QUESTION_ESCALATION',
  'ATTACHMENT_FAILURE',
  'VALIDATION_FAILURE',
  'LOGIN_REQUIRED',
  'CAPTCHA_REQUIRED',
  'MFA_REQUIRED',
  'RATE_LIMITED',
  'DUPLICATE_BLOCKED',
  'SUBMISSION_TRANSPORT_FAILURE',
  'SUBMISSION_UNKNOWN',
  'CONFIRMATION_FAILURE',
  'DB_FAILURE',
  'EXCEL_FAILURE',
  'JOURNAL_FAILURE',
  'INSTRUMENTATION_FAILURE',
  'INTERNAL_ERROR',
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

export type PipelineStage =
  | 'discovery'
  | 'jd'
  | 'match'
  | 'artifacts'
  | 'browser'
  | 'navigation'
  | 'form'
  | 'questions'
  | 'uploads'
  | 'validation'
  | 'journal'
  | 'submit'
  | 'confirmation'
  | 'persistence'
  | 'excel';

export interface FailureClassification {
  code: FailureCode;
  stage: PipelineStage;
  /** Short, human-readable explanation suitable for chat. */
  summary: string;
  /** Whether an automatic retry is safe without a human (still journal-gated). */
  retryableWithoutHuman: boolean;
  /** True when the failure is provably before any Submit click. */
  preSubmit: boolean;
}

interface Rule {
  code: FailureCode;
  stage: PipelineStage;
  test: RegExp;
  retryableWithoutHuman: boolean;
  preSubmit: boolean;
  summary: string;
}

/**
 * Ordered rules — the first match wins, so specific challenges (login/CAPTCHA/MFA)
 * are matched before generic submission transport problems.
 */
const RULES: Rule[] = [
  { code: 'LOGIN_REQUIRED', stage: 'form', test: /login required|sign in to (view|apply)|session expired|credentials wall|password field/i, retryableWithoutHuman: false, preSubmit: true, summary: 'the application needs the user to sign in' },
  { code: 'CAPTCHA_REQUIRED', stage: 'submit', test: /captcha|recaptcha (widget|challenge)|hcaptcha|turnstile|bot challenge|human verification/i, retryableWithoutHuman: false, preSubmit: true, summary: 'a CAPTCHA/human-verification step must be solved by the user' },
  { code: 'MFA_REQUIRED', stage: 'form', test: /\bmfa\b|two[- ]factor|one-time-code|\botp\b|authenticator app/i, retryableWithoutHuman: false, preSubmit: true, summary: 'multi-factor authentication is required' },
  { code: 'RATE_LIMITED', stage: 'discovery', test: /rate limit|too many requests|\b429\b|cooldown/i, retryableWithoutHuman: true, preSubmit: true, summary: 'the source is throttling; the pipeline is paused, not hammering' },
  { code: 'DUPLICATE_BLOCKED', stage: 'journal', test: /duplicate|already has an application|resubmission is refused/i, retryableWithoutHuman: false, preSubmit: true, summary: 'duplicate protection refused another submission' },
  { code: 'QUESTION_ESCALATION', stage: 'questions', test: /paused for .*question|escalation|unanswered required question|timed out with required/i, retryableWithoutHuman: false, preSubmit: true, summary: 'waiting for the user to answer questions that must not be guessed' },
  { code: 'ATTACHMENT_FAILURE', stage: 'uploads', test: /attachment|resume\/cv is required|cover letter|upload (?:rejected|failed)|not committed/i, retryableWithoutHuman: false, preSubmit: true, summary: 'an attachment was not committed by the ATS' },
  { code: 'VALIDATION_FAILURE', stage: 'validation', test: /form validation failed|required field empty/i, retryableWithoutHuman: false, preSubmit: true, summary: 'form validation failed before submission' },
  { code: 'CONFIRMATION_FAILURE', stage: 'confirmation', test: /no confirmation|confirmation (?:id )?(?:not )?(?:found|detected)|uncertain - needs verification/i, retryableWithoutHuman: false, preSubmit: false, summary: 'submitted but confirmation could not be observed' },
  { code: 'SUBMISSION_UNKNOWN', stage: 'submit', test: /submission unknown/i, retryableWithoutHuman: false, preSubmit: false, summary: 'a Submit click happened and the outcome is unknown' },
  { code: 'SUBMISSION_TRANSPORT_FAILURE', stage: 'submit', test: /submission failed|no submit button|network error|request failed/i, retryableWithoutHuman: false, preSubmit: false, summary: 'the submission transport failed' },
  { code: 'JD_FAILURE', stage: 'jd', test: /\bjd\b|job description|extraction/i, retryableWithoutHuman: true, preSubmit: true, summary: 'job description retrieval/verification failed' },
  { code: 'ARTIFACT_FAILURE', stage: 'artifacts', test: /resume generation|cover letter|artifact|pdf/i, retryableWithoutHuman: true, preSubmit: true, summary: 'artifact generation failed' },
  { code: 'DISCOVERY_FAILURE', stage: 'discovery', test: /discover|no jobs|source (?:failure|error)/i, retryableWithoutHuman: true, preSubmit: true, summary: 'discovery failed' },
  { code: 'DB_FAILURE', stage: 'persistence', test: /sqlite|database|constraint failed|repository/i, retryableWithoutHuman: false, preSubmit: false, summary: 'database persistence failed' },
  { code: 'EXCEL_FAILURE', stage: 'excel', test: /excel|workbook|sync/i, retryableWithoutHuman: true, preSubmit: false, summary: 'Excel synchronisation failed' },
  { code: 'JOURNAL_FAILURE', stage: 'journal', test: /journal/i, retryableWithoutHuman: false, preSubmit: true, summary: 'the submission journal could not be written' },
  { code: 'INSTRUMENTATION_FAILURE', stage: 'submit', test: /instrumentation|listener/i, retryableWithoutHuman: false, preSubmit: false, summary: 'observability instrumentation failed' },
];

const STAGE_DEFAULT: Record<PipelineStage, FailureCode> = {
  discovery: 'DISCOVERY_FAILURE',
  jd: 'JD_FAILURE',
  match: 'INTERNAL_ERROR',
  artifacts: 'ARTIFACT_FAILURE',
  browser: 'FORM_FAILURE',
  navigation: 'FORM_FAILURE',
  form: 'FORM_FAILURE',
  questions: 'QUESTION_ESCALATION',
  uploads: 'ATTACHMENT_FAILURE',
  validation: 'VALIDATION_FAILURE',
  journal: 'JOURNAL_FAILURE',
  submit: 'SUBMISSION_TRANSPORT_FAILURE',
  confirmation: 'CONFIRMATION_FAILURE',
  persistence: 'DB_FAILURE',
  excel: 'EXCEL_FAILURE',
};

/**
 * Classify a failure. `stage` anchors the result (first failing stage) and the
 * error text refines it — an error without a stage is an internal error rather
 * than a guessed category.
 */
export function classifyFailure(input: { stage: PipelineStage; error: string }): FailureClassification {
  const text = input.error ?? '';
  for (const rule of RULES) {
    if (rule.stage === input.stage || input.stage === 'form' || input.stage === 'submit' || input.stage === 'questions') {
      if (rule.test.test(text)) {
        return { code: rule.code, stage: rule.stage, summary: rule.summary, retryableWithoutHuman: rule.retryableWithoutHuman, preSubmit: rule.preSubmit };
      }
    }
  }
  const code = STAGE_DEFAULT[input.stage];
  const rule = RULES.find(r => r.code === code);
  return {
    code,
    stage: input.stage,
    summary: rule?.summary ?? 'unclassified failure',
    retryableWithoutHuman: rule?.retryableWithoutHuman ?? false,
    preSubmit: rule?.preSubmit ?? false,
  };
}

/** Chat-friendly one-liner: WHAT happened / WHY / WHAT the agent did. */
export function explainFailure(c: FailureClassification, context: { applicationId?: string; jobId?: string } = {}): string {
  const who = context.jobId ? ` (${context.jobId})` : context.applicationId ? ` (${context.applicationId})` : '';
  const what = `FAILED at ${c.stage.toUpperCase()} — ${c.summary}`;
  const why = `Reason: ${c.code}.`;
  const did = c.retryableWithoutHuman
    ? 'Action: safe to retry automatically (still gated by the submission journal).'
    : c.preSubmit
      ? 'Action: needs human input before anything is retried.'
      : 'Action: automatic retry refused — a click may already have reached the employer.';
  return `${what}${who}\n${why}\n${did}`;
}