/**
 * Application Engine - orchestrates the full application process.
 */

import type { ApplicationInput, ApplicationResult, Application, ApplicationState, ApplicationEvent, ApplicationQuestion, HumanEscalationRequest, HumanEscalationResponse } from './types.ts';
import type { JobDescription } from '../jd/types.ts';
import type { MatchAnalysis } from '../match/types.ts';
import type { ResumeVersion, CoverLetter } from '../core/types.ts';
import type { BrowserSession } from '../browser/types.ts';
import type { Page } from 'playwright';
import type { MasterProfile } from '../core/types.ts';
import * as fsSync from 'fs';
import { BrowserController } from '../browser/controller.ts';
import { QuestionClassifier } from './question-classifier.ts';
import { generateApplicationId, generateEventId } from '../core/ids.ts';
import { logger } from '../core/logger.ts';
import type { AttachmentUploadResult, FileInputMeta } from '../browser/types.ts';
import type { ElementHandle } from 'playwright';
import {
  FileSubmissionJournal,
  type SubmissionJournalEntry,
  type SubmissionJournalPhase,
  type SubmissionJournalSink,
} from './submission-journal.ts';
import type { SubmissionJournalRepository as SubmissionJournalDbSink } from '../database/repositories.ts';
import { evaluateApproval, renderApprovalRequest, type ApprovalRequest } from './approval-gate.ts';
import { awaitOperatorApproval, consumeOperatorApproval } from './operator-approval.ts';
import {
  realSubmissionLock,
  profileProfileVersion,
  assertArtifactUsable,
  detectFabricatedClaims,
  isRealAtsTarget,
  type SubmissionLockState,
} from '../profile/profile-integrity.ts';
import { fileStorage } from '../shared/storage.ts';
import { config } from '../core/config.ts';
import { getEscalationManager, createEscalationManager } from '../escalation/index.ts';
import type { EscalationRecord } from '../escalation/types.ts';
import { performanceCollector, startTimer } from '../performance/index.ts';
import { STAGES } from '../performance/stages.ts';
import {
  detectChallengeFromHtml,
  saveChallengePause,
  CHALLENGE_INSTRUCTIONS,
  type ChallengeKind,
} from './challenge-guard.ts';

export class ApplicationEngine {
  private browserController: BrowserController;
  private questionClassifier: QuestionClassifier;
  private escalationManager: ReturnType<typeof createEscalationManager>;
  private pendingEscalations: Map<string, HumanEscalationRequest> = new Map();
  private escalationResponses: Map<string, HumanEscalationResponse> = new Map();
  /**
   * Phase 6W/6X — durable submission journal. Defaults to the filesystem sink so
   * a real Submit click is ALWAYS recorded before it happens, even when the
   * caller persists nothing (measured failure: APP-20261008-000099, one real
   * click at 10:41:03.612 followed by a crash left no trace anywhere).
   */
  private submissionJournal: SubmissionJournalSink;
  /** Optional DB sink, so the database itself knows a click was started. */
  private submissionJournalDb: SubmissionJournalDbSink | null = null;

  constructor(
    browserConfig?: Partial<import('../browser/types.ts').BrowserConfig>,
    options?: { submissionJournal?: SubmissionJournalSink; submissionJournalDb?: SubmissionJournalDbSink }
  ) {
    this.browserController = new BrowserController(browserConfig);
    this.questionClassifier = new QuestionClassifier();
    this.escalationManager = createEscalationManager();
    this.submissionJournal = options?.submissionJournal ?? new FileSubmissionJournal();
    this.submissionJournalDb = options?.submissionJournalDb ?? null;
  }

  /**
   * Persist "a Submit click is about to happen" BEFORE the irreversible click.
   * Synchronous file write first (survives an immediate kill), then the DB sink.
   * Never throws: a journal failure must not abort the application, but it is
   * logged loudly.
   */
  private async journalSubmission(
    phase: SubmissionJournalPhase,
    applicationId: string,
    jobId: string,
    extra: Partial<SubmissionJournalEntry> = {}
  ): Promise<void> {
    const entry: SubmissionJournalEntry = {
      applicationId: applicationId as string,
      jobId: jobId as string,
      candidateId: extra.candidateId,
      companyId: extra.companyId,
      applicationRoute: extra.applicationRoute,
      atsType: extra.atsType,
      phase,
      method: extra.method,
      host: extra.host,
      path: extra.path,
      status: extra.status,
      resourceType: extra.resourceType ?? undefined,
      elapsedMs: extra.elapsedMs,
      sessionId: extra.sessionId,
      detail: extra.detail,
    };
    try {
      const composite = this.submissionJournal as unknown as { appendSync?: (e: SubmissionJournalEntry) => void };
      if (typeof composite.appendSync === 'function') composite.appendSync(entry);
      else await this.submissionJournal.append(entry);
    } catch (error) {
      logger.error('Submission journal write failed', { phase, applicationId, jobId, error: String(error) });
    }
    if (this.submissionJournalDb) {
      try {
        await this.submissionJournalDb.append({
          entryId: `${applicationId}-${phase}-${Date.now()}`,
          applicationId: entry.applicationId,
          jobId: entry.jobId,
          candidateId: entry.candidateId,
          companyId: entry.companyId,
          applicationRoute: entry.applicationRoute,
          atsType: entry.atsType,
          phase,
          method: entry.method,
          host: entry.host,
          path: entry.path,
          status: entry.status,
          resourceType: entry.resourceType ?? undefined,
          elapsedMs: entry.elapsedMs,
          sessionId: entry.sessionId,
          detail: entry.detail,
        });
      } catch (error) {
        logger.error('Submission journal DB write failed', { phase, applicationId, error: String(error) });
      }
    }
  }

  async initialize(): Promise<void> {
    await this.browserController.initialize();
    await this.escalationManager.initialize();
  }

  async processApplication(input: ApplicationInput, profile: MasterProfile): Promise<ApplicationResult> {
    const { jobDescription, matchAnalysis, resume, coverLetter, autoSubmit = config.application.autoSubmit } = input;
    
    const applicationId = generateApplicationId(jobDescription.jobId);
    const events: ApplicationEvent[] = [];

    // ==========================================================================
    // PHASE 9 — REAL-SUBMISSION LOCK (the first thing that runs, before any
    // browser work, any file upload and any journalled intent).
    //
    // The master profile is candidate data. Until the operator explicitly
    // approves the ACTIVE profile version (a sha256 content hash), no real
    // submission may start: not a form fill, not an upload, not a click. Editing
    // the profile re-locks everything by changing that hash.
    //
    // The only exemption is the local fake ATS used by the regression suite —
    // see isRealAtsTarget(), which treats anything not recognisably local as real.
    // ==========================================================================
    const targetUrl = (jobDescription as any).url ?? (jobDescription as any).applyUrl;
    if (isRealAtsTarget(targetUrl)) {
      const profileLock = this.checkSubmissionLock(applicationId, jobDescription, events, profile);
      if (profileLock) {
        logger.error('Real submission blocked by the profile lock', {
          applicationId,
          jobId: String(jobDescription.jobId),
          reason: profileLock.error,
          profileVersion: (profileLock as any).application?.profileVersion,
        });
        return profileLock;
      }
    } else {
      logger.info('Non-real (sandbox) application target — submission lock not enforced for this run', {
        applicationId,
        targetUrl,
      });
    }

    // Artifact staleness: a document generated from an older (or withdrawn)
    // profile version must never reach an ATS.
    const staleness = this.checkArtifactStaleness(resume, coverLetter);
    if (staleness) {
      logger.error('Stale or invalidated artifact blocked', { applicationId, jobId: String(jobDescription.jobId), problems: staleness });
      const now = new Date();
      const application: any = {
        applicationId,
        jobId: jobDescription.jobId,
        candidateId: profile?.candidateId ?? 'CAND-UNKNOWN',
        companyId: (jobDescription as any).companyId ?? jobDescription.company ?? 'UNKNOWN',
        state: 'ERROR',
        status: 'error',
        error: `Artifact integrity gate failed: ${staleness.join('; ')}`,
        notes: `blocked_by_artifact_staleness: ${staleness.join('; ')}`,
        nextAction: 'Regenerate the CV and cover letter from the active profile version',
        startedAt: now,
        createdAt: now,
        updatedAt: now,
        submissionState: 'blocked_by_profile_lock',
      };
      events.push(this.createEvent(applicationId, 'submission_failed', 'FORM_FILLING', 'ERROR', application.error));
      return { application, success: false, error: application.error, events };
    }
    
    // Start overall application timer
    const appTimer = startTimer({ stage: STAGES.APPLICATION_TOTAL, applicationId: applicationId as string, jobId: jobDescription.jobId as string });

    logger.info('Starting application process', { 
      applicationId, 
      jobId: jobDescription.jobId,
      company: jobDescription.company,
      title: jobDescription.title 
    });

    // Create application record
    const application: Application = {
      applicationId: applicationId as any,
      jobId: jobDescription.jobId,
      candidateId: (profile?.candidateId as any) ?? ('CAND-001' as any),
      companyId: 'COMP-001' as any, // Would come from company
      state: 'DISCOVERED',
      status: 'pending',
      resumeId: resume.resumeId,
      coverLetterId: coverLetter?.coverLetterId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // State: READY_TO_APPLY
    application.state = 'READY_TO_APPLY';
    application.status = 'in_progress';
    events.push(this.createEvent(applicationId, 'state_transition', 'DISCOVERED', 'READY_TO_APPLY', 'Application ready to start'));

    // State: BROWSER_STARTED
    application.state = 'BROWSER_STARTED';
    events.push(this.createEvent(applicationId, 'state_transition', 'READY_TO_APPLY', 'BROWSER_STARTED', 'Browser session started'));

    // Create browser session
    const browserSession = await this.browserController.createSession(applicationId, jobDescription.jobId, jobDescription.url);

    // Navigate to application URL
    const navResult = await this.browserController.navigate(jobDescription.url);
    if (!navResult.success) {
      application.state = 'ERROR';
      application.status = 'error';
      application.error = `Navigation failed: ${navResult.error}`;
      events.push(this.createEvent(applicationId, 'state_transition', 'BROWSER_STARTED', 'ERROR', `Navigation failed: ${navResult.error}`));
      appTimer.end(false, navResult.error);
      return { application, success: false, error: navResult.error, events };
    }

    // Detect ATS
    const atsPlatform = await this.browserController.detectATS();
    logger.info('ATS detected', { platform: atsPlatform });

    // Phase 6K/6L checkpoint 1: login/CAPTCHA/MFA/bot wall right after landing.
    const challenge1 = await this.checkAndPauseForChallenge(
      application, applicationId, jobDescription, events, 'BROWSER_STARTED'
    );
    if (challenge1.paused) {
      appTimer.end(false, `paused_for_user:${challenge1.kind}`);
      return { application, success: false, events, pausedForUser: true };
    }

    // State: FORM_ANALYZING
    application.state = 'FORM_ANALYZING';
    events.push(this.createEvent(applicationId, 'state_transition', 'BROWSER_STARTED', 'FORM_ANALYZING', 'Analyzing application form'));

    // Capture page state and detect forms
    const pageState = await this.browserController.capturePageState();
    const forms = pageState.forms;

    // Prepare profile data for form filling (also used to decide which questions need a human)
    const profileData = this.prepareProfileData(profile, jobDescription, matchAnalysis, resume, coverLetter);

    // Classify questions using the real QuestionClassifier (only unanswerable ones pause)
    const questions = this.classifyQuestions(forms, jobDescription, profile, profileData);
    application.state = 'FORM_FILLING';
    events.push(this.createEvent(applicationId, 'state_transition', 'FORM_ANALYZING', 'FORM_FILLING', 'Filling application form'));

    // Fill known/derivable fields
    const fillTimer = startTimer({ stage: STAGES.BROWSER_FILL_FORM, applicationId: applicationId as string, jobId: jobDescription.jobId as string });
    const fillResult = await this.browserController.fillForm(forms, profileData);
    fillTimer.end(fillResult.success);
    events.push(this.createEvent(applicationId, 'form_field_filled', 'FORM_FILLING', 'FORM_FILLING', `Filled ${fillResult.filledFields} fields`));

    // Handle user-required questions
    const userQuestions = questions.filter(q =>
      q.classification === 'USER_REQUIRED' || q.classification === 'UNSAFE_TO_GUESS'
      // 6Q semantic-fallback → human escalation: a field the classifier
      // believed it could auto-answer (KNOWN) but whose fill FAILED must go
      // to the human — e.g. a Yes/No dropdown fed a profile-derived number,
      // or a required field with no matching profile data. Silently leaving
      // it empty would block submission or, worse, force a wrong value.
      || (q.classification === 'KNOWN'
        && fillResult.failedFields.some(f =>
          f.field.type !== 'hidden' && forms.indexOf(f.field) === Number(q.questionId.slice(q.questionId.lastIndexOf('-') + 1))
        ))
    );

    if (userQuestions.length > 0) {
      application.state = 'PAUSED_FOR_USER';
      events.push(this.createEvent(applicationId, 'human_escalation', 'FORM_FILLING', 'PAUSED_FOR_USER', `Paused for ${userQuestions.length} user questions`));

      // Request human input (6Q: polls the escalation store when
      // ESCALATION_WAIT_MS > 0 so answers from `escalation:answer` land).
      const { answers, timedOut } = await this.requestHumanAnswers(userQuestions, applicationId, jobDescription);

      if (timedOut) {
        // Required questions still unanswered — NEVER submit a half-filled
        // form. Stay paused; answers can still arrive via `escalation:answer`
        // and the application resumes from its saved snapshot.
        application.state = 'PAUSED_FOR_USER';
        events.push(this.createEvent(applicationId, 'state_transition', 'PAUSED_FOR_USER', 'PAUSED_FOR_USER', 'Escalation wait timed out with required questions unanswered — not submitted'));
        appTimer.end(false, 'paused awaiting user answers');
        return { application, success: false, events, pausedForUser: true };
      }

      // Fill user-provided answers (questionId is `Q-<jobId>-<formIndex>`)
      for (const answer of answers) {
        if (!answer.value) continue; // No human answer available yet - leave field untouched
        const idx = Number(answer.questionId.substring(answer.questionId.lastIndexOf('-') + 1));
        const field = Number.isFinite(idx) ? forms[idx] : forms.find(f => f.uid === answer.questionId);
        if (field) {
          try {
            await this.browserController.fillField(field, answer.value);
          } catch (err) {
            // 6Q resilience: one unfillable answer must not abort the run —
            // form validation still gates submission, so a required miss ends
            // in a non-submitted ERROR/PAUSED state, never a wrong submission.
            logger.warn('Failed to fill answered question', {
              applicationId: applicationId as string,
              questionId: answer.questionId,
              field: (field as any)?.label || (field as any)?.name || answer.questionId,
              error: err instanceof Error ? err.message : String(err),
            });
            events.push(this.createEvent(applicationId, 'field_fill_failed', 'FORM_FILLING', 'FORM_FILLING', `Answer for ${answer.questionId} could not be filled: ${err instanceof Error ? err.message : String(err)}`));
          }
        }
      }

      application.state = 'FORM_FILLING';
      events.push(this.createEvent(applicationId, 'user_answer_received', 'PAUSED_FOR_USER', 'FORM_FILLING', 'User answers received, continuing'));
    }

    // Upload documents
    const uploadTimer = startTimer({ stage: STAGES.BROWSER_UPLOAD, applicationId: applicationId as string, jobId: jobDescription.jobId as string });
    const attachments = await this.uploadDocuments(resume, coverLetter, jobDescription);
    uploadTimer.end(attachments.resume?.committed || attachments.coverLetter?.committed || false);

    // Validate form before submission
    const validationTimer = startTimer({ stage: STAGES.BROWSER_VALIDATION, applicationId: applicationId as string, jobId: jobDescription.jobId as string });
    const validation = await this.validateForm();
    validationTimer.end(validation.valid);
    if (!validation.valid) {
      application.state = 'ERROR';
      application.status = 'error';
      application.error = `Form validation failed: ${validation.errors.join(', ')}`;
      appTimer.end(false, application.error);
      return { application, success: false, error: application.error, events };
    }

    // State: READY_TO_SUBMIT
    application.state = 'READY_TO_SUBMIT';
    events.push(this.createEvent(applicationId, 'state_transition', 'FORM_FILLING', 'READY_TO_SUBMIT', 'Form ready for submission'));

    // Phase 6K/6L checkpoint 2: a wall may have appeared while filling
    // (login redirect, challenge overlay) — pause instead of submitting.
    const challenge2 = await this.checkAndPauseForChallenge(
      application, applicationId, jobDescription, events, 'READY_TO_SUBMIT'
    );
    if (challenge2.paused) {
      appTimer.end(false, `paused_for_user:${challenge2.kind}`);
      return { application, success: false, events, pausedForUser: true };
    }

    // Submit if auto_submit is enabled
    if (autoSubmit) {
      // Phase 6W/6X HARD PRE-SUBMIT ATTACHMENT GATE — a failed attachment
      // commit must never reach the Submit button (Greenhouse would reject the
      // form client-side and the run would end as a misleading
      // SUBMISSION_UNCERTAIN). STOP BEFORE the click with a clear failure.
      const attachmentGate = this.checkAttachmentGate(attachments, resume);
      if (!attachmentGate.ok) {
        const message = `Attachment gate failed — submit NOT attempted: ${attachmentGate.reasons.join('; ')}`;
        application.state = 'ERROR';
        application.status = 'error';
        application.error = message;
        application.nextAction = 'Fix attachment upload, then retry';
        events.push(this.createEvent(applicationId, 'submission_failed', 'READY_TO_SUBMIT', 'ERROR', message));
        logger.error('Pre-submit attachment gate blocked submission', {
          applicationId,
          reasons: attachmentGate.reasons,
          resume: attachments.resume,
          coverLetter: attachments.coverLetter,
          required: attachments.required,
        });
        appTimer.end(false, message);
        return { application, success: false, error: message, events };
      }

      // PHASE 8 — PER-APPLICATION APPROVAL GATE. Evaluated BEFORE the journal
      // write and before the click, so an unapproved application cannot even
      // record a submit intent. Blockers (attestations, visa, work auth) can
      // never be approved away.
      const approvalDecision = evaluateApproval({
        required: Boolean(config.application.requireApproval),
        approvedJobId: config.application.approvedJobId,
        jobId: String(jobDescription.jobId),
        blockers: config.application.approvalBlockers ?? [],
      });
      if (!approvalDecision.approved) {
        const request: ApprovalRequest = {
          applicationId: applicationId as string,
          jobId: String(jobDescription.jobId),
          company: jobDescription.company ?? '',
          role: jobDescription.title ?? '',
          ats: jobDescription.ats ?? 'unknown',
          applicationUrl: String(jobDescription.applicationUrl ?? ''),
          resumePath: resume?.filePath,
          coverLetterPath: coverLetter?.filePath,
          sensitiveQuestions: events.filter(e => e.type === 'human_escalation').map(e => e.message).slice(0, 10),
          attachmentGate: {
            ok: attachmentGate.ok,
            resume: attachments.resume?.committed ? 'committed' : 'not committed',
            coverLetter: attachments.coverLetter ? (attachments.coverLetter.committed ? 'committed' : 'not committed') : 'not applicable',
          },
          duplicateCheck: { clear: true },
          journal: { clickBearing: false },
          blockers: config.application.approvalBlockers ?? [],
        };
        const prompt = renderApprovalRequest(request);
        logger.warn('Approval required before the Submit click', { applicationId, jobId: jobDescription.jobId, reason: approvalDecision.reason });
        events.push(this.createEvent(applicationId, 'human_escalation', 'READY_TO_SUBMIT', 'PAUSED_FOR_USER', 'Operator approval required before the Submit click'));

        // Human-in-the-loop: keep the (visible) browser OPEN so the operator can
        // complete any security challenge and authorise the retry. Nothing is
        // journalled and nothing is clicked until they do.
        if ((config.application.awaitOperatorApprovalMs ?? 0) > 0) {
          const journalClickBearing = true; // this gate is only reached after a prior attempt in recovery runs
          const wait = await awaitOperatorApproval({
            jobId: String(jobDescription.jobId),
            timeoutMs: config.application.awaitOperatorApprovalMs as number,
            journalClickBearing,
          });
          if (wait.approved) {
            consumeOperatorApproval(String(jobDescription.jobId));
            logger.info('Operator approved the submission — continuing in the same browser session', {
              applicationId, jobId: jobDescription.jobId, waitedMs: wait.waitedMs, reason: wait.reason,
            });
            events.push(this.createEvent(applicationId, 'human_escalation', 'PAUSED_FOR_USER', 'READY_TO_SUBMIT', `Operator approved: ${wait.reason}`));
          } else {
            application.state = 'PAUSED_FOR_USER';
            application.status = 'paused';
            application.nextAction = 'Awaiting operator approval';
            appTimer.end(false, `approval_required: ${wait.reason}`);
            return {
              application, success: false, events, pausedForUser: true,
              error: `approval_required: ${wait.reason}`,
              approvalRequest: request, approvalPrompt: prompt,
            } as any;
          }
        } else {
          application.state = 'PAUSED_FOR_USER';
          application.status = 'paused';
          application.nextAction = 'Awaiting operator approval for this application';
          appTimer.end(false, `approval_required: ${approvalDecision.reason}`);
          return {
            application, success: false, events, pausedForUser: true,
            error: `approval_required: ${approvalDecision.reason}`,
            approvalRequest: request, approvalPrompt: prompt,
          } as any;
        }
      }

      // PHASE 6W/6X — DURABLE SUBMISSION INTENT, PERSISTED *BEFORE* THE CLICK.
      // The Submit button is irreversible: if the process dies between the click
      // and any later persistence, the run must still be recoverable as
      // "a submit may have reached the ATS" (never auto-retry).
      await this.journalSubmission('started', applicationId, jobDescription.jobId, {
        candidateId: application.candidateId as string,
        companyId: application.companyId as string,
        detail: 'Submit click intent persisted before the irreversible click',
      });
      application.state = 'SUBMITTED';
      events.push(this.createEvent(applicationId, 'submission_attempted', 'READY_TO_SUBMIT', 'SUBMITTED', 'Submitting application'));

      const submitTimer = startTimer({ stage: STAGES.BROWSER_SUBMIT, applicationId: applicationId as string, jobId: jobDescription.jobId as string });
      const submitResult = await this.browserController.submit();
      submitTimer.end(submitResult.success, submitResult.error);

      // Transport evidence for every non-GET exchange after the click (safe
      // fields only), journalled so a crash after the click still leaves proof.
      for (const t of submitResult.transport || []) {
        await this.journalSubmission(
          t.event === 'response' ? 'response' : 'request',
          applicationId,
          jobDescription.jobId,
          {
            method: t.method,
            host: t.host,
            path: t.path,
            status: t.status,
            resourceType: t.resourceType,
            elapsedMs: t.elapsedMs,
            detail: t.isRedirect ? `redirect → ${t.redirect ?? '(unknown)'}` : undefined,
          }
        );
      }
      
      if (submitResult.success) {
        application.submittedAt = new Date();
        application.confirmationId = submitResult.confirmationId;
        
        if (submitResult.uncertain) {
          application.state = 'SUBMISSION_UNCERTAIN';
          events.push(this.createEvent(applicationId, 'state_transition', 'SUBMITTED', 'SUBMISSION_UNCERTAIN', 'Submission uncertain - needs verification'));
          await this.journalSubmission('uncertain', applicationId, jobDescription.jobId, {
            candidateId: application.candidateId as string,
            companyId: application.companyId as string,
            detail: 'Click happened but no confirmation was observed — automatic retry must be refused',
          });
        } else {
          application.state = 'CONFIRMED';
          application.status = 'confirmed';
          application.confirmedAt = new Date();
          events.push(this.createEvent(applicationId, 'submission_confirmed', 'SUBMITTED', 'CONFIRMED', 'Submission confirmed'));
          await this.journalSubmission('confirmed', applicationId, jobDescription.jobId, {
            candidateId: application.candidateId as string,
            companyId: application.companyId as string,
            detail: submitResult.confirmationId ? 'Confirmation observed' : 'Confirmation observed (no id exposed)',
          });
        }
      } else {
        application.state = 'ERROR';
        application.status = 'error';
        application.error = `Submission failed: ${submitResult.error}`;
        events.push(this.createEvent(applicationId, 'submission_failed', 'READY_TO_SUBMIT', 'ERROR', `Submission failed: ${submitResult.error}`));
        await this.journalSubmission('failed', applicationId, jobDescription.jobId, {
          candidateId: application.candidateId as string,
          companyId: application.companyId as string,
          detail: submitResult.error || 'submission failed',
        });
      }
    } else {
      application.state = 'READY_TO_SUBMIT';
      application.status = 'paused';
      application.nextAction = 'Manual submission required';
      events.push(this.createEvent(applicationId, 'state_transition', 'FORM_FILLING', 'READY_TO_SUBMIT', 'Awaiting manual submission'));
    }

    application.updatedAt = new Date();
    
    // Save browser session state - best-effort diagnostics only: a screenshot/timeout
    // failure here must never fail an application that already reached its final state.
    // Phase 5A: measured as its own sub-stage (inside application.total).
    const sessionSaveTimer = startTimer({ stage: STAGES.BROWSER_SESSION_SAVE, applicationId: applicationId as string, jobId: jobDescription.jobId as string });
    try {
      await this.browserController.saveSessionState();
      sessionSaveTimer.end(true);
    } catch (diagError) {
      sessionSaveTimer.end(false, diagError instanceof Error ? diagError.message : String(diagError));
      logger.warn('Failed to save browser session state (non-fatal)', {
        applicationId,
        error: diagError instanceof Error ? diagError.message : String(diagError),
      });
    }

    appTimer.end(application.state === 'CONFIRMED' || application.state === 'SUBMISSION_UNCERTAIN');
    return { application, success: application.state === 'CONFIRMED' || application.state === 'SUBMISSION_UNCERTAIN', events };
  }

  /**
   * Phase 6K/6L — challenge checkpoint.
   *
   * Detects login / CAPTCHA / MFA / bot-challenge / rate-limit walls and
   * PAUSES for the user. Never bypasses, never asks for passwords or OTPs.
   * On pause it saves: URL, screenshot, browser session state, job ID,
   * source and application state; only THIS session pauses — other
   * applications keep running.
   */
  private async checkAndPauseForChallenge(
    application: Application,
    applicationId: string,
    jobDescription: JobDescription,
    events: ApplicationEvent[],
    fromState: ApplicationState
  ): Promise<{ paused: boolean; kind?: ChallengeKind }> {
    const page = this.browserController.getPage();
    if (!page) return { paused: false };

    let html = '';
    let url = '';
    try {
      url = page.url();
      html = await page.content();
    } catch (error) {
      logger.warn('Challenge checkpoint could not read page', { error: String(error) });
      return { paused: false };
    }

    const detection = detectChallengeFromHtml(html, url);
    if (!detection.detected || !detection.kind) return { paused: false };

    const kind = detection.kind;
    const safeUrl = url.split('?')[0]; // query strings may carry tokens — never persisted
    const source = (jobDescription as { source?: string }).source ?? 'unknown';

    logger.warn('Challenge detected — PAUSE_FOR_USER (never bypassed)', {
      applicationId, kind, jobId: jobDescription.jobId, source, url: safeUrl,
      evidence: detection.evidence,
    });

    // 1. Screenshot + browser session state (enables SAME-session resume).
    let screenshotPath: string | undefined;
    let sessionSnapshotPath: string | undefined;
    try {
      screenshotPath = await this.browserController.takeScreenshot(`challenge_${kind.toLowerCase()}`);
    } catch (error) {
      logger.warn('Challenge screenshot failed', { error: String(error) });
    }
    try {
      const snapshot = await this.browserController.saveSessionState();
      screenshotPath = screenshotPath ?? snapshot.screenshotPath;
      sessionSnapshotPath = `applications/${applicationId}/browser-state`;
    } catch (error) {
      logger.warn('Challenge session state save failed', { error: String(error) });
    }

    // 2. Escalation record (category: authorization) — visible to the user.
    const escalation = await this.escalationManager.createEscalation(
      applicationId,
      `Complete ${kind} manually in the visible browser, then confirm to resume`,
      `Application paused at ${kind} on ${safeUrl} (job ${jobDescription.jobId}, source ${source}). ` +
      `Evidence: ${detection.evidence}. ` + CHALLENGE_INSTRUCTIONS[kind],
      ['I completed it — resume', 'Skip this job'],
      'authorization',
      'high',
      undefined,
      {
        challengeKind: kind,
        url: safeUrl,
        jobId: String(jobDescription.jobId),
        source,
        detectionEvidence: detection.evidence,
        bypassPolicy: 'never-bypass',
        resumeSession: 'same-browser-session',
      }
    );

    // 3. Persist pause state (URL, screenshot, browser state, job, source, state).
    saveChallengePause({
      applicationId,
      jobId: String(jobDescription.jobId),
      source,
      applicationState: 'PAUSED_FOR_USER',
      kind,
      url: safeUrl,
      evidence: detection.evidence,
      screenshotPath,
      sessionSnapshotPath,
      escalationId: escalation.id,
      savedAt: new Date().toISOString(),
      instructions: CHALLENGE_INSTRUCTIONS[kind],
    });

    // 4. Move application into PAUSED_FOR_USER (only this application).
    application.state = 'PAUSED_FOR_USER';
    application.status = 'paused';
    application.nextAction = `user:complete-${kind.toLowerCase()}`;
    application.notes = `${kind} at ${safeUrl} — user must complete manually in the visible browser; session will resume unchanged.`;
    events.push(this.createEvent(
      applicationId, 'human_escalation', fromState, 'PAUSED_FOR_USER',
      `Paused for ${kind}: ${detection.evidence}`
    ));

    return { paused: true, kind };
  }

  private classifyQuestions(
    forms: any[],
    jobDescription: JobDescription,
    profile: MasterProfile,
    profileData: Record<string, string>
  ): ApplicationQuestion[] {
    return forms.map((field, idx) => {
      const label: string = field.label || field.name || `field_${idx}`;
      const base = {
        questionId: `Q-${jobDescription.jobId}-${idx}`,
        applicationId: '' as any, // Will be set later
        question: label,
        type: this.mapFieldType(field.type),
        required: field.required,
        options: field.options,
        category: 'technical' as const,
        askedAt: new Date(),
      };

      // Hidden fields (e.g. jobId) and file uploads are handled elsewhere, not asked of a human
      if (field.type === 'hidden' || field.type === 'file') {
        return { ...base, classification: 'KNOWN' as const };
      }

      const result = this.questionClassifier.classify(label, profile);

      // An unsafe-to-guess question must always escalate, even if a profile value exists.
      // Anything we can auto-answer from profile data counts as KNOWN (no pause).
      const autoValue = this.browserController.mapFieldToValue(field, profileData);
      const classification = result.classification === 'UNSAFE_TO_GUESS'
        ? 'UNSAFE_TO_GUESS' as const
        : autoValue ? 'KNOWN' as const : result.classification;

      return { ...base, classification };
    });
  }

  private mapFieldType(type: string): ApplicationQuestion['type'] {
    const typeMap: Record<string, ApplicationQuestion['type']> = {
      'text': 'text',
      'email': 'text',
      'tel': 'text',
      'textarea': 'text',
      'select': 'select',
      'checkbox': 'boolean',
      'radio': 'select',
      'file': 'file',
      'date': 'date',
      'number': 'number',
    };
    return typeMap[type] || 'text';
  }

  private prepareProfileData(
    profile: MasterProfile, 
    jd: JobDescription, 
    match: MatchAnalysis,
    resume: ResumeVersion,
    coverLetter: CoverLetter | undefined
  ): Record<string, string> {
    const personal = profile.personal;
    const currentExp = profile.experience.find(e => e.current) || profile.experience[0];
    
    return {
      firstName: personal.fullName.split(' ')[0] || '',
      lastName: personal.fullName.split(' ').slice(1).join(' ') || '',
      fullName: personal.fullName,
      email: personal.email,
      phone: personal.phone,
      address: personal.location,
      city: personal.location.split(',')[0]?.trim() || '',
      state: personal.location.split(',')[1]?.trim() || '',
      // Derived from profile location (last segment) — the previous hardcoded
      // 'USA' typed the wrong country into India-based application dropdowns.
      country: (() => {
        const tail = personal.location.split(',').pop()?.trim() || '';
        // ATS country lists use the long form for the US.
        return /^(usa|us|u\.s\.a\.?|united states)$/i.test(tail) ? 'United States of America' : tail;
      })(),
      linkedin: personal.linkedin || '',
      github: personal.github || '',
      portfolio: personal.portfolio || '',
      website: personal.website || '',
      summary: personal.summary,
      currentCompany: currentExp?.company || '',
      currentTitle: currentExp?.title || '',
      yearsExperience: String(profile.experience.reduce((sum, e) => {
        const years = e.current 
          ? new Date().getFullYear() - e.startDate.getFullYear()
          : e.endDate!.getFullYear() - e.startDate.getFullYear();
        return sum + years;
      }, 0)),
      expectedSalary: String(profile.compensation.targetBase),
      noticePeriod: String(profile.preferences.noticePeriodDays),
      coverLetter: coverLetter?.content || '',
    };
  }

  /**
   * Attach the resume and cover letter through each site's own upload
   * lifecycle and return the verified per-attachment outcome.
   *
   * Phase 6W fix (measured 2026-10-08, APP-20261008-000099): inputs were matched
   * on `name`, which Greenhouse does not set (`#resume` / `#cover_letter`, both
   * name-less), so BOTH targets resolved to the first input — the cover letter
   * overwrote the resume input and Greenhouse's own validator then rejected the
   * form with "Resume/CV is required." A chip was still visible because it is
   * local component state. Targets are now resolved from id/name (and never to
   * the same input), and each attachment is only "uploaded" once its upload
   * response succeeded and the site rendered it.
   */
  private async uploadDocuments(
    resume: ResumeVersion,
    coverLetter: CoverLetter | undefined,
    jd: JobDescription
  ): Promise<{ resume: AttachmentUploadResult | null; coverLetter: AttachmentUploadResult | null; required: { resume: boolean; coverLetter: boolean } }> {
    const page = this.browserController.getPage();
    const noState = { resume: null, coverLetter: null, required: { resume: false, coverLetter: false } };
    if (!page) return noState;

    const findTimer = startTimer({ stage: STAGES.UPLOAD_FIND });
    let meta: FileInputMeta[] = [];
    let handles: ElementHandle[] = [];
    try {
      const scan = await this.browserController.scanFileInputs();
      meta = scan.meta;
      handles = scan.handles as unknown as ElementHandle[];
    } catch (error) {
      findTimer.end(false, error instanceof Error ? error.message : String(error));
      logger.warn('File input scan failed', { error: error instanceof Error ? error.message : String(error) });
      return noState;
    }

    const targets = BrowserController.resolveFileInputTargets(meta);
    findTimer.end(!!(targets.resume || targets.coverLetter));

    const required = await this.browserController.detectRequiredAttachments().catch(() => ({ resume: false, coverLetter: false }));

    const attach = async (
      target: FileInputMeta | undefined,
      filePath: string | undefined,
      kind: 'resume' | 'cover_letter',
    ): Promise<AttachmentUploadResult | null> => {
      if (!target || !filePath) return null;
      const handle = handles[target.index];
      if (!handle) return null;
      const setTimer = startTimer({ stage: STAGES.UPLOAD_SET_FILES });
      let result: AttachmentUploadResult;
      try {
        result = await this.browserController.attachAttachment(handle as any, target, filePath, kind);
      } finally {
        setTimer.end(true);
      }
      const verifyTimer = startTimer({ stage: STAGES.UPLOAD_VERIFY });
      verifyTimer.end(result.committed, result.error);
      return result;
    };

    const resumeResult = await attach(targets.resume, resume?.filePath, 'resume');
    const coverResult = await attach(targets.coverLetter, coverLetter?.filePath, 'cover_letter');

    // Step 4 check: the two attachments must remain distinct — neither upload
    // may land in the other's input.
    if (resumeResult && coverResult && resumeResult.inputIndex === coverResult.inputIndex) {
      const msg = `resume and cover letter resolved to the same file input (index ${resumeResult.inputIndex})`;
      logger.error('Attachment inputs collided', { message: msg, inputId: resumeResult.inputId });
      if (resumeResult) resumeResult.error = msg;
      if (coverResult) coverResult.error = msg;
    }

    return { resume: resumeResult, coverLetter: coverResult, required };
  }

  /**
   * PHASE 9 — the real-submission lock, evaluated before any browser work.
   *
   * Returns a blocked ApplicationResult when the active candidate profile has
   * not been approved by the operator, or when it contains withdrawn demo data.
   * Returns null when the run may proceed.
   */
  private checkSubmissionLock(
    applicationId: string,
    jobDescription: JobDescription,
    events: ApplicationEvent[],
    profile?: MasterProfile,
  ): ApplicationResult | null {
    const lock: SubmissionLockState = realSubmissionLock();
    if (lock.allowed) return null;

    const message = `Real submissions are locked: ${lock.reason}`;
    const now = new Date();
    const application: any = {
      applicationId,
      jobId: jobDescription.jobId,
      candidateId: profile?.candidateId ?? 'CAND-UNKNOWN',
      companyId: (jobDescription as any).companyId ?? jobDescription.company ?? 'UNKNOWN',
      state: 'ERROR',
      status: 'error',
      error: message,
      notes: `blocked_by_profile_lock: ${lock.profileVersion}`,
      nextAction: 'Review and approve the corrected candidate profile (Phase 9), then re-run',
      startedAt: now,
      createdAt: now,
      updatedAt: now,
      submissionState: 'blocked_by_profile_lock',
      profileVersion: lock.profileVersion,
      approvedProfileVersion: lock.approvedVersion ?? null,
    };
    events.push(this.createEvent(applicationId, 'human_escalation', 'FORM_FILLING', 'BLOCKED', message));
    return { application, success: false, error: message, events };
  }

  /**
   * PHASE 9 — artifact staleness / invalidation gate.
   *
   * A CV or cover letter generated from an older profile version (or from the
   * withdrawn demo profile) carries false claims about the candidate, so it must
   * never be uploaded, whatever the job is.
   */
  private checkArtifactStaleness(resume: ResumeVersion, coverLetter: CoverLetter | undefined): string[] | null {
    const currentVersion = profileProfileVersion();
    const problems: string[] = [];
    const check = (name: 'resume' | 'cover_letter', path: string | undefined, artifactVersion: string | undefined) => {
      if (!path) return;
      const verdict = assertArtifactUsable({
        artifactPath: path,
        artifactProfileVersion: artifactVersion,
        currentProfileVersion: currentVersion,
      });
      if (!verdict.ok) problems.push(`${name}: ${verdict.reason}`);
    };
    check('resume', resume?.filePath, resume?.profileVersion);
    check('cover_letter', coverLetter?.filePath, coverLetter?.profileVersion);

    // A document whose TEXT carries a withdrawn claim is refused even if it was
    // regenerated by mistake from a cached copy. Binary renderings (PDF) are
    // skipped here: their text layer is not safely inspectable as UTF-8, and
    // they are regenerated from the JSON artifact that IS checked.
    const TEXTUAL = /\.(json|txt|md|html?|csv)$/i;
    for (const [name, path] of [['resume', resume?.filePath], ['cover_letter', coverLetter?.filePath]] as const) {
      if (!path || !TEXTUAL.test(path)) continue;
      try {
        const text = fsSync.readFileSync(path, 'utf8');
        for (const f of detectFabricatedClaims(text)) problems.push(`${name}: withdrawn claim ${f.id} present in the file`);
      } catch {
        // Unreadable artifacts are handled by the attachment gate; not our check.
      }
    }
    return problems.length > 0 ? problems : null;
  }

  /**
   * Phase 6W/6X hard pre-submit attachment gate. A failed attachment commit
   * must never reach the Submit button: Greenhouse would reject the form
   * client-side ("Resume/CV is required.") and the run would end as a
   * SUBMISSION_UNCERTAIN that looks like a transport failure.
   */
  private checkAttachmentGate(attachments: {
    resume: AttachmentUploadResult | null;
    coverLetter: AttachmentUploadResult | null;
    required: { resume: boolean; coverLetter: boolean };
  }, resume: ResumeVersion): { ok: boolean; reasons: string[] } {
    const reasons: string[] = [];

    const judge = (label: string, r: AttachmentUploadResult | null, required: boolean) => {
      if (!r) {
        // Nothing was attached and nothing was required — fine.
        if (required) reasons.push(`${label} is required but no matching file input was found on the form`);
        return;
      }
      if (r.verdict === 'failed') {
        reasons.push(`${label} attachment not committed (${r.error || 'unknown reason'})`);
      } else if (r.verdict === 'unknown') {
        // No separate upload request was observed: the site most likely posts the
        // files with the form. Nothing failed, so submission is not blocked, but
        // the weaker evidence is reported.
        logger.warn(`Attachment ${label} could not be verified before submit (site posts files with the form)`, {
          inputId: r.inputId,
          fileName: r.expectedName,
        });
      }
    };

    judge('resume', attachments.resume, attachments.required.resume || !!resume?.filePath);
    if (attachments.required.coverLetter) judge('cover letter', attachments.coverLetter, true);
    else if (attachments.coverLetter?.verdict === 'failed') {
      logger.warn('Optional cover letter attachment failed', {
        inputId: attachments.coverLetter.inputId,
        error: attachments.coverLetter.error,
      });
    }

    if (resume?.filePath && !attachments.resume) {
      reasons.push('a resume file path was provided but the form exposes no resume file input');
    } else if (attachments.required.resume && !resume?.filePath) {
      reasons.push('form requires a resume but no resume file path was provided');
    }

    return { ok: reasons.length === 0, reasons };
  }

  private async validateForm(): Promise<{ valid: boolean; errors: string[] }> {
    const page = this.browserController.getPage();
    if (!page) return { valid: false, errors: ['No page available'] };

    const errors: string[] = [];

    // Check required fields
    const requiredFields = await page.$$('input[required], select[required], textarea[required]');
    for (const field of requiredFields) {
      const value = await field.inputValue();
      if (!value || value.trim() === '') {
        const name = await field.getAttribute('name') || await field.getAttribute('id') || 'unknown';
        errors.push(`Required field empty: ${name}`);
      }
    }

    // Check for visible validation errors
    const errorElements = await page.$$('[role="alert"], .error, .validation-error, .field-error');
    for (const el of errorElements) {
      const text = await el.textContent();
      if (text && text.trim()) errors.push(text.trim());
    }

    return { valid: errors.length === 0, errors };
  }

  private createEvent(
    applicationId: string, 
    type: ApplicationEvent['type'], 
    fromState: ApplicationState | undefined, 
    toState: ApplicationState, 
    message: string
  ): ApplicationEvent {
    return {
      eventId: generateEventId(),
      applicationId: applicationId as any,
      type,
      fromState,
      toState,
      message,
      timestamp: new Date(),
    };
  }

  private async requestHumanAnswers(
    questions: ApplicationQuestion[],
    applicationId: string,
    jobDescription: JobDescription
  ): Promise<{ answers: Array<{ questionId: string; value: string }>; timedOut: boolean }> {
    logger.info('Human escalation required', {
      applicationId,
      questions: questions.map(q => q.question)
    });

    // Store escalation requests in persistent storage
    // Phase 5J: measure persistence vs snapshot separately.
    const escCreateTimer = startTimer({ stage: STAGES.ESCALATION_CREATE, applicationId: applicationId as string, jobId: jobDescription.jobId as string });
    const escalationRecords: EscalationRecord[] = [];
    for (const q of questions) {
      const escalation = await this.escalationManager.createEscalation(
        applicationId,
        q.question,
        `Application for ${jobDescription.title} at ${jobDescription.company}`,
        q.options,
        'technical',
        'medium',
        new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hour expiry
        { questionId: q.questionId, category: q.category, required: q.required }
      );
      escalationRecords.push(escalation);
    }
    escCreateTimer.end(true);

    // Create pause snapshot
    const snapTimer = startTimer({ stage: STAGES.ESCALATION_SNAPSHOT, applicationId: applicationId as string, jobId: jobDescription.jobId as string });
    const pageState = await this.browserController.capturePageState();
    const formData: Record<string, string> = {};
    for (const form of pageState.forms) {
      if (form.value) {
        formData[form.name || form.id || form.uid] = form.value;
      }
    }
    await this.escalationManager.createSnapshot(
      applicationId,
      'PAUSED_FOR_USER',
      pageState,
      formData,
      escalationRecords
    );
    snapTimer.end(true);

    // Wait for responses. Legacy default (ESCALATION_WAIT_MS=0): return
    // immediately with empty answers (historical behavior — form validation
    // gates submission). With a positive wait: poll the file-backed escalation
    // store until every REQUIRED question is answered or the timeout elapses.
    const waitMs = config.application.escalationWaitMs;
    if (waitMs <= 0) {
      return { answers: questions.map(q => ({ questionId: q.questionId, value: '' })), timedOut: false };
    }

    const deadline = Date.now() + waitMs;
    const readAnswers = async (): Promise<Map<string, string>> => {
      // Answers may be written by another process (CLI escalation:answer) —
      // reload from disk so the in-memory map observes them.
      await this.escalationManager.reloadFromDisk();
      const escs = await this.escalationManager.getEscalationsByApplication(applicationId);
      const map = new Map<string, string>();
      for (const e of escs) {
        const qid = e.metadata?.questionId as string | undefined;
        if (qid && e.status === 'answered' && e.answer) map.set(qid, e.answer);
      }
      return map;
    };

    let answersMap = await readAnswers();
    const pendingRequired = () => questions.filter(q => q.required && !answersMap.has(q.questionId)).length;
    logger.info('Waiting for human escalation answers', { applicationId, questions: questions.length, waitMs });
    while (pendingRequired() > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      answersMap = await readAnswers();
    }

    const answers = questions.map(q => ({ questionId: q.questionId, value: answersMap.get(q.questionId) ?? '' }));
    const timedOut = pendingRequired() > 0;
    if (timedOut) {
      logger.warn('Escalation wait timed out with required questions unanswered', {
        applicationId, pending: pendingRequired(),
      });
    } else {
      logger.info('Required escalation questions answered', { applicationId, answered: answersMap.size });
    }
    return { answers, timedOut };
  }

  async handleHumanResponse(questionId: string, answer: string): Promise<void> {
    // Find the escalation by questionId in metadata
    const escalations = await this.escalationManager.getEscalationsByApplication(
      // We need to find which application this questionId belongs to
      // For now, check all pending escalations
      ''
    );

    // Since we need the applicationId, let's search all escalations
    const allEscalations = await this.escalationManager.getEscalations({ status: ['pending'] });
    const escalation = allEscalations.find(e => e.metadata?.questionId === questionId);

    if (escalation) {
      await this.escalationManager.answerEscalation(
        escalation.id,
        answer,
        'user',
        1.0,
        'user-provided'
      );
    }
  }

  getPendingEscalations(): HumanEscalationRequest[] {
    return Array.from(this.pendingEscalations.values());
  }

  async getEscalationsForApplication(applicationId: string): Promise<EscalationRecord[]> {
    return this.escalationManager.getEscalationsByApplication(applicationId);
  }

  async resumeApplication(applicationId: string): Promise<{ browserState?: any; formData?: Record<string, string> } | null> {
    const resumeTimer = startTimer({ stage: STAGES.RESUME_RESTORE, applicationId: applicationId as string });
    const snapshot = await this.escalationManager.resumeFromSnapshot(applicationId);
    if (!snapshot) {
      resumeTimer.end(false, 'no snapshot');
      return null;
    }

    if (snapshot.browserState) {
      await this.browserController.restoreSessionState(snapshot.browserState);
    }
    resumeTimer.end(true);

    return {
      browserState: snapshot.browserState,
      formData: snapshot.formData,
    };
  }

  async apply(options: { jobId: any; profile: MasterProfile; autoSubmit: boolean; jobUrl?: string; resume?: any; coverLetter?: any; jobDescription?: any; matchAnalysis?: any }): Promise<any> {
    const { jobId, profile, autoSubmit, jobUrl, resume, coverLetter, jobDescription, matchAnalysis } = options;

    // Use the provided job URL if available, otherwise fall back to config default
    const defaultUrl = jobUrl || config.application.defaultApplicationUrl || `http://localhost:32500/apply?jobId=${jobId}`;

    // Ensure jobDescription has the correct URL
    const jd = jobDescription 
      ? { ...jobDescription, url: jobDescription.url || defaultUrl }
      : { jobId, company: '', title: '', url: defaultUrl };

    // Use provided match/resume/coverLetter, or create minimal fallback
    const input: any = {
      jobDescription: jd,
      matchAnalysis: matchAnalysis || { overallScore: 80, recommendation: 'APPLY', confidence: 0.8 },
      resume: resume || { resumeId: `RES-${jobId}`, filePath: '' },
      coverLetter: coverLetter || undefined,
      autoSubmit,
    };

    return this.processApplication(input, profile);
  }

  async resume(applicationId: string, profile: MasterProfile): Promise<any> {
    // Resume a paused application
    const snapshot = await this.escalationManager.getSnapshot(applicationId);
    if (!snapshot) {
      return { success: false, error: 'No resume snapshot found' };
    }

    // Restore browser state if available
    if (snapshot.browserState) {
      await this.browserController.restoreSessionState(snapshot.browserState);
    }

    // Clear the paused state
    const escalations = await this.escalationManager.getEscalationsByApplication(applicationId);
    if (escalations.length > 0) {
      // Mark escalations as resolved or completed
      await this.escalationManager.answerEscalation(
        escalations[0].id,
        'Resume requested',
        'agent',
        1.0,
        'auto-resume'
      );
    }

    logger.info('Application resumed', { applicationId, profile: profile.candidateId });
    return {
      success: true,
      applicationId,
      resumedAt: new Date(),
      hasBrowserState: !!snapshot.browserState,
      pendingQuestions: 0
    };
  }

  async close(): Promise<void> {
    await this.browserController.close();
  }
}
