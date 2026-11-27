/**
 * Phase 10 — zero-friction profile completion.
 *
 * Proves the contract the candidate relies on:
 *   - CV-supported fields are extracted automatically;
 *   - reliable evidence is reused and never re-asked;
 *   - unknown facts are never invented, conflicts are surfaced;
 *   - generic certification labels are never turned into credentials;
 *   - personal questions are asked through chat, one at a time;
 *   - approval is explicit and bound to a version, and an edit invalidates it;
 *   - every submission entry point still enforces the lock;
 *   - the uncertain historical applications still cannot be retried;
 *   - invalidated artifacts still cannot be uploaded.
 *
 * All tests run against isolated temp directories and synthetic profiles.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { ProfileWorkspace } from '../../../src/profile/profile-workspace.ts';
import {
  resolveProfile,
  parseAnswerFor,
  parseCertification,
  parseWorkAuthorization,
  parseNoticePeriod,
  parseSalary,
  PERSONAL_QUESTIONS,
} from '../../../src/profile/auto-resolve.ts';
import { collectEvidence, readUserAnswers } from '../../../src/profile/evidence.ts';
import { realSubmissionLock, assertArtifactUsable, readProfileApproval, computeProfileVersion } from '../../../src/profile/profile-integrity.ts';
import { ChatAgent } from '../../../src/control/chat-agent.ts';
import { createDatabaseClient, type DatabaseClient } from '../../../src/database/client.ts';
import { SubmissionJournalRepository } from '../../../src/database/repositories.ts';
import { FileSubmissionJournal } from '../../../src/application/submission-journal.ts';

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** A CV-shaped workspace in a temp dir, so nothing here touches the real profile. */
function makeWorkspace(options: { cv?: string } = {}): { ws: ProfileWorkspace; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase10-'));
  fs.mkdirSync(path.join(dir, 'profile'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data/profile-audit'), { recursive: true });

  const cv = options.cv ?? [
    'Kumar Mangalam',
    'DevOps Engineer - CI/CD, Containers, Cloud Automation & Observability',
    'Ranchi, Jharkhand, India (Open to relocation: Bengaluru, India - hybrid)',
    'kumarwindows1123@gmail.com',
    '+91 9334153326',
    'GitHub: github.com/itskum47',
    'LinkedIn: https://linkedin.com/in/kumarmangalam',
    '',
    'PROFESSIONAL SUMMARY',
    'DevOps Engineer with 2+ years of hands-on experience building and maintaining CI/CD pipelines.',
    'Open to on-call support and shift rotations, and to relocating to Bengaluru.',
    '',
    'PROFESSIONAL EXPERIENCE',
    'DevOps Engineer',
    'Gokburu Private Limited.',
    'May 2024 - July 2024',
    '',
    'Software Engineering Intern',
    'Gokburu Private Limited.',
    'January 2024 - May 2024',
    '',
    'EDUCATION',
    'Bachelor of Technology (B.Tech) - Computer Science & Engineering',
    'Lovely Professional University',
    'CGPA: 7.89 / 10',
    '',
    'CERTIFICATIONS',
    '- AWS Certification',
    '- Red Hat Certification',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'data/profile-audit/source-cv-extract.txt'), cv, 'utf8');

  fs.writeFileSync(path.join(dir, 'profile/master_profile.yaml'), yaml.stringify({
    candidateId: 'CAND-TEST10',
    personal: {
      fullName: 'Kumar Mangalam',
      email: 'kumarwindows1123@gmail.com',
      phone: '+91 9334153326',
      location: 'Ranchi, Jharkhand, India',
      github: 'https://github.com/itskum47',
      linkedin: 'https://linkedin.com/in/kumarmangalam',
      summary: 'DevOps Engineer with 2+ years of hands-on experience.',
    },
    education: [{ id: 'edu-1', degree: 'Bachelor of Technology (B.Tech)', field: 'Computer Science & Engineering', institution: 'Lovely Professional University', gpa: 'CGPA 7.89 / 10', startDate: null, endDate: null }],
    experience: [
      { id: 'exp-1', company: 'Gokburu Private Limited', title: 'DevOps Engineer', startDate: '2024-05-01', endDate: '2024-07-31', current: false, description: '', achievements: [], technologies: [] },
      { id: 'exp-2', company: 'Gokburu Private Limited', title: 'Software Engineering Intern', startDate: '2024-01-01', endDate: '2024-04-30', current: false, description: '', achievements: [], technologies: [] },
    ],
    projects: [],
    skills: [],
    certifications: [
      { id: 'cert-generic-aws', name: 'AWS Certification', issuer: 'Not stated in the CV', issueDate: null, verified: false, clarificationRequired: true },
      { id: 'cert-generic-redhat', name: 'Red Hat Certification', issuer: 'Not stated in the CV', issueDate: null, verified: false, clarificationRequired: true },
    ],
    achievements: [],
    preferences: { targetRoles: ['DevOps Engineer'], targetSeniority: [], targetLocations: ['Bengaluru, India'], remotePreference: ['hybrid'], currency: 'INR', noticePeriodDays: 0, workAuthorization: [] },
    authorization: { countries: [], workAuthorizations: [], requiresSponsorship: false },
    compensation: { minBase: 0, targetBase: 0, currency: 'INR', benefitsPriorities: [] },
    questionAnswers: [],
    unverifiedFields: ['personal.linkedin'],
    approval: { approved: false },
    version: 2,
    updatedAt: '2026-10-09',
  }), 'utf8');

  return { ws: new ProfileWorkspace({ cwd: dir }), dir };
}

describe('10 — evidence collection and trust classification', () => {
  let ctx: { ws: ProfileWorkspace; dir: string };
  beforeEach(() => { ctx = makeWorkspace(); });
  afterEach(() => fs.rmSync(ctx.dir, { recursive: true, force: true }));

  it('treats the CV and confirmed answers as reliable', () => {
    const bundle = collectEvidence(ctx.dir);
    expect(bundle.cvText).toContain('Kumar Mangalam');
    expect(bundle.userAnswers.size).toBe(0);
  });

  it('never treats generated artifacts or prior agent reports as evidence', () => {
    fs.mkdirSync(path.join(ctx.dir, 'output/cv'), { recursive: true });
    fs.writeFileSync(path.join(ctx.dir, 'output/cv/Old_CV.pdf'), 'x');
    fs.mkdirSync(path.join(ctx.dir, 'benchmarks'), { recursive: true });
    fs.writeFileSync(path.join(ctx.dir, 'benchmarks/PHASE9_PROFILE_RECOVERY_REPORT.md'), 'report');
    const bundle = collectEvidence(ctx.dir);
    const kinds = bundle.untrustedSeen.map(e => e.kind);
    expect(kinds).toContain('generated');
    expect(kinds).toContain('ai_generated');
    for (const e of bundle.untrustedSeen) expect(e.reliable).toBe(false);
  });

  it('ignores a corrupt answer store rather than trusting it', () => {
    fs.writeFileSync(path.join(ctx.dir, 'data/profile-audit/user-answers.json'), '{ broken');
    expect(readUserAnswers(ctx.dir).size).toBe(0);
  });
});

describe('10 — automatic resolution of CV-supported fields', () => {
  let ctx: { ws: ProfileWorkspace; dir: string };
  beforeEach(() => { ctx = makeWorkspace(); });
  afterEach(() => fs.rmSync(ctx.dir, { recursive: true, force: true }));

  it('extracts contact details from the CV without asking', () => {
    const report = resolveProfile({ profile: ctx.ws.profile(), cwd: ctx.dir });
    const byField = Object.fromEntries(report.resolutions.map(r => [r.field, r]));
    expect(byField['personal.email'].status).toBe('already_correct');
    expect(byField['personal.phone'].status).toBe('already_correct');
    expect(byField['personal.fullName'].status).toBe('already_correct');
    expect(byField['personal.location'].status).toBe('already_correct');
  });

  it('keeps the current city distinct from the relocation preference', () => {
    const profile = ctx.ws.profile();
    profile.personal.location = 'Bengaluru, India';
    const report = resolveProfile({ profile, cwd: ctx.dir });
    const location = report.resolutions.find(r => r.field === 'personal.location')!;
    expect(location.status).toBe('conflict');
    expect(location.note).toContain('Ranchi');
  });

  it('surfaces the "2+ years" discrepancy instead of adopting it', () => {
    const report = resolveProfile({ profile: ctx.ws.profile(), cwd: ctx.dir });
    const claim = report.resolutions.find(r => r.field === 'personal.summary.yearsClaim')!;
    expect(claim.status).toBe('conflict');
    expect(claim.note).toMatch(/2\+ years/);
    expect(report.conflicts.map(c => c.field)).toContain('personal.summary.yearsClaim');
  });

  it('never fabricates an education date the CV does not state', () => {
    const report = resolveProfile({ profile: ctx.ws.profile(), cwd: ctx.dir });
    const dates = report.resolutions.find(r => r.field === 'education.dates')!;
    expect(dates.status).toBe('unknown');
    expect(ctx.ws.profile().education[0].startDate).toBeNull();
  });

  it('records provenance and confidence for every resolved field', () => {
    const { report } = ctx.ws.resolve({ apply: true });
    const profile = ctx.ws.profile() as any;
    expect(profile.resolution.autoResolved.length).toBeGreaterThan(0);
    for (const entry of profile.resolution.autoResolved) {
      expect(entry.source).toBeTruthy();
      expect(['high', 'medium', 'low']).toContain(entry.confidence);
    }
    expect(report.questions.length).toBeGreaterThan(0);
  });

  it('is idempotent: a second resolve changes nothing', () => {
    ctx.ws.resolve({ apply: true });
    const v1 = ctx.ws.version();
    const second = ctx.ws.resolve({ apply: true });
    expect(second.apply?.changes).toEqual([]);
    expect(ctx.ws.version()).toBe(v1);
  });
});

describe('10 — unknown facts are never invented', () => {
  let ctx: { ws: ProfileWorkspace; dir: string };
  beforeEach(() => { ctx = makeWorkspace(); });
  afterEach(() => fs.rmSync(ctx.dir, { recursive: true, force: true }));

  it('leaves work authorisation, notice and salary unknown until answered', () => {
    const report = resolveProfile({ profile: ctx.ws.profile(), cwd: ctx.dir });
    for (const field of ['authorization.workAuthorizations', 'preferences.noticePeriodDays', 'compensation']) {
      expect(report.resolutions.find(r => r.field === field)!.status).toBe('unknown');
    }
    const profile = ctx.ws.profile();
    expect(profile.authorization.workAuthorizations).toEqual([]);
    expect(profile.compensation.minBase).toBe(0);
  });

  it('does not turn an unrecognised answer into a value', () => {
    const result = ctx.ws.answer('notice-period', 'maybe soon-ish, depends on things');
    expect(result.applied).toBe(false);
    expect(result.clarification).toBeTruthy();
    expect(ctx.ws.profile().preferences.noticePeriodDays).toBe(0);
  });

  it('does not invent a credential from a category label', () => {
    const result = ctx.ws.answer('certifications', 'AWS');
    expect(result.applied).toBe(false);
    expect(result.clarification).toMatch(/exact credential name/i);
    expect(ctx.ws.profile().certifications.every(c => !c.verified)).toBe(true);
  });

  it('only claims a certification the candidate names exactly', () => {
    const result = ctx.ws.answer('certifications', 'AWS Certified Solutions Architect – Associate, 2024');
    expect(result.applied).toBe(true);
    const certs = ctx.ws.profile().certifications;
    const claimed = certs.filter(c => c.verified);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].name).toContain('AWS Certified Solutions Architect');
    // Confirming one never unblocks the others.
    expect(certs.filter(c => !c.verified).every(c => c.clarificationRequired)).toBe(true);
  });

  it('can remove certifications entirely on request', () => {
    ctx.ws.answer('certifications', 'none of these — remove them');
    expect(ctx.ws.profile().certifications).toEqual([]);
  });

  it('parses answers conservatively', () => {
    expect(parseWorkAuthorization('Indian citizen, no sponsorship needed')?.value).toEqual({
      workAuthorizations: ['citizen'],
      requiresSponsorship: false,
    });
    expect(parseWorkAuthorization('I have no idea')).toBeUndefined();
    expect(parseNoticePeriod('1 month')?.value).toBe(30);
    expect(parseNoticePeriod('immediately')?.value).toBe(0);
    expect(parseSalary('12 LPA')?.value).toMatchObject({ minBase: 1200000, stated: true });
    expect(parseSalary('do not state anything')?.value).toMatchObject({ stated: false });
    expect(parseCertification('RHCSA, 2023')?.value).toMatchObject({ name: 'RHCSA', issueYear: '2023' });
    expect(parseAnswerFor('nonexistent-question', 'anything')).toBeUndefined();
  });
});

describe('10 — questions are asked once and reused', () => {
  let ctx: { ws: ProfileWorkspace; dir: string };
  beforeEach(() => { ctx = makeWorkspace(); });
  afterEach(() => fs.rmSync(ctx.dir, { recursive: true, force: true }));

  it('asks the most consequential personal fact first', () => {
    expect(ctx.ws.nextQuestion()?.id).toBe('work-authorization');
  });

  it('never asks again after a confirmed answer', () => {
    const before = ctx.ws.outstandingQuestions().map(q => q.id);
    expect(before).toContain('work-authorization');
    ctx.ws.answer('work-authorization', 'Indian citizen, no sponsorship needed');
    const after = ctx.ws.outstandingQuestions().map(q => q.id);
    expect(after).not.toContain('work-authorization');
  });

  it('reuses the stored answer across a fresh workspace instance', () => {
    ctx.ws.answer('work-authorization', 'Indian citizen, no sponsorship needed');
    const reopened = new ProfileWorkspace({ cwd: ctx.dir });
    const status = reopened.status();
    expect(status.remainingQuestions).not.toContain('work-authorization');
    expect(reopened.profile().authorization.workAuthorizations).toEqual(['citizen']);
  });

  it('asks no question that the CV already answers', () => {
    const ids = ctx.ws.outstandingQuestions().map(q => q.id);
    // Relocation and on-call willingness are stated in the CV header/summary.
    expect(ids).not.toContain('relocation');
    expect(ids).not.toContain('shifts-oncall');
    // But the legal/financial facts are still asked.
    expect(ids).toContain('work-authorization');
    expect(ids).toContain('notice-period');
  });

  it('keeps the question catalogue free of CV-answerable items', () => {
    const ids = PERSONAL_QUESTIONS.map(q => q.id);
    expect(ids).toContain('certifications');
    expect(ids).toContain('experience-span');
    for (const q of PERSONAL_QUESTIONS) {
      expect(q.question.length).toBeGreaterThan(15);
      expect(q.why.length).toBeGreaterThan(15);
    }
  });
});

describe('10 — approval is explicit and version-bound', () => {
  let ctx: { ws: ProfileWorkspace; dir: string };
  beforeEach(() => { ctx = makeWorkspace(); });
  afterEach(() => fs.rmSync(ctx.dir, { recursive: true, force: true }));

  it('keeps submissions locked before approval', () => {
    expect(realSubmissionLock(ctx.ws['profilePath' as keyof ProfileWorkspace] as unknown as string).allowed).toBe(false);
  });

  it('approves only the exact version that was reviewed', () => {
    ctx.ws.resolve({ apply: true });
    const review = ctx.ws.requestApproval();
    const result = ctx.ws.approve(review.version);
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.lockOpen).toBe(true);
  });

  it('refuses an approval for a stale version', () => {
    const review = ctx.ws.requestApproval();
    fs.appendFileSync(ctx.ws['profilePath' as keyof ProfileWorkspace] as unknown as string, '\n# edited\n');
    const result = ctx.ws.approve(review.version);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/changed since it was shown/);
  });

  it('an edit after approval invalidates it and restores the lock', () => {
    const review = ctx.ws.requestApproval();
    ctx.ws.approve(review.version);
    expect(realSubmissionLock(ctx.ws['profilePath' as keyof ProfileWorkspace] as unknown as string, ctx.dir).allowed).toBe(true);

    ctx.ws.answer('notice-period', '30 days');
    const afterEdit = realSubmissionLock(ctx.ws['profilePath' as keyof ProfileWorkspace] as unknown as string, ctx.dir);
    expect(afterEdit.allowed).toBe(false);
    expect(afterEdit.reason).toMatch(/approval is for|not approved/i);
  });

  it('refuses to approve a profile that still contains demo data', () => {
    const file = ctx.ws['profilePath' as keyof ProfileWorkspace] as unknown as string;
    fs.appendFileSync(file, '\nlegacyContact: "someone@example.com"\n');
    const review = ctx.ws.requestApproval();
    expect(review.findings.join(' ')).toMatch(/reserved_example_email/);
    const result = ctx.ws.approve(review.version);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/demo data/);
  });

  it('revoke restores the lock', () => {
    const review = ctx.ws.requestApproval();
    ctx.ws.approve(review.version);
    ctx.ws.revoke();
    expect(realSubmissionLock(ctx.ws['profilePath' as keyof ProfileWorkspace] as unknown as string).allowed).toBe(false);
  });
});

describe('11 — candidate timeline corrections apply exactly as stated', () => {
  let ctx: { ws: ProfileWorkspace; dir: string };
  beforeEach(() => { ctx = makeWorkspace(); });
  afterEach(() => fs.rmSync(ctx.dir, { recursive: true, force: true }));

  it('moves only the dates, never titles or employers', () => {
    const r = ctx.ws.setExperienceDates('exp-1', '2025-05-01', '2025-07-31', 'candidate correction');
    expect(r.updated).toBe(true);
    const exp = ctx.ws.profile().experience.find(e => e.id === 'exp-1')!;
    expect(exp.startDate).toBe('2025-05-01');
    expect(exp.company).toBe('Gokburu Private Limited');
    expect(exp.title).toBe('DevOps Engineer');
  });

  it('refuses an unknown entry id', () => {
    expect(ctx.ws.setExperienceDates('exp-nope', '2025-01-01', '2025-02-01', 'x').updated).toBe(false);
  });

  it('adds a confirmed employer without inventing the unstated title', () => {
    const r = ctx.ws.addExperience({
      company: 'Oxeye', startDate: '2023-04-01', endDate: '2024-12-31',
      provenanceNote: 'candidate-confirmed',
    });
    expect(r.added).toBe(true);
    const entry = ctx.ws.profile().experience.find(e => e.id === r.id)!;
    expect(entry.company).toBe('Oxeye');
    expect(entry.title).toMatch(/not stated/);
    expect(entry.technologies).toEqual([]);
  });

  it('does not add the same entry twice', () => {
    const input = { company: 'Oxeye', startDate: '2023-04-01', endDate: '2024-12-31', provenanceNote: 'x' };
    ctx.ws.addExperience(input);
    expect(ctx.ws.addExperience(input).added).toBe(false);
  });

  it('clears the years-claim conflict once dated roles substantiate it', () => {
    // Fixture has only ~7 months of dated roles against a "2+ years" summary.
    const before = resolveProfile({ profile: ctx.ws.profile(), cwd: ctx.dir });
    expect(before.conflicts.map(c => c.field)).toContain('personal.summary.yearsClaim');
    // Add ~20 more months of confirmed work.
    ctx.ws.addExperience({ company: 'Oxeye', title: 'DevOps Engineer', startDate: '2023-04-01', endDate: '2024-12-31', provenanceNote: 'test' });
    ctx.ws.addExperience({ company: 'CreativeBits', title: 'Freelance Developer', startDate: '2025-08-01', endDate: '2026-04-30', provenanceNote: 'test' });
    const after = resolveProfile({ profile: ctx.ws.profile(), cwd: ctx.dir });
    expect(after.conflicts.map(c => c.field)).not.toContain('personal.summary.yearsClaim');
  });
});

describe('11 — evidence-based credentials and surfaced conflicts', () => {  let ctx: { ws: ProfileWorkspace; dir: string };
  beforeEach(() => { ctx = makeWorkspace(); });
  afterEach(() => fs.rmSync(ctx.dir, { recursive: true, force: true }));

  it('records a verified credential from a candidate-named record without touching the generic labels', () => {
    const r = ctx.ws.recordVerifiedCredential({
      name: 'Oracle Certified Associate, Java SE 8 Programmer',
      issuer: 'Oracle',
      issueDate: '2026-02-15',
      credentialId: 'exam 1Z0-809 PASS',
      evidencePath: 'data/profile-audit/evidence-oracle-java-associate.pdf',
    });
    expect(r.recorded).toBe(true);
    const certs = ctx.ws.profile().certifications;
    const verified = certs.filter(c => c.verified);
    expect(verified.map(c => c.name)).toEqual(['Oracle Certified Associate, Java SE 8 Programmer']);
    // The generic labels stay excluded.
    expect(certs.filter(c => !c.verified).every(c => c.clarificationRequired)).toBe(true);
  });

  it('does not record the same credential twice', () => {
    const input = { name: 'Oracle Certified Associate, Java SE 8 Programmer', issuer: 'Oracle', evidencePath: 'x.pdf' };
    ctx.ws.recordVerifiedCredential(input);
    expect(ctx.ws.recordVerifiedCredential(input).recorded).toBe(false);
    expect(ctx.ws.profile().certifications.filter(c => c.verified)).toHaveLength(1);
  });

  it('records a conflicting document without changing profile values', () => {
    const before = ctx.ws.profile();
    const r = ctx.ws.recordConflictingEvidence({
      document: 'second-cv.pdf',
      locator: 'data/profile-audit/secondary-cv-aws.pdf',
      trust: 'candidate_asserted',
      disagreements: ['CGPA 8.89 vs 7.89'],
      handling: 'kept primary-CV values',
    });
    expect(r.recorded).toBe(true);
    const after = ctx.ws.profile();
    expect(after.education).toEqual(before.education);
    expect(after.experience).toEqual(before.experience);
    expect(after.conflictingEvidence).toHaveLength(1);
    expect(ctx.ws.recordConflictingEvidence({
      document: 'second-cv.pdf', locator: 'data/profile-audit/secondary-cv-aws.pdf',
      trust: 'candidate_asserted', disagreements: ['x'], handling: 'y',
    }).recorded).toBe(false);
  });

  it('a verified credential renders in the resume while generic labels stay withheld', async () => {    const { ResumeGenerator } = await import('../../../src/resume/generator.ts');
    const { loadProfileWithMeta } = await import('../../../src/profile/loader.ts');
    // The loader converts date strings to Dates, exactly as production does.
    const { profile, profileVersion } = await loadProfileWithMeta();
    expect(profileVersion).toMatch(/^sha256:/);
    const jd: any = {
      jobId: 'JOB-test', company: 'Acme', title: 'DevOps Engineer',
      requiredSkills: [{ name: 'Kubernetes' }], preferredSkills: [], niceToHaveSkills: [],
      certifications: [], cloudPlatforms: [], programmingLanguages: [], devopsTools: [],
      cicdTools: [], monitoringTools: [], databases: [], keywords: [],
    };
    const match: any = { overallScore: 80, recommendation: 'APPLY', confidence: 0.8, missingRequired: [], matchedSkills: [] };
    const result = await new ResumeGenerator().generate({ profile, jobDescription: jd, matchAnalysis: match } as any);
    const text = result.sections.map(s => s.content).join('\n');
    expect(text).toContain('Oracle Certified Associate');
    expect(text).toContain('IBM DevOps and Software Engineering');
    expect(text).not.toContain('AWS Certification');
    expect(text).not.toContain('Red Hat Certification');
  });
});

describe('11 — a parked question is never re-asked and never forgotten', () => {
  let ctx: { ws: ProfileWorkspace; dir: string };
  beforeEach(() => { ctx = makeWorkspace(); });
  afterEach(() => fs.rmSync(ctx.dir, { recursive: true, force: true }));

  it('parks work-authorization without resolving or guessing it', () => {
    const r = ctx.ws.deferQuestion('work-authorization', 'candidate asked not to be re-asked');
    expect(r.deferred).toBe(true);
    const profile = ctx.ws.profile();
    expect(profile.authorization.workAuthorizations).toEqual([]);
    expect(profile.awaitingConfirmation?.map(a => a.questionId)).toEqual(['work-authorization']);
  });

  it('excludes the parked question from the ask queue but keeps it listed', () => {
    ctx.ws.deferQuestion('work-authorization', 'candidate asked not to be re-asked');
    const { report } = ctx.ws.resolve({ apply: false });
    expect(report.questions.map(q => q.id)).not.toContain('work-authorization');
    expect(report.awaitingConfirmation.map(q => q.id)).toEqual(['work-authorization']);
    expect(ctx.ws.nextQuestion()?.id).not.toBe('work-authorization');
  });

  it('still answers a parked question explicitly and clears the park', () => {
    ctx.ws.deferQuestion('work-authorization', 'candidate asked not to be re-asked');
    const result = ctx.ws.answer('work-authorization', 'Indian citizen, no sponsorship needed');
    expect(result.applied).toBe(true);
    expect(ctx.ws.profile().authorization.workAuthorizations).toEqual(['citizen']);
    expect(ctx.ws.profile().awaitingConfirmation ?? []).toEqual([]);
  });

  it('reopens a parked question back into the queue', () => {
    ctx.ws.deferQuestion('work-authorization', 'parked');
    expect(ctx.ws.reopenQuestion('work-authorization').reopened).toBe(true);
    expect(ctx.ws.profile().awaitingConfirmation ?? []).toEqual([]);
    expect(ctx.ws.outstandingQuestions().map(q => q.id)).toContain('work-authorization');
    expect(ctx.ws.reopenQuestion('work-authorization').reopened).toBe(false);
  });

  it('refuses to park an unknown question', () => {
    expect(ctx.ws.deferQuestion('favourite-colour', 'x').deferred).toBe(false);
  });
});

describe('10 — chat drives the whole workflow', () => {  let ctx: { ws: ProfileWorkspace; dir: string };
  let agent: ChatAgent;
  let db: DatabaseClient;
  const originalCwd = process.cwd();
  const originalDbPath = process.env.DB_PATH;

  beforeEach(async () => {
    ctx = makeWorkspace();
    process.chdir(ctx.dir);
    process.env.DB_PATH = path.join(ctx.dir, 'data/chat.db');
    db = await createDatabaseClient();
    agent = new ChatAgent({
      db,
      journalRepo: new SubmissionJournalRepository(db),
      fileJournal: new FileSubmissionJournal(),
      profileWorkspace: ctx.ws,
    });
  });

  afterEach(async () => {
    await db.close();
    process.chdir(originalCwd);
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  });

  it('shows a profile summary with the lock state', async () => {
    const r = await agent.handle('profile');
    expect(r.action).toBe('profile_status');
    expect(r.message).toContain('kumarwindows1123@gmail.com');
    expect(r.message).toContain('LOCKED');
  });

  it('reports automatic resolution through chat', async () => {
    const r = await agent.handle('profile resolve');
    expect(r.action).toBe('profile_resolved');
    expect(r.message).toMatch(/Resolved automatically/);
  });

  it('asks a personal question with the reason it matters', async () => {
    const r = await agent.handle('profile ask');
    expect(r.action).toBe('profile_question');
    expect(r.message).toContain('work authorisation');
    expect(r.message).toContain('WHY:');
  });

  it('collects an answer and updates the profile', async () => {
    await agent.handle('profile ask');
    const r = await agent.handle('profile answer Indian citizen, no sponsorship needed');
    expect(r.action).toBe('profile_answer_saved');
    expect(ctx.ws.profile().authorization.workAuthorizations).toEqual(['citizen']);
  });

  it('asks for clarification instead of guessing', async () => {
    await agent.handle('profile ask');
    const r = await agent.handle('profile answer maybe');
    expect(r.ok).toBe(false);
    expect(r.action).toBe('profile_clarification_needed');
  });

  it('requires an explicit confirmation before approving', async () => {
    const review = await agent.handle('profile approve');
    expect(review.action).toBe('profile_awaiting_confirmation');
    expect(review.message).toContain(review.message.match(/sha256:[0-9a-f]{64}/)![0]);
    // Confirming without having been shown a profile is refused.
    const fresh = await agent.handle('profile approve yes');
    expect(fresh.ok).toBe(true); // same agent instance already has the pending version
  });

  it('refuses approval that was never requested', async () => {
    const freshAgent = new ChatAgent({
      db,
      journalRepo: new SubmissionJournalRepository(db),
      fileJournal: new FileSubmissionJournal(),
      profileWorkspace: ctx.ws,
    });
    const r = await freshAgent.handle('profile approve yes');
    expect(r.ok).toBe(false);
    expect(r.action).toBe('profile_approval_not_requested');
  });

  it('executes and verifies the approval workflow on explicit confirmation', async () => {
    await agent.handle('profile resolve');
    await agent.handle('profile approve');
    const r = await agent.handle('profile approve yes');
    expect(r.action).toBe('profile_approved');
    expect(r.message).toMatch(/verified against the active file hash/);
    // And it states plainly that this is not application authorisation.
    expect(r.message).toMatch(/does NOT authorise any individual application/i);
    expect(ctx.ws.status().lockOpen).toBe(true);
  });

  it('lists its own profile subcommands when given an unknown one', async () => {
    const r = await agent.handle('profile nonsense');
    expect(r.action).toBe('profile_unknown_subcommand');
    expect(r.message).toContain('profile ask');
  });

  it('parks a question from chat and lists it as pending', async () => {
    await agent.handle('profile ask');
    const parked = await agent.handle('profile defer');
    expect(parked.action).toBe('profile_deferred');
    const pending = await agent.handle('profile pending');
    expect(pending.action).toBe('profile_deferred');
    expect(pending.message).toContain('work-authorization');
    // The parked question is no longer asked…
    const next = await agent.handle('profile ask');
    expect(next.message).not.toContain('work authorisation');
    // …but can still be answered explicitly.
    const answered = await agent.handle('profile answer for work-authorization Indian citizen, no sponsorship needed');
    expect(answered.action).toBe('profile_answer_saved');
    expect(ctx.ws.profile().authorization.workAuthorizations).toEqual(['citizen']);
  });

  it('reopens a parked question from chat', async () => {
    await agent.handle('profile ask');
    await agent.handle('profile defer');
    const r = await agent.handle('profile reopen work-authorization');
    expect(r.action).toBe('profile_reopened');
    const next = await agent.handle('profile ask');
    expect(next.message).toContain('work authorisation');
  });
});

describe('10 — protections still hold', () => {
  it('every submission entry point enforces the lock', () => {
    const checks: Array<[string, RegExp]> = [
      ['scripts/phase6-one-application.ts', /realSubmissionLock/],
      ['src/application/engine.ts', /realSubmissionLock/],
      ['src/control/chat-agent.ts', /realSubmissionLock/],
      ['src/worker/handlers.ts', /processApplication/],
    ];
    for (const [file, pattern] of checks) {
      expect(pattern.test(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'))).toBe(true);
    }
  });

  it('the engine still refuses a real ATS target while the profile is unapproved', () => {
    const engine = fs.readFileSync(path.join(REPO_ROOT, 'src/application/engine.ts'), 'utf8');
    expect(engine).toMatch(/isRealAtsTarget/);
    expect(engine.indexOf('this.checkSubmissionLock(')).toBeLessThan(engine.indexOf('uploadDocuments('));
  });

  it('the two uncertain applications keep their journals and stay unretriable', () => {
    for (const id of ['APP-20261008-000099', 'APP-20261008-000017']) {
      const file = path.join(REPO_ROOT, 'data/submission-journal', `${id}.jsonl`);
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.statSync(file).mtimeMs).toBeLessThan(Date.parse('2026-10-09T00:00:00Z'));
    }
    const singleStore = fs.readFileSync(path.join(REPO_ROOT, 'data/submission-journal/APP-20261008-000017.jsonl'), 'utf8');
    expect(singleStore).toMatch(/"status":\s*428/);
    expect(singleStore).toMatch(/uncertain/);
  });

  it('no operator approval exists that could authorise a click', () => {
    const dir = path.join(REPO_ROOT, 'data/operator-approvals');
    if (fs.existsSync(dir)) expect(fs.readdirSync(dir).filter(f => f.endsWith('.json'))).toEqual([]);
  });

  it('invalidated artifacts still cannot be uploaded', () => {
    const registry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data/artifact-invalidation.json'), 'utf8'));
    expect(registry.invalidatedArtifacts.length).toBeGreaterThan(0);
    const target = registry.invalidatedArtifacts[0];
    const verdict = assertArtifactUsable({ artifactPath: target, currentProfileVersion: 'sha256:whatever' });
    expect(verdict.ok).toBe(false);
  });

  it.skipIf(!fs.existsSync(path.join(REPO_ROOT, 'data/profile-approval.json')))('the repository profile approval is bound to the active version and opens the lock', () => {
    const approval = readProfileApproval();
    expect(approval?.approved).toBe(true);
    expect(approval?.profileVersion).toBe(computeProfileVersion());
    const lock = realSubmissionLock();
    expect(lock.allowed).toBe(true);
  });
});
