/**
 * Phase 8 — Operator approval wait (human-in-the-loop).
 *
 * A real Submit click is irreversible, and some ATS forms require a *human* to
 * complete a security challenge in a VISIBLE browser before the submission can
 * proceed. The agent must never solve, extract, replay or spoof that challenge.
 *
 * This module lets the run PAUSE with the browser window still open while the
 * operator:
 *   1. completes the CAPTCHA/security interaction themselves, and
 *   2. explicitly authorises the retry,
 * by writing an approval file from chat. The run then continues in the SAME
 * browser session — same form state, same committed attachments — and performs
 * at most ONE click.
 *
 * Safety rules encoded here:
 *   - approval is per job id, never blanket;
 *   - when the submission journal already holds a click-bearing phase for the
 *     job, the approval file must explicitly acknowledge that a duplicate is
 *     possible, otherwise the retry is refused;
 *   - a timeout leaves the application paused with NO journal entry and NO click;
 *   - one approval authorises exactly one continuation.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface OperatorApproval {
  jobId: string;
  approved: boolean;
  approvedBy?: string;
  approvedAt?: string;
  note?: string;
  /** Required when the journal already records a click for this job. */
  acknowledgeUncertain?: boolean;
}

export function approvalDir(): string {
  return `${process.cwd()}/data/operator-approvals`;
}

export function approvalFileFor(jobId: string): string {
  const safe = jobId.replace(/[^A-Za-z0-9._-]+/g, '_');
  return path.join(approvalDir(), `${safe}.json`);
}

/** Write an operator approval from chat. Returns the file written. */
export function recordOperatorApproval(approval: OperatorApproval): string {
  fs.mkdirSync(approvalDir(), { recursive: true });
  const file = approvalFileFor(approval.jobId);
  fs.writeFileSync(file, JSON.stringify({ ...approval, approvedAt: approval.approvedAt ?? new Date().toISOString() }, null, 2), 'utf8');
  return file;
}

export function readOperatorApproval(jobId: string): OperatorApproval | null {
  const file = approvalFileFor(jobId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as OperatorApproval;
  } catch {
    return null;
  }
}

export interface ApprovalWaitResult {
  approved: boolean;
  timedOut: boolean;
  waitedMs: number;
  approval?: OperatorApproval;
  reason: string;
}

/**
 * Wait for an operator approval file while the browser stays open.
 *
 * @param journalClickBearing  true when a previous attempt already clicked
 *                              Submit for this job (forces acknowledgement)
 */
export async function awaitOperatorApproval(input: {
  jobId: string;
  timeoutMs: number;
  pollMs?: number;
  journalClickBearing: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<ApprovalWaitResult> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const poll = input.pollMs ?? 2000;
  const started = now();

  while (true) {
    const approval = readOperatorApproval(input.jobId);
    if (approval && approval.approved === true) {
      // Per-application and uncertainty-aware.
      if (approval.jobId !== input.jobId) {
        return {
          approved: false, timedOut: false, waitedMs: now() - started,
          reason: `approval file targets ${approval.jobId}, not ${input.jobId}`,
        };
      }
      if (input.journalClickBearing && approval.acknowledgeUncertain !== true) {
        return {
          approved: false, timedOut: false, waitedMs: now() - started, approval,
          reason: 'a previous Submit click is journalled for this job; the approval must explicitly acknowledge the duplicate risk',
        };
      }
      return {
        approved: true, timedOut: false, waitedMs: now() - started, approval,
        reason: `operator approved by ${approval.approvedBy ?? 'operator'}`,
      };
    }
    if (now() - started >= input.timeoutMs) {
      return {
        approved: false, timedOut: true, waitedMs: now() - started,
        reason: `no operator approval within ${input.timeoutMs}ms — paused without clicking Submit`,
      };
    }
    await sleep(poll);
  }
}

/** Remove an approval once consumed so it cannot authorise a second click. */
export function consumeOperatorApproval(jobId: string): void {
  const file = approvalFileFor(jobId);
  try { fs.rmSync(file); } catch { /* already gone */ }
}