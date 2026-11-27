/**
 * Unit tests for core modules.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { generateJobId, generateApplicationId, generateCandidateId, generateCompanyId, generateEventId } from '@job-agent/core/ids.js';
import { JobAgentError, ValidationError, DatabaseError, BrowserError, LLMAPIError, LLMResponseError, RateLimitError, HumanEscalationError, NotFoundError, FormError, NavigationError, SubmissionError, VerificationError, JDVerificationError, FabricationError, ConfigurationError, isRecoverableError, getErrorCode } from '@job-agent/core/errors.js';
import { logger, createChildLogger } from '@job-agent/core/logger.js';

describe('ID Generation', () => {
  it('should generate unique job IDs', () => {
    const id1 = generateJobId('linkedin', 'Acme', 'DevOps Engineer');
    const id2 = generateJobId('linkedin', 'Acme', 'DevOps Engineer');
    expect(id1).not.toBe(id2);
    expect(id1.startsWith('JOB-')).toBe(true);
    expect(id2.startsWith('JOB-')).toBe(true);
  });

  it('should generate unique application IDs', () => {
    const id1 = generateApplicationId('JOB-123' as any);
    const id2 = generateApplicationId('JOB-456' as any);
    expect(id1).not.toBe(id2);
    expect(id1.startsWith('APP-')).toBe(true);
  });

  it('should generate unique candidate IDs', () => {
    const id1 = generateCandidateId();
    const id2 = generateCandidateId();
    expect(id1).not.toBe(id2);
    expect(id1.startsWith('CAND-')).toBe(true);
  });

  it('should generate unique company IDs', () => {
    const id1 = generateCompanyId('Acme Corp');
    const id2 = generateCompanyId('Acme Corp');
    expect(id1).not.toBe(id2);
    expect(id1.startsWith('COMP-')).toBe(true);
  });

  it('should generate unique event IDs', () => {
    const id1 = generateEventId();
    const id2 = generateEventId();
    expect(id1).not.toBe(id2);
    expect(id1.startsWith('EVT-')).toBe(true);
  });
});

describe('Error Classes', () => {
  it('should create JobAgentError with message and code', () => {
    const error = new JobAgentError('TEST_ERROR', 'Test error');
    expect(error.message).toBe('Test error');
    expect(error.code).toBe('TEST_ERROR');
    expect(error.name).toBe('JobAgentError');
  });

  it('should create ValidationError', () => {
    const error = new ValidationError('Invalid input');
    expect(error.message).toBe('Invalid input');
    expect(error.code).toBe('VALIDATION_ERROR');
  });

  it('should create DatabaseError', () => {
    const error = new DatabaseError('DB connection failed');
    expect(error.code).toBe('DATABASE_ERROR');
  });

  it('should create BrowserError', () => {
    const error = new BrowserError('BROWSER_ERROR', 'Navigation failed');
    expect(error.code).toBe('BROWSER_ERROR');
  });

  it('should create LLMAPIError', () => {
    const error = new LLMAPIError('API call failed');
    expect(error.code).toBe('LLM_API_ERROR');
  });

  it('should create LLMResponseError', () => {
    const error = new LLMResponseError('Bad response');
    expect(error.code).toBe('LLM_RESPONSE_ERROR');
  });

  it('should create RateLimitError', () => {
    const error = new RateLimitError('Rate limited', 5000);
    expect(error.code).toBe('RATE_LIMIT');
    expect(error.retryAfterMs).toBe(5000);
  });

  it('should create HumanEscalationError', () => {
    const error = new HumanEscalationError('Needs human input');
    expect(error.code).toBe('HUMAN_ESCALATION');
  });

  it('should create NotFoundError', () => {
    const error = new NotFoundError('Job', 'JOB-123');
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toContain('Job not found: JOB-123');
  });

  it('should create FormError', () => {
    const error = new FormError('Form validation failed');
    expect(error.code).toBe('FORM_ERROR');
  });

  it('should create NavigationError', () => {
    const error = new NavigationError('Page not found');
    expect(error.code).toBe('NAVIGATION_ERROR');
  });

  it('should create SubmissionError', () => {
    const error = new SubmissionError('Submit failed');
    expect(error.code).toBe('SUBMISSION_ERROR');
  });

  it('should create VerificationError', () => {
    const error = new VerificationError('Verification failed');
    expect(error.code).toBe('VERIFICATION_ERROR');
  });

  it('should create JDVerificationError', () => {
    const error = new JDVerificationError('JD verification failed');
    expect(error.code).toBe('JD_VERIFICATION_ERROR');
  });

  it('should create FabricationError', () => {
    const error = new FabricationError('Fabricated data');
    expect(error.code).toBe('FABRICATION_ERROR');
  });

  it('should create ConfigurationError', () => {
    const error = new ConfigurationError('Bad config');
    expect(error.code).toBe('CONFIGURATION_ERROR');
  });
});

describe('Error Helpers', () => {
  it('should identify recoverable errors', () => {
    const recoverable = new DatabaseError('DB error');
    const nonRecoverable = new ValidationError('Validation error');

    expect(isRecoverableError(recoverable)).toBe(true);
    expect(isRecoverableError(nonRecoverable)).toBe(false);
  });

  it('should get error code', () => {
    const error = new LLMAPIError('API error');
    expect(getErrorCode(error)).toBe('LLM_API_ERROR');
  });
});

describe('Logger', () => {
  it('should create a child logger', () => {
    const childLogger = createChildLogger({ component: 'test' });
    expect(childLogger).toBeDefined();
    expect(typeof childLogger.info).toBe('function');
    expect(typeof childLogger.error).toBe('function');
    expect(typeof childLogger.warn).toBe('function');
    expect(typeof childLogger.debug).toBe('function');
  });

  it('should have logger with all methods', () => {
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });
});