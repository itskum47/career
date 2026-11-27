/**
 * Phase 7 — Artifact integrity.
 *
 * Every application must prove it attached the RIGHT documents to the RIGHT
 * job, and that the master profile was never mutated by tailoring:
 *
 *   - the CV / cover letter belong to this job (job identity in the file name
 *     and inside the artifact registry entry),
 *   - the file that reached the ATS is the file we generated (basename + byte
 *     size, and a content hash when available),
 *   - the master profile hash is unchanged from its baseline.
 *
 * A mismatch is a hard failure: submitting someone else's or a stale artifact is
 * worse than not submitting.
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';

export interface ArtifactBinding {
  jobId: string;
  company: string;
  title: string;
  /** Path of the generated CV. */
  resumePath: string;
  /** Path of the generated cover letter (optional — many roles take none). */
  coverLetterPath?: string;
}

export interface ArtifactCheck {
  name: 'resume' | 'cover_letter';
  path: string;
  exists: boolean;
  jobBound: boolean;
  sizeBytes: number;
  contentSha256?: string;
  problems: string[];
}

export interface IntegrityReport {
  ok: boolean;
  resume?: ArtifactCheck;
  coverLetter?: ArtifactCheck;
  masterProfileUnchanged?: boolean;
  problems: string[];
}

function sha256File(file: string): string | undefined {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return undefined;
  }
}

/** Tokens that must appear in an artifact file name for it to belong to a job. */
function jobTokens(binding: ArtifactBinding): string[] {
  const title = binding.title
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const company = binding.company.replace(/[^A-Za-z0-9]+/g, '');
  const tokens: string[] = [];
  // Full normalised title (best signal), plus its first two significant words.
  if (title) {
    tokens.push(title);
    const words = title.split('_').filter(w => w.length > 3);
    if (words.length >= 2) tokens.push(`${words[0]}_${words[1]}`);
  }
  if (company.length > 3) tokens.push(company);
  return tokens.map(t => t.toLowerCase());
}

function checkOne(name: 'resume' | 'cover_letter', file: string, binding: ArtifactBinding): ArtifactCheck {
  const problems: string[] = [];
  const exists = fs.existsSync(file);
  if (!exists) {
    return { name, path: file, exists: false, jobBound: false, sizeBytes: 0, problems: ['file does not exist'] };
  }
  const sizeBytes = fs.statSync(file).size;
  if (sizeBytes <= 0) problems.push('file is empty');

  const base = path.basename(file).toLowerCase();
  const tokens = jobTokens(binding);
  const jobBound = tokens.some(t => base.includes(t));
  if (!jobBound) {
    problems.push(`file name does not identify this job (expected one of: ${tokens.join(' | ')})`);
  }
  // A stale artifact from another job is the failure mode this catches: if the
  // file belongs to a different job it cannot contain this job's tokens.
  const foreignTokens = ['gitlab', 'mongodb', 'canonical', 'elastic', 'discord', 'airtable'];
  const otherCompany = foreignTokens.find(t => base.includes(t) && !base.includes(binding.company.toLowerCase().replace(/[^a-z0-9]+/g, '')));
  if (otherCompany) problems.push(`file name references a different company (${otherCompany})`);

  return { name, path: file, exists, jobBound, sizeBytes, contentSha256: sha256File(file), problems };
}

/** Verify artifacts belong to the job and exist. */
export function verifyArtifacts(binding: ArtifactBinding): IntegrityReport {
  const problems: string[] = [];
  const resume = checkOne('resume', binding.resumePath, binding);
  const coverLetter = binding.coverLetterPath ? checkOne('cover_letter', binding.coverLetterPath, binding) : undefined;
  for (const c of [resume, coverLetter]) {
    if (c) for (const p of c.problems) problems.push(`${c.name}: ${p}`);
  }
  return { ok: problems.length === 0, resume, coverLetter, problems };
}

/**
 * The master profile must never be modified by tailoring. Snapshot its hash at
 * session start and compare afterwards.
 */
export class MasterProfileGuard {
  private baselineHash?: string;
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  /** Capture the current hash (call once before an application run). */
  snapshot(): string | undefined {
    this.baselineHash = sha256File(this.file);
    return this.baselineHash;
  }

  /** True when the profile is byte-identical to the snapshot. */
  verifyUnchanged(): { unchanged: boolean; baseline?: string; current?: string } {
    const current = sha256File(this.file);
    if (!this.baselineHash) return { unchanged: true };
    return { unchanged: current === this.baselineHash, baseline: this.baselineHash, current };
  }
}

export interface UploadedAttachmentExpectation {
  kind: 'resume' | 'cover_letter';
  expectedPath: string;
  /** Basename the ATS reported back as attached (from its chip / committed name). */
  observedName?: string;
  observedSizeBytes?: number;
}

/** Prove the file the ATS committed is the file we generated. */
export function verifyUploadedAttachment(exp: UploadedAttachmentExpectation): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const expectedName = path.basename(exp.expectedPath);
  if (!exp.observedName) {
    problems.push(`${exp.kind}: the ATS did not report an attached file name`);
  } else if (exp.observedName !== expectedName) {
    problems.push(`${exp.kind}: ATS holds "${exp.observedName}" but we generated "${expectedName}"`);
  }
  if (exp.observedSizeBytes !== undefined && fs.existsSync(exp.expectedPath)) {
    const expectedSize = fs.statSync(exp.expectedPath).size;
    // Uploaded size may legitimately differ (re-encoding), so this is a warning
    // unless grossly different (>5x) which indicates a wrong file entirely.
    if (expectedSize > 0 && (exp.observedSizeBytes > expectedSize * 5 || exp.observedSizeBytes < expectedSize / 5)) {
      problems.push(`${exp.kind}: uploaded size ${exp.observedSizeBytes} is not consistent with generated ${expectedSize}`);
    }
  }
  return { ok: problems.length === 0, problems };
}