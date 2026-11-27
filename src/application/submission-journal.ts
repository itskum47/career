/**
 * Phase 6W/6X — Submission journal.
 *
 * A real Submit click is IRREVERSIBLE, so the intent to click must be durable
 * BEFORE the click, not after it. Measured failure this prevents: one real
 * click at 10:41:03.612 (APP-20261008-000099) followed by a process crash left
 * no trace anywhere, so the next run had no knowledge of the click.
 *
 * Two sinks, both append-only and secret-free (method/host/path/status/timing):
 *   - FileSubmissionJournal (default): JSONL under data/submission-journal/,
 *     written synchronously so it survives an immediate process kill even when
 *     the database was never touched.
 *   - SubmissionJournalRepository (DB): injected by callers that want the
 *     database to know (the duplicate guard reads it).
 *
 * Journal writes must never fail an application: they are best-effort and
 * always logged, never thrown.
 */

import * as fs from 'fs';

export type SubmissionJournalPhase = 'started' | 'request' | 'response' | 'confirmed' | 'uncertain' | 'failed';

export interface SubmissionJournalEntry {
  applicationId: string;
  jobId: string;
  candidateId?: string;
  companyId?: string;
  applicationRoute?: string;
  atsType?: string;
  phase: SubmissionJournalPhase;
  method?: string;
  host?: string;
  path?: string;
  status?: number | null;
  resourceType?: string | null;
  elapsedMs?: number;
  sessionId?: string;
  detail?: string;
}

export interface SubmissionJournalSink {
  append(entry: SubmissionJournalEntry): Promise<void>;
}

/** Phases that mean "a submit may have reached the ATS" — duplicate-protecting. */
export const CLICK_BEARING_PHASES: readonly SubmissionJournalPhase[] = [
  'started',
  'request',
  'response',
  'confirmed',
  'uncertain',
];

/**
 * Append-only JSONL journal. `appendSync` is used so the entry hits disk before
 * the click even if the process dies immediately afterwards.
 */
export class FileSubmissionJournal implements SubmissionJournalSink {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir || `${process.cwd()}/data/submission-journal`;
  }

  filePath(applicationId: string): string {
    return `${this.dir}/${applicationId}.jsonl`;
  }

  /** Synchronous write — safe to call immediately before an irreversible action. */
  appendSync(entry: SubmissionJournalEntry): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const record = { ...entry, createdAt: new Date().toISOString() };
    fs.appendFileSync(this.filePath(entry.applicationId), `${JSON.stringify(record)}\n`, 'utf8');
  }

  async append(entry: SubmissionJournalEntry): Promise<void> {
    this.appendSync(entry);
  }

  read(applicationId: string): SubmissionJournalEntry[] {
    const file = this.filePath(applicationId);
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as SubmissionJournalEntry);
  }

  /**
   * Durable duplicate-protection lookup that does NOT depend on the database:
   * scans every journal file for a click-bearing entry for this job. The DB can
   * be lost or reset (tests do it routinely) and the click must still be
   * remembered.
   */
  async hasClickBearingAttempt(
    jobId: string,
    clickBearingPhases: readonly SubmissionJournalPhase[]
  ): Promise<{ phase: string; applicationId: string; createdAt?: string } | null> {
    if (!fs.existsSync(this.dir)) return null;
    for (const file of fs.readdirSync(this.dir).filter(f => f.endsWith('.jsonl'))) {
      const lines = fs.readFileSync(`${this.dir}/${file}`, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as SubmissionJournalEntry;
          if (entry.jobId === jobId && clickBearingPhases.includes(entry.phase)) {
            return { phase: entry.phase, applicationId: entry.applicationId, createdAt: (entry as any).createdAt };
          }
        } catch {
          // A truncated line must never break protection.
        }
      }
    }
    return null;
  }
}

/**
 * Fan-out sink: writes to every configured sink, logging (never throwing) when
 * one fails, so a journal problem can never abort an application.
 */
export class CompositeSubmissionJournal implements SubmissionJournalSink {
  constructor(private readonly sinks: SubmissionJournalSink[]) {}

  appendSync(entry: SubmissionJournalEntry): void {
    for (const sink of this.sinks) {
      try {
        if (sink instanceof FileSubmissionJournal) sink.appendSync(entry);
      } catch (error) {
        console.error('[submission-journal] sink failed', error);
      }
    }
  }

  async append(entry: SubmissionJournalEntry): Promise<void> {
    for (const sink of this.sinks) {
      try {
        await sink.append(entry);
      } catch (error) {
        console.error('[submission-journal] sink failed', error);
      }
    }
  }
}