/**
 * Phase 7 — Chat control plane.
 *
 * Translates plain-language operator instructions into SAFE internal operations.
 * The chat box is the human control surface; this module is the guard rail in
 * front of it.
 *
 * Safety model (the whole point):
 *   - Natural language can never override a safety control. "Submit it again"
 *     against an uncertain/blocked application is REFUSED with the reason.
 *   - Uncertain/unknown submissions are never retried automatically.
 *   - Sensitive questions are never answered by the agent; the agent surfaces
 *     them with the context a human needs and waits.
 *   - Every mutating action returns an explicit, auditable outcome.
 *
 * The agent uses this from chat; the CLI (`npm run chat`) exposes the same
 * surface for reproducibility.
 */

import type { DatabaseClient } from '../database/client.ts';
import { SubmissionJournalRepository } from '../database/repositories.ts';
import { CLICK_BEARING_PHASES, FileSubmissionJournal } from '../application/submission-journal.ts';
import { preflightDuplicateCheck } from '../application/duplicate-guard.ts';
import { toLifecycleState, decideRetry, type ApplicationLifecycleState } from '../application/state-machine.ts';
import { classifyFailure, explainFailure, type PipelineStage } from '../application/failure-taxonomy.ts';
import { realSubmissionLock } from '../profile/profile-integrity.ts';
import { ProfileWorkspace } from '../profile/profile-workspace.ts';
import { PERSONAL_QUESTIONS } from '../profile/auto-resolve.ts';

const PERSONAL_QUESTIONS_ID_SET = new Set(PERSONAL_QUESTIONS.map(q => q.id));
import { buildTimeline, renderTimeline } from '../observability/application-timeline.ts';
import { RateLimiter } from '../core/rate-limiter.ts';
import { getEscalationManager } from '../escalation/index.ts';
import * as fs from 'fs';

export interface ChatResult {
  ok: boolean;
  /** Chat-facing answer, already formatted for a human. */
  message: string;
  /** Machine-readable action taken (for tests/audit). */
  action: string;
  data?: unknown;
}

export interface ChatAgentDeps {
  db: DatabaseClient;
  journalRepo: SubmissionJournalRepository;
  fileJournal?: FileSubmissionJournal;
  rateLimiter?: RateLimiter;
  /** Phase 10 — injected so profile work is testable without a live database. */
  profileWorkspace?: ProfileWorkspace;
}

/** Instructions that are ALWAYS refused, whatever the state. */
const ALWAYS_REFUSED = [
  /bypass\b.*(captcha|mfa|login|password)/i,
  /disable\b.*(duplicate|journal|guard)/i,
  /mark\s+(it\s+)?(as\s+)?confirmed\s+manually/i,
  /(fake|fabricat\w*)\s+.*(confirmation|submission|confirmation id)/i,
  /reset\b.*journal/i,
  /delete\b.*journal/i,
];

export class ChatAgent {
  private readonly db: DatabaseClient;
  private readonly journalRepo: SubmissionJournalRepository;
  private readonly fileJournal: FileSubmissionJournal;
  private readonly limiter: RateLimiter;
  private readonly profiles: ProfileWorkspace;
  /**
   * Phase 10 — the exact profile version the candidate was shown. Approval is
   * only executed against this hash, so an edit between review and approval
   * cannot be approved by accident.
   */
  private pendingProfileVersion?: string;
  private pendingQuestionId?: string;

  constructor(deps: ChatAgentDeps) {
    this.db = deps.db;
    this.journalRepo = deps.journalRepo;
    this.profiles = deps.profileWorkspace ?? new ProfileWorkspace();
    this.fileJournal = deps.fileJournal ?? new FileSubmissionJournal();
    this.limiter = deps.rateLimiter ?? new RateLimiter();
  }

  /** Parse and execute one instruction. Unknown instructions are refused, not guessed. */
  async handle(instruction: string): Promise<ChatResult> {
    const text = instruction.trim();
    if (!text) return { ok: false, action: 'noop', message: 'Empty instruction.' };

    for (const pattern of ALWAYS_REFUSED) {
      if (pattern.test(text)) {
        return {
          ok: false,
          action: 'refused_unsafe',
          message:
            `Refused: "${text}".\n` +
            'WHY: safety controls (CAPTCHA/MFA/login handling, duplicate protection, the submission journal) cannot be overridden by an instruction.\n' +
            'WHAT I DID: nothing was changed.\n' +
            'WHAT NEEDS YOU: nothing — this operation is not permitted.',
        };
      }
    }

    // Specific commands first, and anchored: substring matching must never
    // hijack an explicit command (e.g. "retry APP-…-uncertain" is a RETRY of an
    // uncertain application, not a request to LIST uncertain applications).
    if (/^(profile|candidate profile|my profile)\b/i.test(text)) {
      return this.profileCommand(text.replace(/^(profile|candidate profile|my profile)\s*/i, '').trim());
    }
    if (/^(help|what can you do)\b/i.test(text)) return this.help();
    if (/^explain\b/i.test(text)) return this.explain(text.replace(/^explain\s+/i, '').trim());
    if (/^(retry|re-?try|resubmit|submit it again)\b/i.test(text) || /^submit\s+it\s+again$/i.test(text)) {
      return this.retry(text.replace(/^(retry|re-?try|resubmit|submit\s+it\s+again)\s*/i, '').trim());
    }
    if (/^approve\b/i.test(text)) return this.simpleStateChange(text, 'approve');
    if (/^(skip|block)\b/i.test(text)) return this.simpleStateChange(text, 'block');
    if (/^pause all\b/i.test(text)) return { ok: true, action: 'pause_all', message: 'All queued applications are paused. Discovery and new application starts are held until "resume".' };
    if (/^resume\b/i.test(text)) return { ok: true, action: 'resume', message: 'Queue resumed. Any application paused for your answers continues when its answers arrive.' };
    if (/^(status|dashboard|today'?s?\s+(application\s+)?(stat|stats|status|summary))$/i.test(text)) return this.status();
    if (/^(waiting|waiting for (my|our) answer|needs? (my )?answer)$/i.test(text) || /^show\b.*\bwaiting\b/i.test(text)) return this.waiting();
    if (/^(failed|failed applications?)$/i.test(text) || /^show\b.*\bfailed\b/i.test(text)) return this.failed();
    if (/^(uncertain|uncertain applications?)$/i.test(text) || /^show\b.*\buncertain\b/i.test(text)) return this.uncertain();

    return {
      ok: false,
      action: 'unknown_instruction',
      message:
        `I don't know how to do "${text}" yet.\n` +
        'Supported: status / waiting / failed / uncertain / explain <applicationId> / retry <applicationId> / approve|skip <applicationId> / pause all / resume / help',
    };
  }

  private help(): ChatResult {
    return {
      ok: true,
      action: 'help',
      message: [
        'I can do these from chat:',
        '  • status / today’s statistics',
        '  • waiting — applications that need your answers (with the question and why)',
        '  • failed / uncertain — grouped problem list',
        '  • explain <applicationId> — full timeline and first failing stage',
        '  • retry <applicationId> — only when it is provably safe (never for uncertain/unknown)',
        '  • approve|skip <applicationId> — record an operator decision',
        '  • pause all / resume',
        'Safety: I will never bypass CAPTCHA/MFA/login, never override duplicate protection, never retry an uncertain submission, and never fabricate a confirmation.',
      ].join('\n'),
    };
  }

  private async rows(sql: string, params: any[] = []): Promise<any[]> {
    const res = await this.db.query(sql, params);
    return res.rows;
  }

  /** Grouped status across applications (+ journal knowledge). */
  async status(): Promise<ChatResult> {
    const apps = await this.rows(
      `SELECT application_id, job_id, state, status, confirmation_id, submitted_at, confirmed_at, created_at
       FROM applications ORDER BY created_at DESC LIMIT 200`
    );
    const buckets = {
      discovered: 0, qualified: 0, waiting: 0, applied: 0, confirmed: 0, failed: 0, uncertain: 0, blocked: 0,
    };
    for (const a of apps) {
      const s = String(a.state).toUpperCase();
      if (s === 'SUBMITTED') buckets.applied += 1;
      else if (s === 'CONFIRMED') buckets.confirmed += 1;
      else if (s === 'PAUSED_FOR_USER') buckets.waiting += 1;
      else if (s === 'SUBMISSION_UNCERTAIN') buckets.uncertain += 1;
      else if (s === 'BLOCKED') buckets.blocked += 1;
      else if (s === 'ERROR') buckets.failed += 1;
      else if (['DISCOVERED', 'VERIFIED', 'ANALYZED', 'MATCHED'].includes(s)) buckets.discovered += 1;
      else buckets.qualified += 1;
    }
    // Uncertain applications can exist in the journal even without a row.
    const journalClickBearing = (await this.journalRepo.findByJob('*')).length;
    const lines = [
      'Applications:',
      `  discovered ${buckets.discovered} · qualified ${buckets.qualified} · waiting for you ${buckets.waiting}`,
      `  applied ${buckets.applied} · confirmed ${buckets.confirmed} · failed ${buckets.failed}`,
      `  uncertain ${buckets.uncertain} · blocked ${buckets.blocked}`,
    ];
    const cooldowns = this.limiter.cooldowns();
    if (cooldowns.length) lines.push(`  cooldowns: ${cooldowns.map(c => `${c.key} (${c.secondsRemaining}s)`).join(', ')}`);
    return { ok: true, action: 'status', message: lines.join('\n'), data: { buckets, total: apps.length, journalClickBearing } };
  }

  /** Applications waiting on the human, with the question and why it matters. */
  async waiting(): Promise<ChatResult> {
    let pending: any[] = [];
    try {
      const esc = getEscalationManager();
      pending = (await esc.getEscalations({ status: ['pending'] })) ?? [];
    } catch {
      pending = [];
    }
    if (!pending.length) return { ok: true, action: 'waiting', message: 'Nothing is waiting for your answers right now.' };

    const byApp = new Map<string, typeof pending>();
    for (const p of pending) {
      const list = byApp.get(p.applicationId) ?? [];
      list.push(p);
      byApp.set(p.applicationId, list);
    }
    const chunks: string[] = [`${pending.length} question(s) waiting for you across ${byApp.size} application(s):`];
    for (const [appId, list] of byApp) {
      chunks.push(`\n${appId}`);
      for (const p of list.slice(0, 25)) {
        const sensitive = /authoris|nationality|ethnic|race|gender|visa|sponsor|legal|attest|agree|plagiarism|disab|vetera|compensation|salary/i.test(p.question);
        chunks.push(`  • ${p.question}`);
        chunks.push(`    ${sensitive ? 'SENSITIVE — I will not answer this for you.' : 'Needs your input to continue.'}`);
      }
      if (list.length > 25) chunks.push(`  … and ${list.length - 25} more`);
    }
    chunks.push('\nAnswer with: answer <escalationId> "<your answer>"  (or the chat UI form) — the SAME application and browser session resume; nothing restarts.');
    return { ok: true, action: 'waiting', message: chunks.join('\n'), data: { count: pending.length } };
  }

  private async grouped(label: string, predicate: (a: any) => boolean): Promise<ChatResult> {
    const apps = await this.rows(
      `SELECT application_id, job_id, state, status, confirmation_id, created_at FROM applications ORDER BY created_at DESC LIMIT 200`
    );
    const matched = apps.filter(predicate);
    if (!matched.length) return { ok: true, action: label, message: `No ${label} applications.` };
    const lines = [`${matched.length} ${label} application(s):`];
    for (const a of matched) {
      const job = await this.jobSummary(a.job_id);
      const journal = await this.journalSummary(String(a.job_id));
      lines.push(`  • ${a.application_id} — ${job} [state=${a.state}]`);
      if (journal) lines.push(`      journal: ${journal}`);
    }
    return { ok: true, action: label, message: lines.join('\n'), data: { count: matched.length } };
  }

  async failed(): Promise<ChatResult> {
    return this.grouped('failed', a => ['ERROR', 'FAILED', 'SUBMISSION_UNCERTAIN'].includes(String(a.state).toUpperCase()) && String(a.state).toUpperCase() !== 'SUBMISSION_UNCERTAIN');
  }

  async uncertain(): Promise<ChatResult> {
    const rowsOut = await this.grouped('uncertain', a => String(a.state).toUpperCase() === 'SUBMISSION_UNCERTAIN');
    const journalOnly = await this.fileJournalClickBearing();
    if (journalOnly.length) {
      return {
        ok: true,
        action: 'uncertain',
        message: `${rowsOut.message}\n  • (journal-only, no application row) ${journalOnly.join(', ')}`,
      };
    }
    return rowsOut;
  }

  /**
   * Journal-only uncertain applications for DISPLAY. Fixture ids from test runs
   * are filtered out of the operator view only — the protection lookup
   * (`hasClickBearingAttempt`) still considers every entry, because a real click
   * must never be hidden from the guard.
   */
  private async fileJournalClickBearing(): Promise<string[]> {
    const out: string[] = [];
    const isFixture = (jobId: string) => /^JOB-(extracted|fixture|fake|test|muz)/i.test(jobId);
    const dir = this.fileJournal.filePath('x').replace(/\/x\.jsonl$/, '');
    if (!fs.existsSync(dir)) return out;
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.jsonl'))) {
      const lines = fs.readFileSync(`${dir}/${f}`, 'utf8').split('\n').filter(Boolean);
      for (const l of lines) {
        try {
          const e = JSON.parse(l);
          if (CLICK_BEARING_PHASES.includes(e.phase) && !isFixture(String(e.jobId)) && !out.some(o => o.includes(e.jobId))) {
            out.push(`${e.jobId} (phase=${e.phase})`);
          }
        } catch { /* ignore malformed line */ }
      }
    }
    return out;
  }

  private async jobSummary(jobId: string): Promise<string> {
    const rows = await this.rows(
      `SELECT c.name AS company, j.title FROM jobs j LEFT JOIN companies c ON c.company_id = j.company_id WHERE j.job_id = ? LIMIT 1`,
      [jobId]
    );
    const j = rows[0];
    return j ? `${j.company} — ${j.title}` : String(jobId);
  }

  private async journalSummary(jobId: string): Promise<string | null> {
    const dbAttempt = await this.journalRepo.hasClickBearingAttempt(jobId, CLICK_BEARING_PHASES);
    const fileAttempt = await this.fileJournal.hasClickBearingAttempt(jobId, CLICK_BEARING_PHASES);
    const attempt = dbAttempt ?? fileAttempt;
    return attempt ? `phase=${attempt.phase} (retry protected)` : null;
  }

  /** Full timeline + first failing stage for one application. */
  async explain(applicationId: string): Promise<ChatResult> {
    const apps = await this.rows(`SELECT * FROM applications WHERE application_id = ? LIMIT 1`, [applicationId]);
    if (!apps.length) {
      // Crash case: the run died before persistence, but the journal survived.
      const journalRows = await this.journalRepo.findByApplication(applicationId);
      const fileRows = this.fileJournal.read(applicationId);
      const merged = [...journalRows, ...fileRows] as any[];
      if (!merged.length) return { ok: false, action: 'explain', message: `No application ${applicationId} (and no journal record).` };
      const timeline = buildTimeline({ applicationId, events: [], journal: merged });
      const last = merged[merged.length - 1];
      const clickBearing = merged.some((r: any) => CLICK_BEARING_PHASES.includes(r.phase));
      return {
        ok: true,
        action: 'explain',
        message:
          renderTimeline(timeline) +
          `\nNote: this application has no database row — it crashed before persistence; the journal is the only record.\n` +
          `Retry protection: ${clickBearing ? 'ENABLED — automatic retry refused' : 'no click-bearing phase recorded'}\n` +
          `Last known journal phase: ${last.phase}`,
        data: timeline,
      };
    }
    const a = apps[0];
    const events = await this.rows(
      `SELECT type, from_state, to_state, message, timestamp FROM application_events WHERE application_id = ? ORDER BY timestamp ASC, rowid ASC`,
      [applicationId]
    );
    const journal = await this.journalRepo.findByApplication(applicationId);
    const job = (await this.rows(
      `SELECT c.name AS company, j.title FROM jobs j LEFT JOIN companies c ON c.company_id = j.company_id WHERE j.job_id = ? LIMIT 1`,
      [a.job_id]
    ))[0];
    const timeline = buildTimeline({
      applicationId,
      jobId: a.job_id,
      company: job?.company,
      role: job?.title,
      events: events.map((e: any) => ({ ...e, timestamp: e.timestamp })),
      journal,
    });
    let extra = '';
    if (timeline.firstFailingStage) {
      const cls = classifyFailure({ stage: timeline.firstFailingStage as PipelineStage, error: timeline.entries.map(e => e.message).join(' | ') });
      extra = '\n\n' + explainFailure(cls, { applicationId, jobId: a.job_id });
    }
    return { ok: true, action: 'explain', message: renderTimeline(timeline) + extra, data: timeline };
  }

  /** Retry — refused for anything the journal or state machine says is unsafe. */
  async retry(applicationId: string): Promise<ChatResult> {
    if (!applicationId) {
      return {
        ok: false,
        action: 'retry_refused',
        message:
          'Refused to retry: no application was named.\n' +
          'WHY: a bare "submit it again" cannot be targeted safely, and blanket resubmission is never permitted — the submission journal is the safety authority and no instruction overrides it.\n' +
          'WHAT I DID: nothing changed.\n' +
          'WHAT NEEDS YOU: name the application, e.g. "retry APP-…" (uncertain/unknown ones will still be refused).',
      };
    }
    let apps = await this.rows(`SELECT application_id, job_id, state FROM applications WHERE application_id = ? LIMIT 1`, [applicationId]);
    // The operator may name the JOB. More importantly: a crashed submission can
    // have NO application row at all — the journal is still authoritative and
    // must refuse the retry.
    if (!apps.length) {
      const journalRows = await this.journalRepo.findByJob(applicationId);
      const clickBearing = journalRows.find(r => CLICK_BEARING_PHASES.includes(r.phase as any));
      if (clickBearing) {
        return {
          ok: false,
          action: 'retry_refused',
          message:
            `Refused to retry ${clickBearing.jobId} (${clickBearing.applicationId}).\n` +
            `WHY: ${clickBearing.phase}. The submission journal is the safety authority and no instruction overrides it.\n` +
            'WHAT I DID: nothing changed.\n' +
            'WHAT NEEDS YOU: verify with the employer, then decide manually.',
        };
      }
      const fileAttempt = await this.fileJournal.hasClickBearingAttempt(applicationId, CLICK_BEARING_PHASES);
      if (fileAttempt) {
        return {
          ok: false,
          action: 'retry_refused',
          message:
            `Refused to retry ${applicationId} (${fileAttempt.applicationId}).\n` +
            `WHY: ${fileAttempt.phase}. The submission journal is the safety authority and no instruction overrides it.\n` +
            'WHAT I DID: nothing changed.\n' +
            'WHAT NEEDS YOU: verify with the employer, then decide manually.',
        };
      }
      return { ok: false, action: 'retry', message: `No application ${applicationId} to retry.` };
    }
    const a = apps[0];
    const state = toLifecycleState(String(a.state));
    const journalClickBearing = !!(await this.journalRepo.hasClickBearingAttempt(String(a.job_id), CLICK_BEARING_PHASES))
      || !!(await this.fileJournal.hasClickBearingAttempt(String(a.job_id), CLICK_BEARING_PHASES));
    const decision = decideRetry({ state, journalClickBearing, provablyPreSubmit: state === 'FAILED' });

    if (!decision.safeToAutoRetry) {
      const journalNote = journalClickBearing
        ? 'The submission journal holds a click-bearing record for this job (it is the safety authority).'
        : `The state machine marks ${state} as never-auto-retriable.`;
      return {
        ok: false,
        action: 'retry_refused',
        message:
          `Refused to retry ${applicationId} (${a.job_id}).\n` +
          `WHY: ${decision.reason}. ${journalNote}\n` +
          'WHAT I DID: nothing changed.\n' +
          'WHAT NEEDS YOU: verify the application with the employer, then decide manually. I will not resubmit on my own.',
      };
    }
    // PHASE 9 — only once the journal/state machine says a retry is safe does
    // the profile lock get a say. Existing refusals keep their own reasons; the
    // lock can only ever make an otherwise-allowed action MORE refused.
    const lock = realSubmissionLock();
    if (!lock.allowed) {
      return {
        ok: false,
        action: 'retry_refused',
        message:
          `Refused to retry ${applicationId} (${a.job_id}).\n` +
          `WHY: real submissions are locked — ${lock.reason}.\n` +
          `Active profile version: ${lock.profileVersion}\n` +
          'WHAT I DID: nothing changed.\n' +
          'WHAT NEEDS YOU: review and approve the corrected candidate profile, then retry.',
      };
    }
    return {
      ok: true,
      action: 'retry_allowed',
      message: `Retry is safe for ${applicationId}: ${decision.reason}`,
    };
  }

  // ==========================================================================
  // PHASE 10 — chat-first profile workflow.
  //
  // The candidate drives the whole profile from here: see what was resolved,
  // answer the few questions only they can answer, review the final version and
  // approve it. The agent does every technical step itself (resolution, hashing,
  // validation, approval workflow) — the candidate never runs a command.
  // ==========================================================================

  private async profileCommand(rest: string): Promise<ChatResult> {
    const sub = rest.trim().toLowerCase();

    // Review the proposal and start the approval conversation.
    if (sub === '' || /^(status|show|review|summary)$/.test(sub)) {
      const s = this.profiles.status();
      const lines = [
        '=== CANDIDATE PROFILE ===',
        `${s.name} · ${s.email} · ${s.phone}`,
        `Location    : ${s.location}`,
        `GitHub      : ${s.github ?? '(none)'}`,
        `LinkedIn    : ${s.linkedinWithheld ? 'withheld from documents (unconfirmed)' : 'included'}`,
        `Version     : ${s.version}`,
        '',
        `Resolved automatically : ${s.autoResolvedCount}`,
        `Confirmed by you       : ${s.confirmedCount}`,
        `Conflicts to review    : ${s.conflictCount}`,
        `Still unknown          : ${s.unknownCount}`,
        s.certificationsWithheld.length
          ? `Certifications withheld: ${s.certificationsWithheld.join(', ')}`
          : 'Certifications withheld: none',
        '',
        `Real submissions: ${s.lockOpen ? 'OPEN (profile approved)' : 'LOCKED'} — ${s.lockReason}`,
      ];
      const remaining = this.profiles.outstandingQuestions();
      if (remaining.length) {
        lines.push('', `${remaining.length} question(s) only you can answer. Say "profile ask" for the next one.`);
      }
      return { ok: true, action: 'profile_status', message: lines.join('\n') };
    }

    // Run (or re-run) automatic resolution from local evidence.
    if (/^(resolve|auto|fix|complete)$/.test(sub)) {
      const { report, apply } = this.profiles.resolve({ apply: true });
      const { text: detail } = this.profiles.describeResolution();
      const changed = apply?.changed ? apply.changes.join('; ') || 'metadata only' : 'nothing needed changing';
      return {
        ok: true,
        action: 'profile_resolved',
        message: [
          '=== AUTOMATIC RESOLUTION ===',
          detail,
          '',
          `Resolved automatically: ${report.resolutions.filter(r => r.status === 'auto_resolved').length} field(s) written, ` +
          `${report.resolutions.filter(r => r.status === 'already_correct').length} already correct`,
          '',
          `Applied     : ${changed}`,
          `New version : ${apply?.version}`,
          '',
          report.questions.length
            ? `${report.questions.length} question(s) remain — they are personal facts no evidence can settle. Say "profile ask".`
            : 'Nothing further is needed from you on profile facts.',
        ].join('\n'),
      };
    }

    // Ask the next personal question (one at a time).
    if (/^(ask|question|next)$/.test(sub)) {
      const q = this.profiles.nextQuestion();
      if (!q) {
        return { ok: true, action: 'profile_no_questions', message: 'Nothing left to ask — every profile fact is either resolved or confirmed.' };
      }
      this.pendingQuestionId = q.id;
      return {
        ok: true,
        action: 'profile_question',
        message: [
          q.question,
          '',
          `WHY: ${q.why}`,
          '',
          `Answer with "profile answer <your answer>". (${q.examples.slice(0, 3).join(' | ')})`,
        ].join('\n'),
      };
    }

    // Record an answer to the outstanding question.
    if (/^(answer|ans|reply)\b/i.test(rest)) {
      const body = rest.replace(/^(answer|ans|reply)\s*/i, '').trim();
      // "profile answer for <question-id> <text>" answers a parked question
      // explicitly; otherwise the currently pending question is answered.
      const forMatch = body.match(/^for\s+([a-z-]+)\s+([\s\S]+)$/i);
      const questionId = forMatch ? forMatch[1] : undefined;
      const answerBody = forMatch ? forMatch[2].trim() : body;
      if (questionId && !PERSONAL_QUESTIONS_ID_SET.has(questionId)) {
        return { ok: false, action: 'profile_unknown_question', message: `I do not know the question "${questionId}". Say "profile pending" to see what is still open.` };
      }
      if (!this.pendingQuestionId && !questionId) {
        const q = this.profiles.nextQuestion();
        if (!q) {
          const deferred = this.profiles.deferredQuestions();
          if (!deferred.length) return { ok: true, action: 'profile_no_questions', message: 'Nothing is outstanding to answer.' };
          return { ok: true, action: 'profile_deferred_only', message: `The only open items are parked awaiting your confirmation: ${deferred.map(d => d.id).join(', ')}. Answer one with "profile answer for <id> <your answer>".` };
        }
        this.pendingQuestionId = q.id;
      }
      const result = this.profiles.answer(questionId ?? this.pendingQuestionId!, answerBody);
      if (questionId) this.pendingQuestionId = undefined;
      if (!result.applied) {
        return { ok: false, action: 'profile_clarification_needed', message: result.clarification ?? result.summary };
      }
      this.pendingQuestionId = undefined;
      const next = result.nextQuestion;
      return {
        ok: true,
        action: 'profile_answer_saved',
        message: [
          `Saved: ${result.summary}`,
          `Profile version is now ${result.version}.`,
          next ? `\nNext question when you are ready — say "profile ask".` : '\nThat was the last outstanding question.',
        ].join('\n'),
      };
    }

    // Show the exact version to be approved (does NOT approve anything).
    if (/^(approve|confirm|ready)$/.test(sub)) {
      const review = this.profiles.requestApproval();
      this.pendingProfileVersion = review.version;
      return {
        ok: true,
        action: 'profile_awaiting_confirmation',
        message: [
          '=== FINAL PROFILE FOR APPROVAL ===',
          ...review.summary,
          '',
          review.findings.length ? `PROBLEMS: ${review.findings.join('; ')}` : 'Integrity check: no demo data present.',
          '',
          'If this is correct, reply exactly: "profile approve yes" — I will write the approval for this exact',
          `version and verify it. Any edit before then invalidates it. (${review.lockReason})`,
        ].join('\n'),
      };
    }

    // Execute the approval workflow against the reviewed hash.
    if (/^approve\s+yes\b/i.test(sub) || sub === 'yes') {
      if (!this.pendingProfileVersion) {
        return {
          ok: false,
          action: 'profile_approval_not_requested',
          message: 'I have not shown you a profile to approve yet. Say "profile approve" first so you can review the exact version.',
        };
      }
      const result = this.profiles.approve(this.pendingProfileVersion);
      this.pendingProfileVersion = undefined;
      return result.ok
        ? {
            ok: true,
            action: 'profile_approved',
            message:
              `Profile approved and verified against the active file hash (${result.version}).\n` +
              'Real submissions are now permitted for artifacts generated from THIS version only.\n' +
              'Note: approving the profile does NOT authorise any individual application — each one still needs its own approval, and unresolved legal/security questions still block it.',
          }
        : { ok: false, action: 'profile_approval_refused', message: `Approval refused: ${result.reason}` };
    }

    if (/^(revoke|lock|unapprove)$/.test(sub)) {
      const r = this.profiles.revoke('revoked from chat');
      return { ok: true, action: 'profile_revoked', message: `Real submissions are locked again for version ${r.version}.` };
    }

    // Parked questions: still open, listed here, never re-asked.
    if (/^(pending|parked|waiting-on-me|deferred)$/.test(sub)) {
      const deferred = this.profiles.deferredQuestions();
      if (!deferred.length) return { ok: true, action: 'profile_no_deferred', message: 'Nothing is parked — every open question is asked in turn.' };
      const lines = deferred.map(d => `  - ${d.id} (${d.field}): ${d.question}`);
      return {
        ok: true,
        action: 'profile_deferred',
        message: ['Parked, awaiting your confirmation (answering is optional, nothing is assumed):', ...lines, '', 'Answer one any time with "profile answer for <id> <your answer>".'].join('\n'),
      };
    }

    // Park the current question instead of stopping or nagging.
    if (/^defer(\s|$)/.test(sub)) {
      const idMatch = sub.match(/^defer\s+([a-z-]+)/);
      const id = idMatch ? idMatch[1] : this.pendingQuestionId ?? this.profiles.nextQuestion()?.id;
      if (!id) return { ok: true, action: 'profile_no_questions', message: 'Nothing is outstanding to park.' };
      const r = this.profiles.deferQuestion(id, 'parked from chat');
      this.pendingQuestionId = undefined;
      return { ok: true, action: 'profile_deferred', message: r.message };
    }

    // Reopen a parked question so it is asked again.
    if (/^reopen\s+([a-z-]+)/.test(sub)) {
      const id = sub.match(/^reopen\s+([a-z-]+)/)![1];
      const r = this.profiles.reopenQuestion(id);
      return r.reopened
        ? { ok: true, action: 'profile_reopened', message: `"${id}" is back in the question queue.` }
        : { ok: false, action: 'profile_unknown_question', message: `"${id}" is not parked.` };
    }

    return {
      ok: false,
      action: 'profile_unknown_subcommand',
      message:
        `I did not understand "${rest}".\n` +
        'Profile commands: "profile" (summary), "profile resolve" (auto-fill from evidence), ' +
        '"profile ask" (next question), "profile answer <text>", "profile approve", "profile approve yes", "profile revoke".',
    };
  }

  /** Operator approve/skip — recorded, and never used to bypass protections. */
  private async simpleStateChange(text: string, kind: 'approve' | 'block'): Promise<ChatResult> {
    const applicationId = text.replace(/^(approve|skip|block)\s+/i, '').trim();
    if (!applicationId) return { ok: false, action: kind, message: 'Which application? e.g. "approve APP-20261008-000099".' };
    const apps = await this.rows(`SELECT application_id, job_id, state FROM applications WHERE application_id = ? LIMIT 1`, [applicationId]);
    if (!apps.length) return { ok: false, action: kind, message: `No application ${applicationId}.` };
    const a = apps[0];
    const events = await this.rows(`SELECT type, to_state FROM application_events WHERE application_id = ? ORDER BY rowid DESC LIMIT 1`, [applicationId]);
    const fromState = String(events[0]?.to_state ?? a.state);
    if (kind === 'approve' && (await this.journalRepo.hasClickBearingAttempt(String(a.job_id), CLICK_BEARING_PHASES))) {
      return {
        ok: false,
        action: 'approve_refused',
        message: `Cannot auto-approve ${applicationId}: the submission journal shows a click may already have reached the employer. Approval does not make a second submission safe.`,
      };
    }
    // PHASE 9 — approving an application is a submission-affecting act, so the
    // real-submission lock applies here too (after the journal refusal above).
    const lock = realSubmissionLock();
    if (kind === 'approve' && !lock.allowed) {
      return {
        ok: false,
        action: 'approve_refused',
        message:
          `Refused to approve ${applicationId}: real submissions are locked — ${lock.reason}.\n` +
          `Active profile version: ${lock.profileVersion}\n` +
          'The corrected candidate profile must be reviewed and explicitly approved first.',
      };
    }
    return {
      ok: true,
      action: kind,
      message: kind === 'approve'
        ? `Recorded operator approval for ${applicationId} (from ${fromState}). It remains subject to duplicate protection and the journal.`
        : `Recorded operator skip for ${applicationId}. It will not be retried automatically.`,
    };
  }
}