/**
 * Phase 10 — Evidence collection for candidate-profile resolution.
 *
 * The agent resolves profile fields itself wherever RELIABLE evidence exists, so
 * the candidate is only interrupted for facts no evidence can settle. That makes
 * the trust classification below the most important part of the system:
 *
 *   candidate_provided — the candidate's own document (the CV). Reliable.
 *   user_confirmed    — an answer the candidate gave in chat. Most reliable for
 *                       personal facts; remembered across sessions.
 *   system_record     — what the agent actually did (journals, DB rows). Reliable
 *                       as a record of EVENTS, never as a record of a
 *                       qualification.
 *   ai_generated      — reports, summaries, prior chat answers written by an
 *                       agent. NOT independent evidence about a person.
 *   generated         — CVs, cover letters, cached artifacts. NOT evidence.
 *   placeholder       — the withdrawn demo profile. NOT evidence.
 *
 * Only `reliable` evidence may resolve a field. Generated documents and previous
 * agent statements are collected (so they can be reported as "seen but not
 * trusted") but can never resolve anything about the candidate.
 */

import * as fs from 'fs';
import * as path from 'path';

export type EvidenceKind =
  | 'candidate_provided'
  | 'user_confirmed'
  | 'system_record'
  | 'ai_generated'
  | 'generated'
  | 'placeholder';

export interface EvidenceItem {
  kind: EvidenceKind;
  /** Short human-readable provenance, recorded alongside any resolved value. */
  source: string;
  locator: string;
  /** True only for evidence allowed to resolve a profile field. */
  reliable: boolean;
  /** Optional payload (user-confirmed answers, matched text). */
  data?: unknown;
}

const RELIABLE_KINDS: EvidenceKind[] = ['candidate_provided', 'user_confirmed', 'system_record'];

export function isReliable(e: EvidenceItem): boolean {
  return e.reliable || RELIABLE_KINDS.includes(e.kind);
}

export const USER_ANSWERS_PATH = 'data/profile-audit/user-answers.json';

export interface UserAnswer {
  field: string;
  value: unknown;
  answeredAt: string;
  note?: string;
}

/** Confirmed answers the candidate has already given, keyed by dotted field. */
export function readUserAnswers(cwd: string = process.cwd()): Map<string, UserAnswer> {
  const file = path.join(cwd, USER_ANSWERS_PATH);
  const out = new Map<string, UserAnswer>();
  if (!fs.existsSync(file)) return out;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as UserAnswer[];
    for (const a of parsed) if (a?.field) out.set(a.field, a);
  } catch {
    // A corrupt store must never be treated as evidence.
    return new Map();
  }
  return out;
}

export function writeUserAnswers(answers: UserAnswer[], cwd: string = process.cwd()): string {
  const file = path.join(cwd, USER_ANSWERS_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(answers, null, 2)}\n`, 'utf8');
  return file;
}

export interface EvidenceBundle {
  /** The candidate's own CV, verbatim. */
  cvText: string;
  cvSource: string;
  userAnswers: Map<string, UserAnswer>;
  /** Everything that was found but is NOT allowed to resolve a field. */
  untrustedSeen: EvidenceItem[];
  /** Event records (journals / application rows) — evidence of what happened. */
  systemRecords: EvidenceItem[];
}

function readIfExists(file: string): string | null {
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

/**
 * Collect all evidence available locally.
 *
 * Deliberately conservative: an artifact that looks like evidence (an old PDF
 * CV full of confident claims) is still recorded as UNTRUSTED so the candidate
 * can be told it was seen and why it was not used.
 */
export function collectEvidence(cwd: string = process.cwd()): EvidenceBundle {
  const cvPath = path.join(cwd, 'data/profile-audit/source-cv-extract.txt');
  const cvText = readIfExists(cvPath) ?? '';

  const untrustedSeen: EvidenceItem[] = [];

  // Generated artifacts: never evidence about the candidate.
  for (const dir of ['output/cv', 'output/cover-letters', path.join(cwd, '..', '..', 'cv')]) {
    const abs = path.resolve(cwd, dir);
    let count = 0;
    try {
      if (fs.existsSync(abs)) count = fs.readdirSync(abs).filter(f => fs.statSync(path.join(abs, f)).isFile()).length;
    } catch {
      count = 0;
    }
    if (count > 0) {
      untrustedSeen.push({
        kind: 'generated',
        source: `previously generated CV/cover-letter artifacts (${count} file(s))`,
        locator: path.relative(cwd, abs) || abs,
        reliable: false,
      });
    }
  }

  // The withdrawn demo profile and anything derived from it.
  const backupDir = path.join(cwd, 'profile/backups');
  try {
    if (fs.existsSync(backupDir)) {
      for (const f of fs.readdirSync(backupDir)) {
        untrustedSeen.push({
          kind: 'placeholder',
          source: 'withdrawn demo profile backup',
          locator: `profile/backups/${f}`,
          reliable: false,
        });
      }
    }
  } catch {
    /* ignore */
  }

  // Agent-written reports: pointers to evidence, never evidence themselves.
  for (const f of ['PHASE9_PROFILE_RECOVERY_REPORT.md', 'PHASE10_ZERO_FRICTION_REPORT.md']) {
    const abs = path.join(cwd, 'benchmarks', f);
    if (fs.existsSync(abs)) {
      untrustedSeen.push({
        kind: 'ai_generated',
        source: 'agent-written phase report',
        locator: `benchmarks/${f}`,
        reliable: false,
      });
    }
  }

  // System records: journals prove what was submitted, nothing about the person.
  const systemRecords: EvidenceItem[] = [];
  const journalDir = path.join(cwd, 'data/submission-journal');
  try {
    if (fs.existsSync(journalDir)) {
      const journals = fs.readdirSync(journalDir).filter(f => f.endsWith('.jsonl'));
      if (journals.length) {
        systemRecords.push({
          kind: 'system_record',
          source: `submission journals (${journals.length})`,
          locator: 'data/submission-journal/*.jsonl',
          reliable: true,
          data: journals,
        });
      }
    }
  } catch {
    /* ignore */
  }

  return {
    cvText,
    cvSource: 'CV_HPE_DevOps_Engineer_1213661_2026-09-30.pdf (candidate-provided)',
    userAnswers: readUserAnswers(cwd),
    untrustedSeen,
    systemRecords,
  };
}
