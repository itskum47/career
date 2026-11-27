/**
 * Phase 6X — Duplicate application protection.
 *
 * Before EVERY real application, check whether the canonical job already has
 * an application in SUBMITTED / CONFIRMED / APPLIED / IN_PROGRESS-equivalent
 * state. If yes: DO NOT APPLY AGAIN.
 *
 * Multiple portal listings resolving to the same canonical job = ONE
 * application opportunity (matched via jobs.canonical_key / application_url,
 * not just job_id).
 *
 * Placement: this guard runs at the APPLICATION ENTRY POINTS (CLI, worker,
 * discovery-orchestrator queue consumer) — NOT inside ApplicationEngine, so
 * controlled tests that deliberately drive the engine twice remain valid
 * while every real pipeline submission is protected.
 */

import type { JobId, CandidateId, Application } from '../core/types.ts';
import { ApplicationRepository } from '../database/repositories.ts';
import { logger } from '../core/logger.ts';
import { CLICK_BEARING_PHASES } from './submission-journal.ts';

export interface DuplicateCheckInput {
  appRepo: ApplicationRepository;
  jobId: JobId;
  candidateId: CandidateId;
  /** Canonical identity from 6F (preferred match axis). */
  canonicalKey?: string;
  /** Canonical application URL from 6G (secondary match axis). */
  applicationUrl?: string;
  /**
   * Phase 6W/6X — durable submission journal. A click-bearing journal entry
   * blocks a second click EVEN when the application row does not exist, which is
   * exactly the crash case that previously erased all knowledge of a real click
   * (APP-20261008-000099, one real click at 10:41:03.612).
   */
  submissionJournal?: SubmissionJournalLike | SubmissionJournalLike[];
}

export interface SubmissionJournalLike {
  hasClickBearingAttempt(jobId: string, phases: readonly string[]): Promise<{ phase: string; applicationId: string; createdAt?: string } | null>;
}

export interface DuplicateCheckResult {
  blocked: boolean;
  reason?: string;
  existing?: Application;
  /** Which axis caught the duplicate: job_id | canonical_key | application_url. */
  matchedOn?: 'job_id' | 'canonical_key' | 'application_url';
}

/**
 * Non-throwing pre-flight. Returns blocked=true when a second application
 * must NOT be created.
 */
export async function preflightDuplicateCheck(
  input: DuplicateCheckInput
): Promise<DuplicateCheckResult> {
  const { appRepo, jobId, candidateId } = input;

  // Axis 0 (Phase 6W/6X): the durable submission journal. Runs FIRST because it
  // is the only source of truth when a crash lost the application row. Several
  // journals may be supplied (DB + file): ANY of them can block, so protection
  // survives a lost or reset database.
  const journals = input.submissionJournal
    ? (Array.isArray(input.submissionJournal) ? input.submissionJournal : [input.submissionJournal])
    : [];
  for (const journal of journals) {
    try {
      const attempt = await journal.hasClickBearingAttempt(String(jobId), CLICK_BEARING_PHASES);
      if (attempt) {
        return {
          blocked: true,
          reason: `job ${jobId} has a recorded submission attempt (journal phase=${attempt.phase}, application=${attempt.applicationId}) — a Submit click may already have reached the ATS; automatic resubmission is refused`,
        };
      }
    } catch (error) {
      logger.error('Submission journal check failed — blocking to stay safe', { jobId, error: String(error) });
      return { blocked: true, reason: `submission journal check error: ${String(error)}` };
    }
  }

  // Axis 1: exact job id.
  try {
    const byJob = await appRepo.findBlockingApplication(jobId, candidateId);
    if (byJob) {
      return {
        blocked: true,
        reason: `job ${jobId} already has application ${byJob.applicationId} in state ${byJob.state}/${byJob.status}`,
        existing: byJob,
        matchedOn: 'job_id',
      };
    }
  } catch (error) {
    logger.error('Duplicate check failed (job_id axis) — blocking to stay safe', { jobId, error: String(error) });
    return { blocked: true, reason: `duplicate check error: ${String(error)}` };
  }

  // Axis 2/3: canonical identity across portal listings.
  if (input.canonicalKey || input.applicationUrl) {
    try {
      const byCanonical = await appRepo.findBlockingApplicationByCanonical(
        input.canonicalKey, input.applicationUrl, candidateId
      );
      if (byCanonical) {
        const matchedOn = input.canonicalKey ? 'canonical_key' : 'application_url';
        return {
          blocked: true,
          reason: `canonical job (${matchedOn}=${input.canonicalKey ?? input.applicationUrl}) already has application ${byCanonical.applicationId} in state ${byCanonical.state}/${byCanonical.status}`,
          existing: byCanonical,
          matchedOn,
        };
      }
    } catch (error) {
      logger.error('Duplicate check failed (canonical axis) — blocking to stay safe', {
        canonicalKey: input.canonicalKey, error: String(error),
      });
      return { blocked: true, reason: `duplicate check error: ${String(error)}` };
    }
  }

  return { blocked: false };
}

/** Throwing wrapper for call sites that must abort the run. */
export async function assertNoDuplicateApplication(
  input: DuplicateCheckInput
): Promise<void> {
  const result = await preflightDuplicateCheck(input);
  if (result.blocked) {
    logger.warn('Duplicate application blocked (6X)', {
      jobId: String(input.jobId),
      matchedOn: result.matchedOn,
      reason: result.reason,
    });
    throw new DuplicateApplicationError(result.reason ?? 'duplicate application blocked', result);
  }
}

export class DuplicateApplicationError extends Error {
  readonly check: DuplicateCheckResult;
  constructor(message: string, check: DuplicateCheckResult) {
    super(message);
    this.name = 'DuplicateApplicationError';
    this.check = check;
  }
}
