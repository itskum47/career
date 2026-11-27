/**
 * Application Engine types.
 */

export type ApplicationState =
  | 'DISCOVERED'
  | 'VERIFIED'
  | 'ANALYZED'
  | 'MATCHED'
  | 'SKIPPED'
  | 'RESUME_GENERATED'
  | 'RESUME_VALIDATED'
  | 'READY_TO_APPLY'
  | 'BROWSER_STARTED'
  | 'FORM_ANALYZING'
  | 'FORM_FILLING'
  | 'PAUSED_FOR_USER'
  | 'READY_TO_SUBMIT'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'REJECTED'
  | 'INTERVIEW'
  | 'ASSESSMENT'
  | 'OFFER'
  | 'WITHDRAWN'
  | 'BLOCKED'
  | 'SUBMISSION_UNCERTAIN'
  | 'ERROR';

export type ApplicationStatus =
  | 'pending'
  | 'in_progress'
  | 'submitted'
  | 'confirmed'
  | 'rejected'
  | 'interviewing'
  | 'assessment'
  | 'offer'
  | 'withdrawn'
  | 'paused'
  | 'blocked'
  | 'error'
  | 'skipped';

export interface Application {
  applicationId: string;
  jobId: string;
  candidateId: string;
  companyId: string;
  state: ApplicationState;
  status: ApplicationStatus;
  resumeId?: string;
  coverLetterId?: string;
  browserSessionId?: string;
  confirmationId?: string;
  submittedAt?: Date;
  confirmedAt?: Date;
  error?: string;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
  nextAction?: string;
  nextActionAt?: Date;
}

export interface ApplicationEvent {
  eventId: string;
  applicationId: string;
  type: ApplicationEventType;
  fromState?: ApplicationState;
  toState: ApplicationState;
  agent?: string;
  message: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

export type ApplicationEventType =
  | 'state_transition'
  | 'agent_started'
  | 'agent_completed'
  | 'agent_failed'
  | 'human_escalation'
  | 'user_answer_received'
  | 'form_field_filled'
  | 'field_fill_failed'
  | 'document_uploaded'
  | 'submission_attempted'
  | 'submission_confirmed'
  | 'submission_failed'
  | 'email_received'
  | 'status_changed'
  | 'retry'
  | 'recovery';

export interface ApplicationQuestion {
  questionId: string;
  applicationId: string;
  question: string;
  type: 'text' | 'select' | 'multiselect' | 'boolean' | 'file' | 'number' | 'date';
  required: boolean;
  options?: string[];
  category: 'personal' | 'experience' | 'skills' | 'education' | 'authorization' | 'compensation' | 'legal' | 'behavioral' | 'technical' | 'other';
  classification: 'KNOWN' | 'DERIVABLE' | 'USER_REQUIRED' | 'UNSAFE_TO_GUESS';
  answer?: QuestionAnswer;
  askedAt: Date;
  answeredAt?: Date;
}

export interface QuestionAnswer {
  value: string;
  source: 'profile' | 'derived' | 'user-provided' | 'default' | 'cached';
  confidence: number;
  providedBy?: 'user' | 'agent' | 'cached';
}

export interface ApplicationInput {
  jobDescription: any; // JobDescription
  matchAnalysis: any; // MatchAnalysis
  resume: any; // ResumeVersion
  coverLetter?: any; // CoverLetter
  autoSubmit?: boolean;
}

export interface ApplicationResult {
  application: Application;
  success: boolean;
  error?: string;
  events: ApplicationEvent[];
  /**
   * Phase 6K/6L: true when the run PAUSED_FOR_USER at a login/CAPTCHA/MFA/
   * bot-challenge wall. State (URL, screenshot, browser state, job, source)
   * is saved and the SAME session resumes after the user completes the step.
   */
  pausedForUser?: boolean;
}

export interface ApplicationEngineConfig {
  maxRetries: number;
  retryDelayMs: number;
  pauseOnUncertain: boolean;
  verifySubmission: boolean;
  submissionTimeoutMs: number;
}

export interface HumanEscalationRequest {
  applicationId: string;
  question: string;
  context: string;
  options?: string[];
  category: 'legal' | 'authorization' | 'compensation' | 'technical' | 'personal' | 'other';
  urgency: 'low' | 'medium' | 'high' | 'critical';
}

export interface HumanEscalationResponse {
  applicationId: string;
  answer: string;
  answeredBy: 'user' | 'cached';
  timestamp: Date;
}

export interface QuestionClassifierResult {
  classification: 'KNOWN' | 'DERIVABLE' | 'USER_REQUIRED' | 'UNSAFE_TO_GUESS';
  confidence: number;
  suggestedAnswer?: string;
  source?: string;
}
