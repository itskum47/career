/**
 * Phase 8 — operator approval wait (human-in-the-loop, CAPTCHA recovery).
 *
 * Proves the safety contract of the pause that keeps a VISIBLE browser open
 * while the operator completes a security challenge and authorises the retry:
 * per-job approval, mandatory duplicate-risk acknowledgement, clean timeout,
 * and single use.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  awaitOperatorApproval,
  recordOperatorApproval,
  readOperatorApproval,
  consumeOperatorApproval,
  approvalDir,
  approvalFileFor,
} from '../../../src/application/operator-approval.ts';

const JOB = 'JOB-greenhouse:singlestore:cloud-platform-engineer-8940bb864b';

describe('8 — operator approval wait', () => {
  let dir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-approval-'));
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(originalCwd);
    try { fs.rmSync(dir, { recursive: true }); } catch { /* cleaned */ }
  });

  it('times out cleanly when no approval arrives — no click, no journal', async () => {
    let clock = 0;
    const result = await awaitOperatorApproval({
      jobId: JOB,
      timeoutMs: 1000,
      pollMs: 100,
      now: () => clock,
      sleep: async () => { clock += 100; },
      journalClickBearing: true,
    });
    expect(result.approved).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.reason).toContain('no operator approval');
    expect(fs.existsSync(approvalFileFor(JOB))).toBe(false);
  });

  it('accepts an explicit approval and reports who authorised it', async () => {
    let clock = 0;
    recordOperatorApproval({ jobId: JOB, approved: true, approvedBy: 'user', acknowledgeUncertain: true });
    const result = await awaitOperatorApproval({
      jobId: JOB, timeoutMs: 5000, pollMs: 100,
      now: () => clock, sleep: async () => { clock += 100; },
      journalClickBearing: true,
    });
    expect(result.approved).toBe(true);
    expect(result.approval?.approvedBy).toBe('user');
  });

  it('refuses approval for a DIFFERENT job (approval is per application)', async () => {
    recordOperatorApproval({ jobId: 'JOB-other', approved: true, acknowledgeUncertain: true });
    let c = 0;
    const result = await awaitOperatorApproval({
      jobId: JOB, timeoutMs: 300, pollMs: 100,
      now: () => c, sleep: async () => { c += 100; }, journalClickBearing: false,
    });
    expect(result.approved).toBe(false);
    expect(readOperatorApproval('JOB-other')?.jobId).toBe('JOB-other');
  });

  it('requires an explicit duplicate-risk acknowledgement when a click is already journalled', async () => {
    recordOperatorApproval({ jobId: JOB, approved: true, approvedBy: 'user' }); // no acknowledgement
    let c = 0;
    const result = await awaitOperatorApproval({
      jobId: JOB, timeoutMs: 300, pollMs: 100,
      now: () => c, sleep: async () => { c += 100; }, journalClickBearing: true,
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('duplicate risk');
  });

  it('consumes the approval so it cannot authorise a second click', async () => {
    recordOperatorApproval({ jobId: JOB, approved: true, acknowledgeUncertain: true });
    expect(readOperatorApproval(JOB)).not.toBeNull();
    consumeOperatorApproval(JOB);
    expect(readOperatorApproval(JOB)).toBeNull();
  });

  it('ignores a malformed approval file (fails safe)', async () => {
    fs.mkdirSync(approvalDir(), { recursive: true });
    fs.writeFileSync(approvalFileFor(JOB), '{ not json', 'utf8');
    expect(readOperatorApproval(JOB)).toBeNull();
  });
});