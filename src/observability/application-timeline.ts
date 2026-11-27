/**
 * Phase 7 — Per-application observability timeline.
 *
 * Builds one ordered, human-readable timeline per application from the durable
 * records (application_events, submission_journal) so an operator can answer
 * "what happened, in what order, how long, where did it stop, did a human get
 * involved" without reading logs. No secrets: only stage, duration, status and
 * sanitised message.
 */

import type { SubmissionJournalRow } from '../database/repositories.ts';

export interface TimelineEntry {
  at: string;
  stage: string;
  status: 'ok' | 'warn' | 'failed' | 'human' | 'blocked';
  message: string;
  durationMs?: number;
}

export interface ApplicationTimeline {
  applicationId: string;
  jobId?: string;
  company?: string;
  role?: string;
  entries: TimelineEntry[];
  /** First failing stage, if the timeline ends badly. */
  firstFailingStage?: string;
  humanIntervention: boolean;
  totalEntries: number;
}

interface EventLike {
  type: string;
  from_state?: string | null;
  to_state?: string;
  message?: string;
  timestamp?: string | Date;
}

const STAGE_FOR_EVENT: Record<string, string> = {
  state_transition: 'state',
  form_field_filled: 'form',
  human_escalation: 'questions',
  user_answer_received: 'questions',
  submission_attempted: 'submit',
  submission_confirmed: 'confirmation',
  submission_failed: 'submit',
  field_fill_failed: 'form',
  status_changed: 'state',
};

const FAILURE_MARKERS: Array<[RegExp, string]> = [
  [/paused for \d+ user questions/i, 'questions'],
  [/caption|captcha|challenge/i, 'submit'],
  [/attachment/i, 'uploads'],
  [/validation/i, 'validation'],
  [/uncertain/i, 'confirmation'],
  [/attachment gate/i, 'uploads'],
];

/** Strip anything that could carry a token from an operator-facing message. */
export function sanitiseMessage(message: string): string {
  return message
    .replace(/([?&](?:[A-Za-z0-9_]*token|[A-Za-z0-9_]*key|auth[^=&]*)=)[^&\s]*/gi, '$1[redacted]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[hash]')
    .slice(0, 240);
}

/**
 * Merge application events and journal rows into one timeline. Events are the
 * narrative; journal rows prove what happened around the click.
 */
export function buildTimeline(input: {
  applicationId: string;
  jobId?: string;
  company?: string;
  role?: string;
  events: EventLike[];
  journal?: SubmissionJournalRow[];
}): ApplicationTimeline {
  const entries: TimelineEntry[] = [];

  for (const e of input.events) {
    const at = e.timestamp instanceof Date ? e.timestamp.toISOString() : (e.timestamp ?? new Date(0).toISOString());
    const message = sanitiseMessage(e.message ?? e.to_state ?? e.type);
    let status: TimelineEntry['status'] = 'ok';
    if (/failed|error/i.test(e.type)) status = 'failed';
    else if (/escalation/i.test(e.type)) status = 'human';
    else if (/uncertain|paused/i.test(message)) status = 'warn';

    entries.push({ at, stage: STAGE_FOR_EVENT[e.type] ?? e.type, status, message });
  }

  for (const j of input.journal ?? []) {
    entries.push({
      at: j.createdAt ?? new Date(0).toISOString(),
      stage: 'journal',
      status: j.phase === 'uncertain' ? 'warn' : j.phase === 'failed' ? 'failed' : 'ok',
      message: `journal:${j.phase}${j.method ? ` ${j.method} ${j.host ?? ''}${j.path ?? ''}`.trimEnd() : ''}${j.status ? ` → ${j.status}` : ''}`,
    });
  }

  entries.sort((a, b) => a.at.localeCompare(b.at));

  const failed = entries.find(e => e.status === 'failed');
  const firstFailingStage = failed?.stage ?? (entries.some(e => /uncertain/i.test(e.message)) ? 'confirmation' : undefined);

  return {
    applicationId: input.applicationId,
    jobId: input.jobId,
    company: input.company,
    role: input.role,
    entries,
    firstFailingStage,
    humanIntervention: entries.some(e => e.status === 'human'),
    totalEntries: entries.length,
  };
}

/** Compact chat rendering (one line per meaningful step). */
export function renderTimeline(t: ApplicationTimeline, max = 20): string {
  const header = `${t.company ?? ''}${t.role ? ` — ${t.role}` : ''} (${t.applicationId})`.trim();
  const lines = t.entries.slice(-max).map(e => `  ${e.at.slice(11, 19)}  ${e.stage.padEnd(11)} ${e.status.padEnd(6)} ${e.message}`);
  const footer = t.firstFailingStage
    ? `First failing stage: ${t.firstFailingStage}`
    : t.humanIntervention
      ? 'Human intervention was required'
      : 'No failure detected';
  return [`Timeline — ${header}`, ...lines, footer].join('\n');
}