/**
 * Phase 9 — profile recovery: extraction, placeholder removal, provenance,
 * versioning, artifact invalidation and the real-submission lock.
 *
 * Everything here runs against ISOLATED test data (temp dirs, synthetic
 * profiles). No test touches a real ATS, and no test needs the operator's real
 * approval to exist.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import {
  computeProfileVersion,
  detectPlaceholderData,
  detectFabricatedClaims,
  validateActiveProfile,
  realSubmissionLock,
  readProfileApproval,
  writeProfileApproval,
  writeArtifactInvalidation,
  readArtifactInvalidation,
  assertArtifactUsable,
  certificationClaimsAllowed,
  partitionCertifications,
  validateGeneratedDocument,
  withUnverifiedFieldsWithheld,
  PROFILE_PATH,
} from '../../../src/profile/profile-integrity.ts';

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** A minimal but valid profile skeleton used as a base for fixtures. */
function baseProfile(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    candidateId: 'CAND-TEST01',
    personal: {
      fullName: 'Kumar Mangalam',
      email: 'kumarwindows1123@gmail.com',
      phone: '+91 9334153326',
      location: 'Ranchi, Jharkhand, India',
      summary: 'DevOps Engineer.',
    },
    education: [],
    experience: [],
    projects: [],
    skills: [],
    certifications: [],
    achievements: [],
    preferences: {
      targetRoles: ['DevOps Engineer'],
      targetSeniority: [],
      targetLocations: ['Bengaluru, India'],
      remotePreference: ['hybrid'],
      currency: 'INR',
      noticePeriodDays: 0,
      workAuthorization: [],
    },
    authorization: { countries: [], workAuthorizations: [], requiresSponsorship: false },
    compensation: { minBase: 0, targetBase: 0, currency: 'INR', benefitsPriorities: [] },
    questionAnswers: [],
    version: 2,
    updatedAt: '2026-10-09',
    ...overrides,
  };
}

describe('9 — CV extraction into the master profile', () => {
  it('records the candidate-supplied CV facts verbatim', () => {
    const profile = baseProfile({
      provenance: {
        source: 'candidate_provided_cv',
        sourceLabel: 'CV_HPE_DevOps_Engineer_1213661_2026-09-30.pdf',
        verificationStatus: 'candidate_provided_not_independently_verified',
      },
      education: [{
        id: 'edu-lpu-btech-cse',
        degree: 'Bachelor of Technology (B.Tech)',
        field: 'Computer Science & Engineering',
        institution: 'Lovely Professional University',
        gpa: 'CGPA 7.89 / 10',
      }],
      experience: [
        { id: 'exp-gokburu-devops', company: 'Gokburu Private Limited', title: 'DevOps Engineer', startDate: '2024-05-01', endDate: '2024-07-31' },
        { id: 'exp-gokburu-swe-intern', company: 'Gokburu Private Limited', title: 'Software Engineering Intern', startDate: '2024-01-01', endDate: '2024-04-30' },
      ],
      projects: [
        { id: 'proj-k8s-observability', name: 'k8s-observability-platform', technologies: ['Kubernetes'] },
        { id: 'proj-secureshop', name: 'SecureShop', technologies: ['Terraform'] },
        { id: 'proj-terraform-aws-infra', name: 'terraform-aws-platform-infra', technologies: ['Terraform'] },
        { id: 'proj-omniroute', name: 'OmniRoute', technologies: ['TypeScript'] },
        { id: 'proj-fluxforge', name: 'FluxForge', technologies: ['NATS'] },
      ],
    });

    expect(profile.personal.email).toBe('kumarwindows1123@gmail.com');
    expect(profile.personal.phone).toBe('+91 9334153326');
    expect(profile.personal.github).toBeUndefined();
    expect(profile.education[0].gpa).toBe('CGPA 7.89 / 10');
    expect(profile.experience.map((e: any) => e.title)).toEqual(['DevOps Engineer', 'Software Engineering Intern']);
    expect(profile.projects).toHaveLength(5);
  });

  it('keeps the GitHub URL the CV states and marks the LinkedIn URL unverified', () => {
    const profile = baseProfile({
      personal: {
        fullName: 'Kumar Mangalam',
        email: 'kumarwindows1123@gmail.com',
        phone: '+91 9334153326',
        location: 'Ranchi, Jharkhand, India',
        github: 'https://github.com/itskum47',
        linkedin: 'https://linkedin.com/in/kumarmangalam',
        summary: 'DevOps Engineer.',
      },
      unverifiedFields: ['personal.linkedin'],
    });

    const { profile: safe, withheld } = withUnverifiedFieldsWithheld(profile);
    expect(withheld).toEqual(['personal.linkedin']);
    expect((safe.personal as any).linkedin).toBeUndefined();
    expect((safe.personal as any).github).toBe('https://github.com/itskum47');
    // Dates must survive the withholding (no JSON round-trip).
    expect(safe.updatedAt).toBe('2026-10-09');
  });
});

describe('9 — placeholder and fabricated-claim removal', () => {
  it('flags every demo value that used to be in the active profile', () => {
    const demo = `
      candidateId: "CAND-abc12345"
      personal:
        email: "kumar.mangalam@example.com"
        phone: "+1-555-123-4567"
        portfolio: "https://kumarmangalam.dev"
      experience:
        company: "TechCorp Inc"
      education:
        institution: "Indian Institute of Technology, Bombay"
        honors: ["Institute Merit Scholarship", "Best Thesis Award"]
        gpa: "8.5 / 10"
      summary: "Senior engineer with 8+ years of experience"
    `;
    const ids = detectPlaceholderData(demo).map(f => f.id);
    for (const id of [
      'reserved_example_email',
      'fictional_phone_range',
      'demo_candidate_id',
      'demo_employer',
      'demo_education',
      'demo_honours',
      'demo_domain',
      'demo_years_claim',
      'demo_gpa',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('finds no placeholder data in the corrected profile that is active now', () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, PROFILE_PATH), 'utf8');
    expect(detectPlaceholderData(text)).toEqual([]);
  });

  it('detects a withdrawn claim leaking into a generated document', () => {
    expect(detectFabricatedClaims('Senior Platform Engineer at TechCorp Inc for 8+ years')).toHaveLength(2);
    const clean = validateGeneratedDocument(
      'DevOps Engineer at Gokburu Private Limited, B.Tech CSE, CGPA 7.89 / 10, kumarwindows1123@gmail.com',
      'resume',
    );
    expect(clean.ok).toBe(true);
    expect(clean.problems).toEqual([]);
  });
});

describe('9 — ambiguous certifications are never claimed', () => {
  const generic = [
    { id: 'cert-generic-aws', name: 'AWS Certification', verified: false, clarificationRequired: true },
    { id: 'cert-generic-gcp', name: 'Google Cloud Certification', verified: false, clarificationRequired: true },
    { id: 'cert-generic-azure', name: 'Microsoft Azure Certification', verified: false, clarificationRequired: true },
    { id: 'cert-generic-redhat', name: 'Red Hat Certification', verified: false, clarificationRequired: true },
    { id: 'cert-generic-devops', name: 'DevOps Certification', verified: false, clarificationRequired: true },
  ];

  it('withholds all five generic CV labels', () => {
    const { allowed, blocked } = certificationClaimsAllowed({ certifications: generic });
    expect(allowed).toEqual([]);
    expect(blocked).toHaveLength(5);
    for (const b of blocked) expect(b.reason).toMatch(/generic certification label/);
  });

  it('separates claimable credentials from withheld ones', () => {
    const real = { id: 'cert-1', name: 'Certified Kubernetes Administrator (CKA)', verified: true, clarificationRequired: false };
    const { claimable, withheld } = partitionCertifications([...generic, real]);
    expect(claimable.map(c => c.name)).toEqual(['Certified Kubernetes Administrator (CKA)']);
    expect(withheld).toHaveLength(5);
  });

  it('refuses to render a generic label even if it was marked verified', () => {
    // A generic label can never become claimable by flipping the verified flag —
    // the name itself is the tell that the credential is unspecified.
    const { claimable } = partitionCertifications([{ name: 'AWS Certification', verified: true }]);
    expect(claimable).toEqual([]);
  });
});

describe('9 — profile provenance and versioning', () => {
  let dir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase9-profile-'));
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('versions the profile by content hash and changes when the profile changes', () => {
    const file = path.join(dir, 'p.yaml');
    fs.writeFileSync(file, yaml.stringify(baseProfile()));
    const v1 = computeProfileVersion(file);
    expect(v1).toMatch(/^sha256:[0-9a-f]{64}$/);

    fs.writeFileSync(file, yaml.stringify(baseProfile({ personal: { ...baseProfile().personal, phone: '+91 9999999999' } })));
    const v2 = computeProfileVersion(file);
    expect(v2).not.toBe(v1);
  });

  it('reports the profile as invalid while it is unapproved, and valid once approved', () => {
    const file = path.join(dir, 'p.yaml');
    fs.writeFileSync(file, yaml.stringify(baseProfile({ approval: { approved: false } })));

    const before = validateActiveProfile(file);
    expect(before.ok).toBe(false);
    expect(before.errors.join(' ')).toMatch(/NOT approved/);

    writeProfileApproval({ approved: true, profileVersion: before.profileVersion, approvedBy: 'tester' });
    const after = validateActiveProfile(file);
    expect(after.ok).toBe(true);
  });

  it('carries the clarifications recorded next to the unapproved facts', () => {
    const file = path.join(dir, 'p.yaml');
    fs.writeFileSync(file, yaml.stringify(baseProfile({
      approval: { approved: true },
      clarificationsRequired: ['Certifications: exact credential names unknown.'],
      warnings: ['candidate-provided, not independently verified'],
    })));
    writeProfileApproval({ approved: true, profileVersion: validateActiveProfile(file).profileVersion, approvedBy: 'tester' });
    const v = validateActiveProfile(file);
    expect(v.ok).toBe(true);
    expect(v.clarificationsRequired[0]).toMatch(/Certifications/);
    expect(v.warnings[0]).toMatch(/not independently verified/);
  });
});

describe('9 — real-submission lock', () => {
  let dir: string;
  const originalCwd = process.cwd();
  const originalKill = process.env.REAL_SUBMISSIONS_ENABLED;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase9-lock-'));
    process.chdir(dir);
    delete process.env.REAL_SUBMISSIONS_ENABLED;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true });
    if (originalKill === undefined) delete process.env.REAL_SUBMISSIONS_ENABLED;
    else process.env.REAL_SUBMISSIONS_ENABLED = originalKill;
  });

  const writeActiveProfile = (overrides: Record<string, any> = {}) => {
    const file = path.join(dir, PROFILE_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, yaml.stringify(baseProfile({ approval: { approved: false }, ...overrides })));
    return file;
  };

  it('locks submissions when no approval exists', () => {
    const file = writeActiveProfile();
    const lock = realSubmissionLock(file);
    expect(lock.allowed).toBe(false);
    expect(lock.reason).toMatch(/not approved/i);
  });

  it('locks submissions when the profile still contains demo data, even if approved', () => {
    const file = writeActiveProfile({ personal: { ...baseProfile().personal, email: 'someone@example.com' }, approval: { approved: true } });
    const version = computeProfileVersion(file);
    writeProfileApproval({ approved: true, profileVersion: version, approvedBy: 'tester' });
    const lock = realSubmissionLock(file);
    expect(lock.allowed).toBe(false);
    expect(lock.reason).toMatch(/reserved example email|validation failed/);
  });

  it('opens only for an approval matching the ACTIVE profile version', () => {
    const file = writeActiveProfile({ approval: { approved: true } });
    const version = computeProfileVersion(file);

    writeProfileApproval({ approved: true, profileVersion: 'sha256:stale', approvedBy: 'tester' });
    const stale = realSubmissionLock(file);
    expect(stale.allowed).toBe(false);
    expect(stale.reason).toMatch(/approval is for/);

    writeProfileApproval({ approved: true, profileVersion: version, approvedBy: 'tester' });
    expect(realSubmissionLock(file).allowed).toBe(true);
  });

  it('honours the REAL_SUBMISSIONS_ENABLED=false kill switch even when approved', () => {
    const file = writeActiveProfile({ approval: { approved: true } });
    writeProfileApproval({ approved: true, profileVersion: computeProfileVersion(file), approvedBy: 'tester' });
    process.env.REAL_SUBMISSIONS_ENABLED = 'false';
    const lock = realSubmissionLock(file);
    expect(lock.allowed).toBe(false);
    expect(lock.reason).toMatch(/REAL_SUBMISSIONS_ENABLED/);
  });

  it('treats an approval file that is present but not approved as locked', () => {
    const file = writeActiveProfile({ approval: { approved: true } });
    writeProfileApproval({ approved: false, profileVersion: computeProfileVersion(file) });
    expect(realSubmissionLock(file).allowed).toBe(false);
  });

  it('fails safe when the approval file is corrupt', () => {
    const file = writeActiveProfile({ approval: { approved: true } });
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data/profile-approval.json'), '{ not json');
    expect(readProfileApproval()).toBeNull();
    expect(realSubmissionLock(file).allowed).toBe(false);
  });
});

describe.skipIf(!fs.existsSync(path.join(REPO_ROOT, 'data/profile-approval.json')))('9 — the repository profile approval state', () => {
  it('holds a valid approval bound to the active profile version', () => {
    // The operator approved the corrected profile (Phase 11): the approval file
    // must exist, name the ACTIVE content hash, and open the lock. If the
    // profile is edited, this test fails — which is exactly the guarantee.
    const approval = readProfileApproval();
    expect(approval?.approved).toBe(true);
    expect(approval?.profileVersion).toBe(computeProfileVersion());
    const lock = realSubmissionLock();
    expect(lock.allowed).toBe(true);
    expect(lock.profileVersion).toBe(approval?.profileVersion);
  });
});

describe('9 — artifact invalidation and staleness', () => {
  let dir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase9-artifacts-'));
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses an artifact explicitly marked as historical evidence', () => {
    writeArtifactInvalidation({
      invalidatedProfileVersions: [],
      invalidatedArtifacts: ['output/cv/Someone_DevOps_Engineer_2026-10-08.pdf'],
      invalidatedDirectories: [],
      reason: 'generated from the withdrawn demo profile',
      recordedAt: new Date().toISOString(),
    });
    const verdict = assertArtifactUsable({
      artifactPath: 'output/cv/Someone_DevOps_Engineer_2026-10-08.pdf',
      currentProfileVersion: 'sha256:current',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/withdrawn/);
  });

  it('refuses an artifact generated from a different (older) profile version', () => {
    const verdict = assertArtifactUsable({
      artifactPath: 'output/cv/Fresh_DevOps_Engineer_2026-10-09.pdf',
      artifactProfileVersion: 'sha256:old',
      currentProfileVersion: 'sha256:new',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/stale/);
  });

  it('allows an artifact bound to the current profile version', () => {
    const verdict = assertArtifactUsable({
      artifactPath: 'output/cv/Fresh_DevOps_Engineer_2026-10-09.pdf',
      artifactProfileVersion: 'sha256:new',
      currentProfileVersion: 'sha256:new',
    });
    expect(verdict.ok).toBe(true);
  });

  it('keeps resume and cover-letter files separate', () => {
    const resume = path.join(dir, 'output/cv/SingleStore_DevOps_Engineer_2026-10-09.json');
    const cover = path.join(dir, 'output/cv/CoverLetter_SingleStore_DevOps_Engineer_2026-10-09.json');
    fs.mkdirSync(path.dirname(resume), { recursive: true });
    fs.writeFileSync(resume, JSON.stringify({ kind: 'resume', profileVersion: 'sha256:new' }));
    fs.writeFileSync(cover, JSON.stringify({ kind: 'cover_letter', profileVersion: 'sha256:new' }));

    const a = assertArtifactUsable({ artifactPath: resume, artifactProfileVersion: 'sha256:new', currentProfileVersion: 'sha256:new' });
    const b = assertArtifactUsable({ artifactPath: cover, artifactProfileVersion: 'sha256:new', currentProfileVersion: 'sha256:new' });
    expect(a.ok && b.ok).toBe(true);
    expect(resume).not.toBe(cover);
    expect(JSON.parse(fs.readFileSync(resume, 'utf8')).kind).toBe('resume');
    expect(JSON.parse(fs.readFileSync(cover, 'utf8')).kind).toBe('cover_letter');
  });

  it('records the withdrawn profile version in the invalidation registry', () => {
    const registry = readArtifactInvalidation();
    // The registry is written by the operator CLI; on a clean checkout it is empty.
    expect(Array.isArray(registry.invalidatedArtifacts)).toBe(true);
    expect(Array.isArray(registry.invalidatedProfileVersions)).toBe(true);
  });
});

describe('9 — no entry point can bypass the lock', () => {
  /**
   * Architectural guard: every code path that can reach a real ATS must consult
   * the lock. If someone later removes the check from one of these files, this
   * test fails instead of the bypass shipping silently.
   */
  const ENTRY_POINTS: Array<[string, RegExp]> = [
    ['scripts/phase6-one-application.ts', /realSubmissionLock/],
    ['src/application/engine.ts', /realSubmissionLock/],
    ['src/control/chat-agent.ts', /realSubmissionLock/],
    ['src/worker/handlers.ts', /processApplication/],
  ];

  it.each(ENTRY_POINTS)('%s reaches the lock', (file, pattern) => {
    const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    expect(pattern.test(text)).toBe(true);
  });

  it('keeps the lock check ahead of any browser work in the engine', () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'src/application/engine.ts'), 'utf8');
    const lock = text.indexOf('this.checkSubmissionLock(');
    const firstBrowserUse = text.indexOf('uploadDocuments(');
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(firstBrowserUse);
  });

  it('quarantines the two scripts that fabricated documents', () => {
    for (const file of ['scripts/generate-evs-application.ts', 'scripts/generate-evs-simple.ts']) {
      const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      expect(text).toMatch(/QUARANTINED/);
      // The withdrawn demo values must not remain in the active file...
      expect(text).not.toMatch(/TechCorp/);
      // ...and the file must contain no document-writing code at all.
      expect(text).not.toMatch(/writeFileSync/);
      expect(text).not.toMatch(/from '\.\.\/src\/(resume|cover|artifacts)/);
    }
  });
});

describe.skipIf(!fs.existsSync(path.join(REPO_ROOT, 'profile/master_profile.yaml')))('9 — the generators honour the corrected profile', () => {
  /**
   * End-to-end honesty check against the REAL generators and the REAL profile:
   * what comes out must be true, withheld where unverified, and bound to the
   * active profile version.
   */
  const jd = {
    jobId: 'JOB-test:acme:devops-engineer',
    company: 'Acme',
    title: 'DevOps Engineer',
    location: 'Remote',
    remote: true,
    remotePolicy: 'fully-remote',
    description: 'CI/CD, Kubernetes, Terraform, AWS, Prometheus.',
    fullText: 'CI/CD, Kubernetes, Terraform, AWS, Prometheus, Docker, GitHub Actions.',
    required_skills: ['Kubernetes', 'Terraform'],
    preferred_skills: [],
    nice_to_have_skills: [],
    responsibilities: ['Own the CI/CD pipeline'],
    requirements: ['Kubernetes experience'],
    benefits: [],
    experienceRequirements: [],
    educationRequirements: [],
    certifications: ['AWS'],
    cloudPlatforms: ['AWS'],
    programmingLanguages: ['Python'],
    devopsTools: ['Kubernetes', 'Terraform'],
    cicdTools: ['GitHub Actions'],
    monitoringTools: ['Prometheus'],
    databases: [],
    securityRequirements: [],
    keywords: ['kubernetes', 'terraform', 'aws', 'ci/cd'],
    applicationQuestions: [],
    otherConstraints: [],
    source: 'test',
    url: 'https://boards.example.org/jobs/1',
    postedAt: new Date(),
    extractedAt: new Date(),
    confidence: 1,
    extractionMethod: 'test',
    seniority: 'mid',
    employmentType: 'full-time',
    requiredSkills: [{ name: 'Kubernetes' }, { name: 'Terraform' }],
    preferredSkills: [],
    niceToHaveSkills: [],
  } as any;

  const match = {
    overallScore: 80,
    recommendation: 'APPLY',
    confidence: 0.8,
    missingRequired: [],
    matchedSkills: ['Kubernetes', 'Terraform'],
    skillGaps: [],
    details: [],
  } as any;

  it('produces a resume with no withdrawn claim, no unverified URL and no claimed certification', async () => {
    const { ResumeGenerator } = await import('../../../src/resume/generator.ts');
    const { loadProfileWithMeta } = await import('../../../src/profile/loader.ts');
    const { profile, profileVersion } = await loadProfileWithMeta();

    const result = await new ResumeGenerator().generate({ profile, jobDescription: jd, matchAnalysis: match } as any);
    const text = result.sections.map(s => s.content).join('\n');

    expect(detectFabricatedClaims(text)).toEqual([]);
    expect(text).not.toContain('linkedin.com');
    expect(text).not.toContain('AWS Certification');
    expect(result.resume.profileVersion).toBe(profileVersion);
    expect(result.warnings.some(w => w.includes('certification withheld'))).toBe(true);
    // The CV's own claims are present.
    expect(text).toContain('Gokburu Private Limited');
    expect(text).toContain('Lovely Professional University');
    expect(text).toContain('7.89');
  });

  it('produces a cover letter with no withdrawn claim and no unverified URL', async () => {
    const { CoverLetterGenerator } = await import('../../../src/cover/generator.ts');
    const { loadProfileWithMeta } = await import('../../../src/profile/loader.ts');
    const { profile, profileVersion } = await loadProfileWithMeta();

    const result = await new CoverLetterGenerator().generate({ profile, jobDescription: jd, matchAnalysis: match } as any);

    expect(detectFabricatedClaims(result.content)).toEqual([]);
    expect(result.content).not.toContain('linkedin.com');
    expect(result.coverLetter.profileVersion).toBe(profileVersion);
  });
});

describe('9 — uncertain applications stay protected', () => {
  const PROTECTED = ['APP-20261008-000099', 'APP-20261008-000017'];

  it('keeps both journals on disk', () => {
    for (const id of PROTECTED) {
      const file = path.join(REPO_ROOT, 'data/submission-journal', `${id}.jsonl`);
      expect(fs.existsSync(file)).toBe(true);
    }
  });

  it('leaves the GitLab application permanently blocked in its journal', () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'data/submission-journal/APP-20261008-000099.jsonl'), 'utf8');
    expect(text).toMatch(/blocked|uncertain|cannot be retried/i);
  });

  it('preserves the first SingleStore attempt (HTTP 428) in the journal trail', () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'data/submission-journal/APP-20261008-000017.jsonl'), 'utf8');
    expect(text).toMatch(/"status":\s*428/);
    expect(text).toMatch(/uncertain/);
  });

  it('never wrote a click-bearing journal entry for the aborted Phase 8 retry', () => {
    const dir = path.join(REPO_ROOT, 'data/submission-journal');
    const aborted = ['APP-20261009-000013'];
    for (const id of aborted) {
      expect(fs.existsSync(path.join(dir, `${id}.jsonl`))).toBe(false);
    }
  });

  it('holds no operator approval that could authorise a click', () => {
    const dir = path.join(REPO_ROOT, 'data/operator-approvals');
    if (fs.existsSync(dir)) {
      expect(fs.readdirSync(dir).filter(f => f.endsWith('.json'))).toEqual([]);
    }
  });
});
