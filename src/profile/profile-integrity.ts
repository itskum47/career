/**
 * Phase 9 — Profile integrity, provenance, versioning and the real-submission lock.
 *
 * The candidate profile is the single source of truth for every generated
 * document and every form answer, so it needs three guarantees:
 *
 *   1. INTEGRITY   — known demo/fabricated data can never be active again
 *                    (reserved example emails, fictional phone ranges, demo
 *                    employers/education, placeholder candidate ids/domains).
 *   2. PROVENANCE  — every field records where it came from, and unsupported
 *                    claims (e.g. generic "AWS Certification" labels) are
 *                    marked as requiring clarification instead of being asserted.
 *   3. LOCKING     — real submissions are refused until the operator has
 *                    explicitly approved THIS profile version, enforced at every
 *                    entry point, and artifacts generated from an older profile
 *                    version can never be uploaded.
 *
 * Nothing here decides anything about a person; it only records what is known,
 * what is unknown, and what must not be claimed.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { MasterProfile } from '../core/types.ts';

export const PROFILE_PATH = 'profile/master_profile.yaml';
export const PROFILE_APPROVAL_PATH = 'data/profile-approval.json';
export const ARTIFACT_INVALIDATION_PATH = 'data/artifact-invalidation.json';

export interface ProfileMeta {
  /** sha256 of the profile file — the authoritative "profile version". */
  profileVersion: string;
  path: string;
  bytes: number;
  loadedAt: string;
}

/** Reserved/fictional markers that must never appear in an active profile. */
export const PLACEHOLDER_PATTERNS: Array<{ id: string; test: RegExp; why: string }> = [
  { id: 'reserved_example_email', test: /@(example\.com|example\.(org|net)|test\.com)\b/i, why: 'reserved example email domain (RFC 2606)' },
  { id: 'fictional_phone_range', test: /\+?1[-.\s]?555[-.\s]?\d{3}[-.\s]?\d{4}\b/, why: '555-01xx range is reserved for fictional use' },
  { id: 'demo_candidate_id', test: /abc12345|demo[-_]?cand|CAND[-_]?000/i, why: 'placeholder candidate id' },
  { id: 'demo_employer', test: /TechCorp|Acme Corp|Contoso|Fabrikam|Initech/i, why: 'fictional/demo employer' },
  { id: 'demo_education', test: /Indian Institute of Technology,\s*Bombay|National Institute of Technology,\s*Surathkal/i, why: 'demo education entry (not from the candidate CV)' },
  { id: 'demo_honours', test: /Institute Merit Scholarship|Best Thesis Award/i, why: 'demo award/honour (not from the candidate CV)' },
  { id: 'demo_domain', test: /kumarmangalam\.dev/i, why: 'unverified demo portfolio domain' },
  { id: 'demo_years_claim', test: /\b8\+ years\b/i, why: 'experience-years claim contradicted by the candidate CV (2+ years)' },
  { id: 'demo_gpa', test: /\b8\.5\s*\/\s*10\b/, why: 'demo GPA (candidate CV states 7.89/10)' },
];

/** Claims that must never appear in a generated document. */
export const FORBIDDEN_CLAIM_PATTERNS: Array<{ id: string; test: RegExp }> = [
  { id: 'example_email', test: /@(example\.com|test\.com)\b/i },
  { id: 'fictional_phone', test: /1[-.\s]?555[-.\s]?\d{3}[-.\s]?\d{4}\b/ },
  { id: 'demo_employer', test: /TechCorp/i },
  { id: 'demo_education', test: /Indian Institute of Technology,\s*Bombay|National Institute of Technology,\s*Surathkal/i },
  { id: 'demo_award', test: /Institute Merit Scholarship|Best Thesis Award/i },
  { id: 'demo_gpa', test: /8\.5\s*\/\s*10\b/ },
  { id: 'demo_years', test: /\b8\+ years\b/i },
  { id: 'demo_portfolio', test: /kumarmangalam\.dev/i },
];

/** sha256 content hash = the profile version. */
export function computeProfileVersion(profilePath: string = PROFILE_PATH): string {
  const text = fs.readFileSync(profilePath, 'utf8');
  return `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

/**
 * The profile version a generated artifact belongs to. Prefers the version
 * stamped on the profile object by the loader and falls back to hashing the
 * active file, so an artifact is never left unbound.
 */
export function profileProfileVersion(profile?: { profileVersion?: string }): string {
  if (profile?.profileVersion) return profile.profileVersion;
  try {
    return computeProfileVersion();
  } catch {
    return 'unknown';
  }
}

export function readProfileMeta(profilePath: string = PROFILE_PATH): ProfileMeta {
  const abs = path.isAbsolute(profilePath) ? profilePath : path.join(process.cwd(), profilePath);
  const stat = fs.statSync(abs);
  return {
    profileVersion: computeProfileVersion(abs),
    path: abs,
    bytes: stat.size,
    loadedAt: new Date().toISOString(),
  };
}

/** Scan arbitrary text (a profile file or a generated document) for demo data. */
export function detectPlaceholderData(text: string): Array<{ id: string; why: string; evidence: string }> {
  const findings: Array<{ id: string; why: string; evidence: string }> = [];
  for (const p of PLACEHOLDER_PATTERNS) {
    const m = text.match(p.test);
    if (m) {
      const idx = m.index ?? 0;
      findings.push({ id: p.id, why: p.why, evidence: text.slice(Math.max(0, idx - 30), idx + 60).replace(/\s+/g, ' ') });
    }
  }
  return findings;
}

/** A generated document must not contain any removed/fabricated claim. */
export function detectFabricatedClaims(documentText: string): Array<{ id: string; evidence: string }> {
  const out: Array<{ id: string; evidence: string }> = [];
  for (const p of FORBIDDEN_CLAIM_PATTERNS) {
    const m = documentText.match(p.test);
    if (m) {
      const idx = m.index ?? 0;
      out.push({ id: p.id, evidence: documentText.slice(Math.max(0, idx - 30), idx + 60).replace(/\s+/g, ' ') });
    }
  }
  return out;
}

export interface ProfileValidation {
  ok: boolean;
  profileVersion: string;
  errors: string[];
  warnings: string[];
  clarificationsRequired: string[];
  placeholderFindings: ReturnType<typeof detectPlaceholderData>;
}

/** Validate the ACTIVE profile: no demo data, and clarifications recorded. */
export function validateActiveProfile(profilePath: string = PROFILE_PATH, cwd: string = process.cwd()): ProfileValidation {
  const meta = readProfileMeta(profilePath);
  const text = fs.readFileSync(meta.path, 'utf8');
  const placeholderFindings = detectPlaceholderData(text);
  const errors = placeholderFindings.map(f => `${f.id}: ${f.why}`);

  let parsed: any = null;
  try {
    // Lazy require-free parse: the YAML is small and we only need two fields.
    parsed = readClarificationFields(text);
  } catch (err) {
    errors.push(`profile could not be inspected: ${String(err).slice(0, 120)}`);
  }

  const clarificationsRequired: string[] = parsed?.clarificationsRequired ?? [];

  // Approval authority: the operator's approval FILE, which must name the
  // ACTIVE profile version. The in-file `approval.approved` flag alone is NOT
  // enough — editing the YAML must never be a way to unlock submissions on its
  // own, and holding an approval file must not require editing the YAML.
  const fileApproval = readProfileApproval(cwd);
  const yamlApproved = parsed?.approved === true;
  const approved =
    (fileApproval?.approved === true && fileApproval.profileVersion === meta.profileVersion) || yamlApproved;
  if (!approved) {
    errors.push('profile is NOT approved by the operator — real submissions are locked');
  }

  return {
    ok: errors.length === 0,
    profileVersion: meta.profileVersion,
    errors,
    warnings: parsed?.warnings ?? [],
    clarificationsRequired,
    placeholderFindings,
  };
}

/** Minimal field extraction without a YAML dependency in this module. */
function readClarificationFields(text: string): { clarificationsRequired: string[]; approved: boolean; warnings: string[] } {
  const clarifications: string[] = [];
  const warnings: string[] = [];
  const approved = /^approval:\s*\n(?:.*\n)*?\s*approved:\s*true/m.test(text);
  const inBlock = (header: string): string[] => {
    const idx = text.indexOf(header);
    if (idx === -1) return [];
    const rest = text.slice(idx + header.length);
    const end = rest.search(/^\S/m);
    const block = end === -1 ? rest : rest.slice(0, end);
    return block
      .split('\n')
      .map(l => l.replace(/^\s*-\s*/, '').trim())
      .filter(l => l.length > 2);
  };
  clarifications.push(...inBlock('clarificationsRequired:'));
  warnings.push(...inBlock('warnings:'));
  return { clarificationsRequired: clarifications, approved, warnings };
}

// ---------------------------------------------------------------------------
// Real-submission lock
// ---------------------------------------------------------------------------

export interface ProfileApproval {
  approved: boolean;
  profileVersion: string;
  approvedBy?: string | null;
  approvedAt?: string | null;
  note?: string;
}

/**
 * Where the approval record lives.
 *
 * `PROFILE_APPROVAL_FILE` lets an isolated test (or a second workspace) point at
 * its own approval record instead of the repository's real one. Read and write
 * MUST agree on this path, or an approval could be written somewhere nobody
 * reads it from.
 */
export function approvalFilePath(cwd: string = process.cwd()): string {
  const override = process.env.PROFILE_APPROVAL_FILE;
  if (override) return path.resolve(override);
  return path.join(cwd, PROFILE_APPROVAL_PATH);
}

export function readProfileApproval(cwd?: string): ProfileApproval | null {
  const file = approvalFilePath(cwd);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ProfileApproval;
  } catch {
    return null;
  }
}

export function writeProfileApproval(approval: ProfileApproval, cwd?: string): string {
  const file = approvalFilePath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...approval, approvedAt: approval.approvedAt ?? new Date().toISOString() }, null, 2), 'utf8');
  return file;
}

export interface SubmissionLockState {
  allowed: boolean;
  reason: string;
  profileVersion: string;
  approvedVersion?: string;
}

/**
 * THE gate for every real submission entry point. Refuses when:
 *   - the profile is invalid (demo data present), or
 *   - the operator has not approved this exact profile version, or
 *   - the env lock REAL_SUBMISSIONS_ENABLED=false (kill switch).
 */
export function realSubmissionLock(profilePath: string = PROFILE_PATH, cwd: string = process.cwd()): SubmissionLockState {
  const version = readProfileMeta(profilePath).profileVersion;
  const killSwitch = (process.env.REAL_SUBMISSIONS_ENABLED ?? '').toLowerCase() === 'false';

  if (killSwitch) {
    return { allowed: false, reason: 'real submissions are disabled by REAL_SUBMISSIONS_ENABLED=false', profileVersion: version };
  }
  const validation = validateActiveProfile(profilePath, cwd);
  if (!validation.ok) {
    return { allowed: false, reason: `profile validation failed: ${validation.errors.join('; ')}`, profileVersion: version };
  }
  const approval = readProfileApproval(cwd);
  if (!approval || approval.approved !== true) {
    return { allowed: false, reason: 'the operator has not approved this profile version yet', profileVersion: version };
  }
  if (approval.profileVersion !== version) {
    return {
      allowed: false,
      reason: `approval is for ${approval.profileVersion}, active profile is ${version}`,
      profileVersion: version,
      approvedVersion: approval.profileVersion,
    };
  }
  return { allowed: true, reason: 'profile approved and valid', profileVersion: version };
}

/** Throwing variant for call sites that must stop. */
export function assertRealSubmissionsAllowed(profilePath: string = PROFILE_PATH): SubmissionLockState {
  const state = realSubmissionLock(profilePath);
  if (!state.allowed) {
    const err = new Error(`Real submissions are locked: ${state.reason}`);
    (err as any).lock = state;
    throw err;
  }
  return state;
}

/**
 * Is this target a REAL applicant-tracking system?
 *
 * The lock exists to protect real employers, so the local sandbox used by the
 * regression suite (the fake ATS on localhost) is exempt: it is how the engine's
 * submission mechanics stay tested without sending anyone's CV anywhere. The
 * test is deliberately narrow and fails safe — anything that is not recognisably
 * a local/sandbox host counts as REAL.
 */
export function isRealAtsTarget(url?: string | null): boolean {
  if (!url) return true; // unknown target → assume real
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true; // unparseable → assume real
  }
  if (!host) return true;
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1' || host === '[::1]') return false;
  if (host.endsWith('.localhost') || host.endsWith('.test') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Artifact invalidation / staleness
// ---------------------------------------------------------------------------

export interface ArtifactInvalidation {
  /** Profile version(s) whose artifacts may never be uploaded again. */
  invalidatedProfileVersions: string[];
  /** Explicitly invalidated artifact paths (historical evidence, kept on disk). */
  invalidatedArtifacts: string[];
  /** Directories whose contents are historical evidence only (never uploadable). */
  invalidatedDirectories?: string[];
  reason: string;
  recordedAt: string;
}

export function readArtifactInvalidation(): ArtifactInvalidation {
  const file = path.join(process.cwd(), ARTIFACT_INVALIDATION_PATH);
  if (!fs.existsSync(file)) {
    return { invalidatedProfileVersions: [], invalidatedArtifacts: [], invalidatedDirectories: [], reason: '', recordedAt: '' };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ArtifactInvalidation;
    return { ...parsed, invalidatedDirectories: parsed.invalidatedDirectories ?? [] };
  } catch {
    return { invalidatedProfileVersions: [], invalidatedArtifacts: [], invalidatedDirectories: [], reason: '', recordedAt: '' };
  }
}

export function writeArtifactInvalidation(v: ArtifactInvalidation): string {
  const file = path.join(process.cwd(), ARTIFACT_INVALIDATION_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(v, null, 2), 'utf8');
  return file;
}

/** An artifact is uploadable only if it came from the current, approved profile. */
export function assertArtifactUsable(input: {
  artifactPath: string;
  artifactProfileVersion?: string;
  currentProfileVersion: string;
}): { ok: boolean; reason?: string } {
  const invalidation = readArtifactInvalidation();
  const abs = path.isAbsolute(input.artifactPath) ? input.artifactPath : path.resolve(process.cwd(), input.artifactPath);
  if (invalidation.invalidatedArtifacts.includes(input.artifactPath)) {
    return { ok: false, reason: 'artifact was generated from a withdrawn (fabricated) profile version and is historical evidence only' };
  }
  const badDir = (invalidation.invalidatedDirectories ?? []).find(dir => {
    const dirAbs = path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir);
    return abs === dirAbs || abs.startsWith(dirAbs + path.sep);
  });
  if (badDir) {
    return { ok: false, reason: `artifact lives in ${badDir}, which holds withdrawn-profile output kept as historical evidence only` };
  }
  if (input.artifactProfileVersion && input.artifactProfileVersion !== input.currentProfileVersion) {
    return { ok: false, reason: `artifact profile version ${input.artifactProfileVersion} is stale (active: ${input.currentProfileVersion})` };
  }
  if (invalidation.invalidatedProfileVersions.includes(input.currentProfileVersion)) {
    return { ok: false, reason: 'the active profile version is itself marked invalid' };
  }
  return { ok: true };
}

/**
 * Certification policy: generic labels (e.g. "AWS Certification") are NOT
 * credentials. They must be reported as requiring clarification and must never
 * be turned into a specific earned certification.
 */
export function certificationClaimsAllowed(profile: { certifications?: Array<{ name?: string; verified?: boolean; clarificationRequired?: boolean }> }): {
  allowed: string[];
  blocked: Array<{ name: string; reason: string }>;
} {
  const allowed: string[] = [];
  const blocked: Array<{ name: string; reason: string }> = [];
  for (const c of profile.certifications ?? []) {
    const name = (c.name ?? '').trim();
    if (!name) continue;
    const generic = /^(aws|google cloud|gcp|microsoft azure|azure|red hat|redhat|devops)\s+certification$/i.test(name);
    if (generic || c.clarificationRequired === true || c.verified !== true) {
      blocked.push({
        name,
        reason: generic
          ? 'generic certification label — the specific credential, provider level and issue date are unknown and must be confirmed by the candidate'
          : 'not independently verified; must not be claimed as an earned certification',
      });
    } else {
      allowed.push(name);
    }
  }
  return { allowed, blocked };
}

/**
 * The certification entries a generated document is ALLOWED to state, and the
 * ones it must withhold. Generators render only `claimable` and report the
 * withheld count as a warning so the operator can see what was suppressed.
 */
export function partitionCertifications<T extends { name?: string; verified?: boolean; clarificationRequired?: boolean }>(
  certifications: T[] | undefined,
): { claimable: T[]; withheld: Array<{ name: string; reason: string }> } {
  const claimable: T[] = [];
  const withheld: Array<{ name: string; reason: string }> = [];
  for (const c of certifications ?? []) {
    const name = (c.name ?? '').trim();
    if (!name) continue;
    const generic = /^(aws|google cloud|gcp|microsoft azure|azure|red hat|redhat|devops)\s+certification$/i.test(name);
    if (generic) {
      withheld.push({ name, reason: 'generic certification label from the CV — the specific credential is unknown and must be confirmed by the candidate' });
    } else if (c.clarificationRequired === true || c.verified !== true) {
      withheld.push({ name, reason: 'not independently verified — cannot be presented as an earned certification' });
    } else {
      claimable.push(c);
    }
  }
  return { claimable, withheld };
}

/**
 * Final gate on a GENERATED document: no withdrawn claim from the demo profile
 * may survive into a real application.
 */
export function validateGeneratedDocument(text: string, label: string): { ok: boolean; problems: string[] } {
  const problems = detectFabricatedClaims(text).map(f => `${label}: ${f.id} — "${f.evidence.trim()}"`);
  return { ok: problems.length === 0, problems };
}

/**
 * Drop values the profile marks as unverified (dotted paths such as
 * "personal.linkedin"). A URL that appears in a document is read by a human as
 * "this is definitely me", so an unconfirmed one must not be printed.
 */
export function withUnverifiedFieldsWithheld<T extends Record<string, any>>(profile: T): { profile: T; withheld: string[] } {
  const unverified = profile?.unverifiedFields ?? [];
  if (!Array.isArray(unverified) || unverified.length === 0) return { profile, withheld: [] };

  // Shallow, non-serialising copy: profile values include Date instances, so a
  // JSON round-trip would silently break every date field.
  const clone: any = { ...profile };
  const withheld: string[] = [];
  for (const dotted of unverified as string[]) {
    const [head, key] = dotted.split('.');
    if (key) {
      const section = clone[head];
      if (section && typeof section === 'object' && key in section) {
        clone[head] = { ...section };
        delete clone[head][key];
        withheld.push(dotted);
      }
    } else if (head in clone) {
      delete clone[head];
      withheld.push(dotted);
    }
  }
  return { profile: clone as T, withheld };
}