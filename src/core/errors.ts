/**
 * Structured error types for the job-agent system.
 */

export class JobAgentError extends Error {
  public readonly code: string;
  public readonly recoverable: boolean;
  public readonly context: Record<string, unknown>;
  public readonly timestamp: Date;

  constructor(code: string, message: string, options: { recoverable?: boolean; context?: Record<string, unknown> } = {}) {
    super(message);
    this.name = 'JobAgentError';
    this.code = code;
    this.recoverable = options.recoverable ?? false;
    this.context = options.context ?? {};
    this.timestamp = new Date();

    // Maintains proper stack trace in V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, JobAgentError);
    }
  }
}

export class ConfigurationError extends JobAgentError {
  constructor(message: string, context?: Record<string, unknown>) {
    super('CONFIGURATION_ERROR', message, { recoverable: false, context });
    this.name = 'ConfigurationError';
  }
}

export class LLMAPIError extends JobAgentError {
  constructor(message: string, context?: Record<string, unknown>) {
    super('LLM_API_ERROR', message, { recoverable: true, context });
    this.name = 'LLMAPIError';
  }
}

export class LLMResponseError extends JobAgentError {
  constructor(message: string, context?: Record<string, unknown>) {
    super('LLM_RESPONSE_ERROR', message, { recoverable: true, context });
    this.name = 'LLMResponseError';
  }
}

export class DatabaseError extends JobAgentError {
  constructor(message: string, context?: Record<string, unknown>) {
    super('DATABASE_ERROR', message, { recoverable: true, context });
    this.name = 'DatabaseError';
  }
}

export class BrowserError extends JobAgentError {
  constructor(code: string, message: string, context?: Record<string, unknown>) {
    super(code, message, { recoverable: true, context });
    this.name = 'BrowserError';
  }
}

export class NavigationError extends BrowserError {
  constructor(message: string, context?: Record<string, unknown>) {
    super('NAVIGATION_ERROR', message, context);
    this.name = 'NavigationError';
  }
}

export class FormError extends BrowserError {
  constructor(message: string, context?: Record<string, unknown>) {
    super('FORM_ERROR', message, context);
    this.name = 'FormError';
  }
}

export class FileUploadError extends BrowserError {
  constructor(message: string, context?: Record<string, unknown>) {
    super('FILE_UPLOAD_ERROR', message, context);
    this.name = 'FileUploadError';
  }
}

export class SubmissionError extends JobAgentError {
  constructor(message: string, context?: Record<string, unknown>) {
    super('SUBMISSION_ERROR', message, { recoverable: true, context });
    this.name = 'SubmissionError';
  }
}

export class VerificationError extends JobAgentError {
  constructor(message: string, context?: Record<string, unknown>) {
    super('VERIFICATION_ERROR', message, { recoverable: true, context });
    this.name = 'VerificationError';
  }
}

export class JDVerificationError extends JobAgentError {
  constructor(message: string, context?: Record<string, unknown>) {
    super('JD_VERIFICATION_ERROR', message, { recoverable: true, context });
    this.name = 'JDVerificationError';
  }
}

export class FabricationError extends JobAgentError {
  constructor(message: string, context?: Record<string, unknown>) {
    super('FABRICATION_ERROR', message, { recoverable: false, context });
    this.name = 'FabricationError';
  }
}

export class HumanEscalationError extends JobAgentError {
  constructor(message: string, context?: Record<string, unknown>) {
    super('HUMAN_ESCALATION', message, { recoverable: false, context });
    this.name = 'HumanEscalationError';
  }
}

export class RateLimitError extends JobAgentError {
  public readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number, context?: Record<string, unknown>) {
    super('RATE_LIMIT', message, { recoverable: true, context });
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class NotFoundError extends JobAgentError {
  constructor(resource: string, identifier: string) {
    super('NOT_FOUND', `${resource} not found: ${identifier}`, { recoverable: false, context: { resource, identifier } });
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends JobAgentError {
  constructor(message: string, context?: Record<string, unknown>) {
    super('VALIDATION_ERROR', message, { recoverable: false, context });
    this.name = 'ValidationError';
  }
}

export function isRecoverableError(error: unknown): boolean {
  return error instanceof JobAgentError && error.recoverable;
}

export function getErrorCode(error: unknown): string {
  if (error instanceof JobAgentError) return error.code;
  if (error instanceof Error) return 'UNKNOWN_ERROR';
  return 'NON_ERROR_THROWN';
}
