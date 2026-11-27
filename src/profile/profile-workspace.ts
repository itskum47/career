/**
 * Phase 10 — the profile workspace.
 *
 * Everything technical about the candidate profile happens here, so the
 * candidate never has to open YAML, calculate a hash, clear a cache or run a
 * script:
 *
 *   resolve()  — read the evidence, auto-resolve what can be resolved, write the
 *                changes back with provenance and confidence, revalidate.
 *   nextQuestion() / answer() — ask only for what evidence cannot settle, and
 *                remember the answer so it is never asked twice.
 *   requestApproval() / approve() — present the final profile for review, then
 *                execute the repository's approval workflow against the exact
 *                content hash the candidate reviewed.
 *   status()   — a concise, chat-friendly summary.
 *
 * The workspace never approves anything on its own: `approve()` requires the
 * caller to pass the exact version that was shown for review, and it re-verifies
 * the written approval against the file afterwards.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import type { MasterProfile } from '../core/types.ts';
import {
  computeProfileVersion,
  detectPlaceholderData,
  readProfileApproval,
  realSubmissionLock,
  writeProfileApproval,
  validateActiveProfile,
  certificationClaimsAllowed,
  partitionCertifications,
} from './profile-integrity.ts';
import { collectEvidence, readUserAnswers, writeUserAnswers, type UserAnswer } from './evidence.ts';
import {
  PERSONAL_QUESTIONS,
  parseAnswerFor,
  resolveProfile,
  formatResolutionReport,
  type PersonalQuestion,
  type ResolutionReport,
} from './auto-resolve.ts';

export interface ProfileWorkspaceOptions {
  cwd?: string;
  profilePath?: string;
}

export interface ProfileStatus {
  candidateId: string;
  name: string;
  email: string;
  phone: string;
  location: string;
  github?: string;
  linkedinWithheld: boolean;
  version: string;
  approved: boolean;
  approvedVersion?: string;
  lockOpen: boolean;
  lockReason: string;
  autoResolvedCount: number;
  confirmedCount: number;
  conflictCount: number;
  unknownCount: number;
  certificationsWithheld: string[];
  remainingQuestions: string[];
  placeholderFindings: string[];
}

export interface ApplyResult {
  changed: boolean;
  changes: string[];
  version: string;
  previousVersion: string;
  validationOk: boolean;
  lockOpen: boolean;
}

export class ProfileWorkspace {
  private readonly cwd: string;
  private readonly profilePath: string;

  constructor(options: ProfileWorkspaceOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.profilePath = options.profilePath ?? path.join(this.cwd, 'profile/master_profile.yaml');
  }

  // -- raw file access ------------------------------------------------------

  private readText(): string {
    return fs.readFileSync(this.profilePath, 'utf8');
  }

  /** Preserve the leading comment block so the file keeps its explanation. */
  private headerOf(text: string): string {
    const lines = text.split('\n');
    const header: string[] = [];
    for (const line of lines) {
      if (line.startsWith('#') || line.trim() === '') header.push(line);
      else break;
    }
    return header.join('\n');
  }

  private readObject(): Record<string, any> {
    return yaml.parse(this.readText()) as Record<string, any>;
  }

  private writeObject(obj: Record<string, any>): string {
    const header = this.headerOf(this.readText());
    const body = yaml.stringify(obj, { lineWidth: 0 });
    const next = header && !header.endsWith('\n\n') ? `${header.replace(/\n+$/, '')}\n\n${body}` : `${header}\n${body}`;
    fs.writeFileSync(this.profilePath, next, 'utf8');
    return computeProfileVersion(this.profilePath);
  }

  version(): string {
    return computeProfileVersion(this.profilePath);
  }

  profile(): MasterProfile {
    return this.readObject() as unknown as MasterProfile;
  }

  // -- resolution -----------------------------------------------------------

  resolve(options: { apply?: boolean } = {}): { report: ResolutionReport; apply?: ApplyResult } {
    const profile = this.profile();
    const evidence = collectEvidence(this.cwd);
    const report = resolveProfile({ profile, evidence, cwd: this.cwd });
    if (options.apply === false) return { report };
    const apply = this.applyReport(report);
    return { report, apply };
  }

  /**
   * Write auto-resolved values and the resolution/provenance block back to the
   * profile. Only fields marked `applied` by the resolver are touched, and only
   * when the change is a genuine improvement (never a downgrade of verified data).
   */
  applyReport(report: ResolutionReport): ApplyResult {
    const previousVersion = report.profileVersion !== 'unknown' ? report.profileVersion : this.version();
    const obj = this.readObject();
    const changes: string[] = [];

    for (const r of report.resolutions) {
      if (!r.applied || r.value === undefined || r.value === null) continue;
      const applied = this.setDotted(obj, r.field, r.value);
      if (applied) changes.push(`${r.field} ← ${r.source ?? 'evidence'}`);
    }

    // Provenance + confidence for every resolved field, so the profile itself
    // explains where each value came from. Only the timestamp is refreshed on an
    // otherwise-identical run, which keeps re-resolution idempotent (and avoids
    // invalidating a version-bound approval for no reason).
    const existing = (obj.resolution ?? {}) as Record<string, any>;
    const previousGeneratedAt = existing.generatedAt;
    obj.resolution = {
      generatedAt: previousGeneratedAt ?? report.generatedAt,
      method: 'Phase 10 zero-friction resolution (CV + candidate confirmations only)',
      autoResolved: report.resolutions
        .filter(r => r.status === 'auto_resolved' || r.status === 'already_correct')
        .map(r => ({ field: r.field, status: r.status, source: r.source, confidence: r.confidence, note: r.note })),
      userConfirmed: report.resolutions
        .filter(r => r.status === 'user_confirmed')
        .map(r => ({ field: r.field, source: r.source, confidence: r.confidence })),
      conflicts: report.conflicts.map(r => ({ field: r.field, note: r.note })),
      ambiguous: report.resolutions.filter(r => r.status === 'ambiguous').map(r => ({ field: r.field, note: r.note })),
      untrustedEvidenceNotUsed: report.untrustedEvidenceSeen,
    };

    // The clarification list is derived from what is still open, so it can never
    // drift away from reality.
    obj.clarificationsRequired = report.questions.map(q => `${q.id}: ${q.question} (${q.why})`);
    if (changes.length > 0) obj.updatedAt = new Date().toISOString().slice(0, 10);
    if (changes.length > 0) obj.resolution.generatedAt = report.generatedAt;

    const version = this.writeObject(obj);
    const validation = validateActiveProfile(this.profilePath);
    const lock = realSubmissionLock(this.profilePath, this.cwd);
    return {
      changed: changes.length > 0 || version !== previousVersion,
      changes,
      version,
      previousVersion,
      validationOk: validation.ok || validation.errors.every(e => /NOT approved/.test(e)),
      lockOpen: lock.allowed,
    };
  }

  private setDotted(obj: Record<string, any>, dotted: string, value: unknown): boolean {
    const parts = dotted.split('.');
    let cursor: any = obj;
    for (const part of parts.slice(0, -1)) {
      if (!cursor[part] || typeof cursor[part] !== 'object') return false;
      cursor = cursor[part];
    }
    const leaf = parts[parts.length - 1];
    if (JSON.stringify(cursor[leaf]) === JSON.stringify(value)) return false;
    cursor[leaf] = value;
    return true;
  }

  // -- questions ------------------------------------------------------------

  /** The single next question, or undefined when everything is settled. */
  nextQuestion(): PersonalQuestion | undefined {
    const { report } = this.resolve({ apply: false });
    return report.questions[0];
  }

  outstandingQuestions(): PersonalQuestion[] {
    const { report } = this.resolve({ apply: false });
    return report.questions;
  }

  /** Questions asked but not yet answered — still open, never re-asked. */
  deferredQuestions(): PersonalQuestion[] {
    const { report } = this.resolve({ apply: false });
    return report.awaitingConfirmation;
  }

  /**
   * Park a question instead of stopping the workflow or nagging about it.
   * The field stays UNRESOLVED (never guessed), stays listed, and can still be
   * answered at any time via `answer()`.
   */
  deferQuestion(questionId: string, note: string): { deferred: boolean; version: string; message: string } {
    const question = PERSONAL_QUESTIONS.find(q => q.id === questionId);
    if (!question) {
      return { deferred: false, version: this.version(), message: `Unknown question "${questionId}".` };
    }
    const obj = this.readObject();
    const list = (obj.awaitingConfirmation ?? []) as Array<Record<string, string>>;
    const existing = list.find(a => a.questionId === questionId);
    if (!existing) {
      list.push({
        questionId,
        field: question.field,
        deferredAt: new Date().toISOString(),
        note,
      });
      obj.awaitingConfirmation = list;
      this.writeObject(obj);
    } else if (existing.note !== note) {
      // The question stays parked, but the note reflects the latest state
      // (e.g. a partial answer was given and the remainder is still open).
      existing.note = note;
      this.writeObject(obj);
    }
    return {
      deferred: true,
      version: this.version(),
      message: `"${question.field}" parked as awaiting your confirmation — unresolved, listed, and never asked again unless you reopen it.`,
    };
  }

  /**
   * Correct the dates of an experience entry from the candidate's explicit
   * statement. Only the dates move — titles, employer and bullets stay as they
   * were until the candidate says otherwise.
   */
  setExperienceDates(
    id: string,
    start: string,
    end: string | null,
    provenanceNote: string,
  ): { updated: boolean; version: string; message: string } {
    const obj = this.readObject();
    const entry = (obj.experience ?? []).find((e: any) => e.id === id);
    if (!entry) return { updated: false, version: this.version(), message: `No experience entry "${id}".` };
    entry.startDate = start;
    entry.endDate = end;
    entry.fieldProvenance = { ...(entry.fieldProvenance ?? {}), dates: provenanceNote };
    const version = this.writeObject(obj);
    return { updated: true, version, message: `${entry.title} @ ${entry.company}: dates now ${start} → ${end ?? 'present'}.` };
  }

  /**
   * Add an experience entry for an employer + date range the candidate
   * explicitly confirmed. Fields the candidate did not state stay empty and
   * flagged — never invented.
   */
  addExperience(input: {
    company: string;
    title?: string;
    startDate: string;
    endDate?: string | null;
    current?: boolean;
    description?: string;
    provenanceNote: string;
  }): { added: boolean; version: string; id: string } {
    const obj = this.readObject();
    obj.experience = obj.experience ?? [];
    const id = `exp-${String(input.company).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}-${input.startDate.slice(0, 7)}`;
    if (obj.experience.some((e: any) => e.id === id)) {
      return { added: false, version: this.version(), id };
    }
    obj.experience.push({
      id,
      company: input.company,
      title: input.title ?? '(role not stated — confirm before any document states it)',
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      current: input.current ?? false,
      description: input.description ?? '',
      achievements: [],
      technologies: [],
      fieldProvenance: {
        company: 'Confirmed by the candidate in chat (Phase 11).',
        title: input.title ? 'Confirmed by the candidate in chat (Phase 11).' : 'NOT STATED — must be confirmed before any document states a title.',
        dates: input.provenanceNote,
      },
    });
    const version = this.writeObject(obj);
    return { added: true, version, id };
  }

  /** Reopen a parked question so it is asked again. */
  reopenQuestion(questionId: string): { reopened: boolean; version: string } {
    const obj = this.readObject();
    const list = (obj.awaitingConfirmation ?? []) as Array<Record<string, string>>;
    const next = list.filter(a => a.questionId !== questionId);
    if (next.length === list.length) return { reopened: false, version: this.version() };
    if (next.length === 0) delete obj.awaitingConfirmation;
    else obj.awaitingConfirmation = next;
    this.writeObject(obj);
    return { reopened: true, version: this.version() };
  }

  /**
   * Record an EARNED credential from a credential record that names the
   * candidate (certificate PDF with credential/exam id, date and result — not a
   * CV claim, not a catalog listing). The entry is marked verified with its
   * evidence locator, so documents may state it.
   */
  recordVerifiedCredential(input: {
    name: string;
    issuer: string;
    issueDate?: string | null;
    credentialId?: string;
    credentialUrl?: string;
    evidencePath?: string;
    evidenceSha256?: string;
    provenance?: 'credential_record_pdf' | 'candidate_confirmed_in_chat';
    note?: string;
  }): { recorded: boolean; version: string; message: string } {
    const obj = this.readObject();
    obj.certifications = obj.certifications ?? [];
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (obj.certifications.some((c: any) => c.name && norm(c.name) === norm(input.name))) {
      return { recorded: false, version: this.version(), message: `"${input.name}" is already recorded.` };
    }
    const id = `cert-${norm(input.name).replace(/ /g, '-').slice(0, 32)}`;
    obj.certifications.push({
      id,
      name: input.name,
      issuer: input.issuer,
      issueDate: input.issueDate ?? null,
      credentialId: input.credentialId,
      credentialUrl: input.credentialUrl,
      verified: true,
      clarificationRequired: false,
      provenance: input.provenance ?? 'credential_record_pdf',
      evidencePath: input.evidencePath,
      evidenceSha256: input.evidenceSha256,
      note: input.note ?? 'Earned credential evidenced by a candidate-named credential record (Phase 11).',
    });
    const version = this.writeObject(obj);
    return { recorded: true, version, message: `Recorded verified credential "${input.name}".` };
  }

  /**
   * Record a local document that disagrees with the profile's primary source.
   * The profile's values do NOT change — the disagreement is surfaced with its
   * handling, so a second CV can neither silently overwrite nor silently vanish.
   */
  recordConflictingEvidence(input: {
    document: string;
    locator: string;
    sha256?: string;
    trust: 'credential_record' | 'candidate_asserted' | 'catalog' | 'unattributable';
    disagreements: string[];
    handling: string;
  }): { recorded: boolean; version: string } {
    const obj = this.readObject();
    obj.conflictingEvidence = obj.conflictingEvidence ?? [];
    if (!obj.conflictingEvidence.some((e: any) => e.locator === input.locator)) {
      obj.conflictingEvidence.push({ ...input, recordedAt: new Date().toISOString() });
      const version = this.writeObject(obj);
      return { recorded: true, version };
    }
    return { recorded: false, version: this.version() };
  }

  /**
   * Apply an answer to a personal question. Unrecognised input never becomes a
   * value: the caller gets a clarification request instead.
   */
  answer(questionId: string, text: string, meta?: Record<string, unknown>): {
    applied: boolean;
    clarification?: string;
    changes: string[];
    version: string;
    nextQuestion?: PersonalQuestion;
    summary: string;
  } {
    const question = PERSONAL_QUESTIONS.find(q => q.id === questionId);
    if (!question) {
      return { applied: false, changes: [], version: this.version(), summary: `I do not know the question "${questionId}".` };
    }
    const parsed = parseAnswerFor(questionId, text);
    if (!parsed) {
      return {
        applied: false,
        changes: [],
        version: this.version(),
        clarification: `I could not turn that into a definite answer for ${question.field}, and I will not guess. ${question.why}`,
        summary: 'No change made.',
      };
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const needsClarification = list.find(p => p.needsClarification)?.needsClarification;
    if (needsClarification) {
      return {
        applied: false,
        changes: [],
        version: this.version(),
        clarification: needsClarification,
        summary: 'No change made.',
      };
    }

    const answers = Array.from(readUserAnswers(this.cwd).values());
    const changes: string[] = [];
    for (const p of list) {
      if (p.value === undefined) continue;
      answers.push({ field: p.field, value: p.value, answeredAt: new Date().toISOString(), note: p.note });
      changes.push(`${p.field} = ${JSON.stringify(p.value)} (${p.note ?? 'confirmed by candidate'})`);
    }
    writeUserAnswers(answers, this.cwd);

    // Materialise the answer in the profile itself.
    const obj = this.readObject();
    for (const p of list) {
      if (p.value === undefined) continue;
      this.materializeAnswer(obj, p, { ...(p.meta ?? {}), ...(meta ?? {}) });
    }
    // An answered question leaves the awaiting-confirmation list — it is settled.
    const pending = (obj.awaitingConfirmation ?? []) as Array<Record<string, string>>;
    const remaining = pending.filter(a => a.questionId !== questionId);
    if (remaining.length === 0) delete obj.awaitingConfirmation;
    else obj.awaitingConfirmation = remaining;
    this.writeObject(obj);

    const version = this.version();
    const next = this.nextQuestion();
    return {
      applied: true,
      changes,
      version,
      nextQuestion: next,
      summary: `Saved. ${changes.join('; ')}`,
    };
  }

  /** Turn a confirmed answer into real profile content (never a placeholder). */
  private materializeAnswer(obj: Record<string, any>, answer: { field: string; value: any }, meta: Record<string, unknown> = {}): void {
    const v = answer.value ?? {};

    if (answer.field === 'authorization') {
      obj.authorization = obj.authorization ?? {};
      if (v.workAuthorizations) obj.authorization.workAuthorizations = v.workAuthorizations;
      if (typeof v.requiresSponsorship === 'boolean') obj.authorization.requiresSponsorship = v.requiresSponsorship;
      obj.authorization.fieldProvenance = {
        ...(obj.authorization.fieldProvenance ?? {}),
        workAuthorizations: 'Confirmed by the candidate in chat (Phase 10).',
        requiresSponsorship: 'Confirmed by the candidate in chat (Phase 10).',
      };
      if (Array.isArray(v.workAuthorizations)) {
        obj.preferences = obj.preferences ?? {};
        obj.preferences.workAuthorization = v.workAuthorizations;
        obj.preferences.fieldProvenance = {
          ...(obj.preferences.fieldProvenance ?? {}),
          workAuthorization: 'Confirmed by the candidate in chat (Phase 10).',
        };
      }
      return;
    }

    if (answer.field === 'certifications') {
      obj.certifications = obj.certifications ?? [];
      if (v.removeAll === true) {
        obj.certifications = [];
        return;
      }
      if (typeof v.name === 'string') {
        const existing = obj.certifications.find((c: any) => c.id === 'cert-generic-aws');
        if (existing) {
          existing.name = v.name;
          existing.verified = true;
          existing.clarificationRequired = false;
          existing.provenance = 'candidate_confirmed_in_chat';
          existing.issueDate = v.issueYear ? `${v.issueYear}-01-01` : null;
          existing.note = 'Exact credential name confirmed by the candidate in chat (Phase 10).';
        } else {
          obj.certifications.push({
            id: `cert-${String(v.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`,
            name: v.name,
            issuer: 'Not stated — confirm the issuing body if the employer needs it',
            issueDate: v.issueYear ? `${v.issueYear}-01-01` : null,
            verified: true,
            clarificationRequired: false,
            provenance: 'candidate_confirmed_in_chat',
            note: 'Confirmed by the candidate in chat (Phase 10).',
          });
        }
        // Confirming one credential never unblocks the others.
        const remaining = obj.certifications.filter((c: any) => !c.verified);
        obj.certifications.forEach((c: any) => {
          if (!c.verified) {
            c.clarificationRequired = true;
            c.note = remaining.length
              ? 'Generic label from the CV — the specific credential is still unknown; do not claim it.'
              : c.note;
          }
        });
      }
      return;
    }

    if (answer.field === 'preferences.noticePeriodDays') {
      obj.preferences = obj.preferences ?? {};
      obj.preferences.noticePeriodDays = v;
      obj.preferences.fieldProvenance = {
        ...(obj.preferences.fieldProvenance ?? {}),
        noticePeriodDays: 'Confirmed by the candidate in chat (Phase 10).',
      };
      return;
    }

    if (answer.field === 'compensation') {
      obj.compensation = obj.compensation ?? {};
      if (typeof v.minBase === 'number') obj.compensation.minBase = v.minBase;
      if (typeof v.targetBase === 'number') obj.compensation.targetBase = v.targetBase;
      obj.compensation.fieldProvenance = {
        ...(obj.compensation.fieldProvenance ?? {}),
        minBase: v.stated ? 'Confirmed by the candidate in chat (Phase 10).' : 'Candidate asked for no figure to be stated.',
        targetBase: v.stated ? 'Confirmed by the candidate in chat (Phase 10).' : 'Candidate asked for no figure to be stated.',
      };
      return;
    }

    if (answer.field === 'preferences.targetLocations') {
      obj.preferences = obj.preferences ?? {};
      obj.preferences.targetLocations = Array.isArray(v) ? v : [v];
      const relocate = meta.relocate;
      if (typeof relocate === 'boolean') {
        obj.preferences.fieldProvenance = {
          ...(obj.preferences.fieldProvenance ?? {}),
          targetLocations: relocate
            ? 'Candidate confirmed willingness to relocate to Bengaluru (chat, Phase 10). Current location remains Ranchi.'
            : 'Candidate confirmed Bengaluru is remote-only, not a relocation (chat, Phase 10). Current location remains Ranchi.',
        };
      }
      return;
    }

    if (answer.field === 'preferences.remotePreference') {
      obj.preferences = obj.preferences ?? {};
      obj.preferences.fieldProvenance = {
        ...(obj.preferences.fieldProvenance ?? {}),
        remotePreference: 'Confirmed by the candidate in chat (Phase 10).',
      };
      return;
    }

    if (answer.field === 'personal.summary') {
      obj.personal = obj.personal ?? {};
      if (v.totalYearsClaim === false) {
        // The truthful alternative: describe the experience without asserting a
        // total-years figure the evidence does not support.
        obj.personal.summary = String(obj.personal.summary ?? '')
          .replace(/DevOps Engineer with \d+\+ years of hands-on experience/, 'DevOps Engineer with hands-on experience since 2024')
          .replace(/\b\d+\+ years\b/g, 'hands-on experience since 2024');
        obj.personal.fieldProvenance = {
          ...(obj.personal.fieldProvenance ?? {}),
          summary: 'CV summary with the unsupported total-years figure removed, confirmed by the candidate in chat (Phase 10).',
        };
      }
      return;
    }

    // Generic fallback for simple scalar fields.
    this.setDotted(obj, answer.field, answer.value);
  }

  // -- approval -------------------------------------------------------------

  /** Present the exact version the candidate would be approving. */
  requestApproval(): {
    version: string;
    summary: string[];
    findings: string[];
    lockReason: string;
    pendingConfirmation: true;
  } {
    const obj = this.readObject();
    const version = computeProfileVersion(this.profilePath);
    const lock = realSubmissionLock(this.profilePath, this.cwd);
    const findings = detectPlaceholderData(this.readText()).map(f => `${f.id}: ${f.why}`);
    const certs = certificationClaimsAllowed(obj as any);
    return {
      version,
      summary: [
        `Name        : ${obj.personal?.fullName}`,
        `Email/phone : ${obj.personal?.email} / ${obj.personal?.phone}`,
        `Location    : ${obj.personal?.location}`,
        `Relocation  : ${(obj.preferences?.targetLocations ?? []).join(', ') || '(not stated)'}`,
        `GitHub      : ${obj.personal?.github ?? '(none)'}`,
        `Experience  : ${(obj.experience ?? []).map((e: any) => `${e.title} @ ${e.company}`).join('; ')}`,
        `Education   : ${(obj.education ?? []).map((e: any) => `${e.degree} ${e.field}, ${e.institution}`).join('; ')}`,
        `Certs claimed: ${certs.allowed.length ? certs.allowed.join(', ') : 'none (all withheld pending confirmation)'}`,
        `Version     : ${version}`,
      ],
      findings,
      lockReason: lock.reason,
      pendingConfirmation: true,
    };
  }

  /**
   * Execute the approval workflow for the exact version reviewed. Refuses if the
   * profile changed since it was shown, then writes the approval and verifies it.
   */
  approve(expectedVersion: string): {
    ok: boolean;
    reason: string;
    version: string;
    verified: boolean;
    lockOpen: boolean;
  } {
    const version = computeProfileVersion(this.profilePath);
    if (expectedVersion !== version) {
      return {
        ok: false,
        reason: `the profile changed since it was shown (reviewed ${expectedVersion}, active ${version}); nothing was approved`,
        version,
        verified: false,
        lockOpen: false,
      };
    }
    const findings = detectPlaceholderData(this.readText());
    if (findings.length > 0) {
      return {
        ok: false,
        reason: `refused: the profile still contains demo data (${findings.map(f => f.id).join(', ')})`,
        version,
        verified: false,
        lockOpen: false,
      };
    }
    writeProfileApproval({
      approved: true,
      profileVersion: version,
      approvedBy: 'candidate (chat approval, Phase 10)',
      approvedAt: new Date().toISOString(),
    }, this.cwd);
    // Verify independently: the lock must now be open AND bound to this version.
    const lock = realSubmissionLock(this.profilePath, this.cwd);
    const approval = readProfileApproval(this.cwd);
    const verified = lock.allowed && approval?.profileVersion === version;
    if (!verified) {
      return {
        ok: false,
        reason: `approval was written but verification failed: ${lock.reason}`,
        version,
        verified: false,
        lockOpen: lock.allowed,
      };
    }
    return { ok: true, reason: 'profile approved and verified against the active content hash', version, verified: true, lockOpen: true };
  }

  /** Re-lock (used by the edit-invalidates-approval guarantee and by revoke). */
  revoke(note = 'revoked by candidate'): { ok: boolean; version: string } {
    const version = computeProfileVersion(this.profilePath);
    writeProfileApproval({ approved: false, profileVersion: version, approvedBy: null, approvedAt: null, note }, this.cwd);
    return { ok: true, version };
  }

  // -- status ---------------------------------------------------------------

  status(): ProfileStatus {
    const obj = this.readObject();
    const version = computeProfileVersion(this.profilePath);
    const lock = realSubmissionLock(this.profilePath, this.cwd);
    const approval = readProfileApproval(this.cwd);
    const { report } = this.resolve({ apply: false });
    const counts = report.resolutions.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    const certs = partitionCertifications(obj.certifications ?? []);
    return {
      candidateId: obj.candidateId,
      name: obj.personal?.fullName ?? '',
      email: obj.personal?.email ?? '',
      phone: obj.personal?.phone ?? '',
      location: obj.personal?.location ?? '',
      github: obj.personal?.github,
      linkedinWithheld: Array.isArray(obj.unverifiedFields) && obj.unverifiedFields.includes('personal.linkedin'),
      version,
      approved: approval?.approved === true && approval.profileVersion === version,
      approvedVersion: approval?.profileVersion,
      lockOpen: lock.allowed,
      lockReason: lock.reason,
      autoResolvedCount: (counts.auto_resolved ?? 0) + (counts.already_correct ?? 0),
      confirmedCount: counts.user_confirmed ?? 0,
      conflictCount: counts.conflict ?? 0,
      unknownCount: counts.unknown ?? 0,
      certificationsWithheld: certs.withheld.map(w => w.name),
      remainingQuestions: report.questions.map(q => q.id),
      placeholderFindings: detectPlaceholderData(this.readText()).map(f => f.id),
    };
  }

  /** Full text report used by `profile resolve` and by the tests. */
  describeResolution(): { report: ResolutionReport; text: string } {
    const { report } = this.resolve({ apply: false });
    return { report, text: formatResolutionReport(report) };
  }
}
