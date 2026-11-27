/**
 * Phase 3 benchmark harness.
 *
 * Runs the SAME real pipeline verified in Phase 2 (DiscoveryManager -> JD extraction ->
 * matching -> resume -> cover letter -> ApplicationEngine -> Playwright -> Fake ATS ->
 * DB -> Excel -> performance collector). The only test double is MockDiscoveryAdapter
 * fixtures pointing at the Fake ATS (as established in Phase 2).
 *
 * IMPORTANT: this module must NOT statically import anything from src/ - each benchmark
 * file sets its own process.env (DB_PATH, cache flags) before the first dynamic import,
 * and src/core/config.ts reads env at module load time.
 */
import path from 'path';
import fs from 'fs';

const testDir = path.dirname(new URL(import.meta.url, import.meta.url).pathname);
export const projectRoot = path.resolve(testDir, '../../../');
export const srcPath = path.join(projectRoot, 'src');
// Phase 3 canonical results live in benchmarks/results — Phase 4 runs redirect
// their outputs so the canonical set is never overwritten (BENCH_RESULTS_DIR).
export const resultsDir = process.env.BENCH_RESULTS_DIR
  ? path.resolve(projectRoot, process.env.BENCH_RESULTS_DIR)
  : path.join(projectRoot, 'benchmarks', 'results');

export interface BenchJobSpec {
  jobId: string;      // internal job-agent id
  atsJobId: string;   // external Fake ATS requisition id
  title: string;
  company: string;
  description: string;
  url: string;        // application URL (http://localhost:<port>/apply?jobId=<atsJobId>)
  extraFields?: Array<{ name: string; label: string; type?: string; placeholder?: string; required?: boolean }>;
}

const TITLES = [
  'DevOps Engineer', 'Platform Engineer', 'Site Reliability Engineer', 'Cloud Engineer',
  'Infrastructure Engineer', 'Release Engineer', 'Build Engineer', 'Systems Engineer',
  'Automation Engineer', 'DevSecOps Engineer',
];

const DESCRIPTION =
  'We are looking for a DevOps Engineer with AWS and Kubernetes experience. ' +
  ' Responsibilities include CI/CD pipelines, Terraform infrastructure as code, Docker, ' +
  ' Prometheus and Grafana monitoring, Python scripting and PostgreSQL. ' +
  ' The ideal candidate has 5 years of experience in cloud infrastructure and automation.';

/** Build N Fake ATS job specs with unique company names (unique artifact file names). */
export function makeBenchJobs(port: number, count: number, tag: string): BenchJobSpec[] {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(3, '0');
    const atsJobId = `ATS-${tag}-${n}`;
    return {
      jobId: `JOB-bench-${tag}-${n}`,
      atsJobId,
      title: TITLES[i % TITLES.length],
      company: `BenchCo${tag}${i + 1}`,
      description: DESCRIPTION,
      url: `http://localhost:${port}/apply?jobId=${atsJobId}`,
    };
  });
}

export function toFakeAtsJobs(specs: BenchJobSpec[]) {
  return specs.map(s => ({
    id: s.atsJobId,
    title: s.title,
    company: s.company,
    description: s.description,
    url: s.url,
    status: 'open' as const,
    extraFields: s.extraFields,
  }));
}

export function toMockDiscoveredJobs(specs: BenchJobSpec[]) {
  return specs.map(s => ({
    jobId: s.jobId as any,
    company: s.company,
    title: s.title,
    location: 'Remote',
    remote: true,
    url: s.url,
    source: 'mock' as const,
    postedAt: new Date(),
    description: s.description,
    salary: '$100,000 - $150,000',
    employmentType: 'full-time' as const,
    seniority: 'mid' as const,
  }));
}

/** Fresh SQLite DB + repositories (replaces the DB file on disk). */
export async function setupDb(dbPath: string) {
  const abs = path.resolve(projectRoot, dbPath);
  if (fs.existsSync(abs)) fs.rmSync(abs, { force: true });
  process.env.DB_PATH = dbPath; // must be set before src/core/config.ts is loaded

  const { createDatabaseClient } = await import(path.join(srcPath, 'database/client.ts'));
  const db = await createDatabaseClient();
  await db.runMigrations(path.join(projectRoot, 'migrations'));
  await db.query('PRAGMA foreign_keys = OFF');

  const repos = await import(path.join(srcPath, 'database/repositories.ts'));
  return {
    db,
    jobRepo: new repos.JobRepository(db),
    jdRepo: new repos.JobDescriptionRepository(db),
    matchRepo: new repos.MatchRepository(db),
    resumeRepo: new repos.ResumeRepository(db),
    coverRepo: new repos.CoverLetterRepository(db),
    appRepo: new repos.ApplicationRepository(db),
  };
}

/** Real DiscoveryManager with ONLY MockDiscoveryAdapter returning the given fixtures. */
export async function discoverJobs(specs: BenchJobSpec[]) {
  const mod = await import(path.join(srcPath, 'discovery/manager.ts'));
  const DiscoveryManager = mod.default;
  const manager = new DiscoveryManager({ onlyMock: true, mockJobs: toMockDiscoveredJobs(specs) });
  const t0 = Date.now();
  const jobs = await manager.discover({
    keywords: [], locations: [], remote: true, seniority: [],
    maxResults: 100, postedWithinDays: 365,
  });
  return { jobs, wallMs: Date.now() - t0 };
}

export async function loadBenchProfile() {
  const { loadProfile } = await import(path.join(srcPath, 'profile/loader.ts'));
  return loadProfile();
}

export interface StageStat {
  stage: string; count: number; successCount: number; failureCount: number;
  min: number; max: number; average: number; median: number; p95: number;
}

export async function clearStageStats(): Promise<void> {
  const { performanceCollector } = await import(path.join(srcPath, 'performance/hooks.ts'));
  performanceCollector.clear();
}

export async function getStageStats(): Promise<StageStat[]> {
  const { performanceCollector } = await import(path.join(srcPath, 'performance/hooks.ts'));
  return performanceCollector.calculateStats() as StageStat[];
}

export function stageMap(stats: StageStat[]): Record<string, StageStat> {
  return Object.fromEntries(stats.map(s => [s.stage, s]));
}

export interface JobOutcome {
  jobId: string;
  atsJobId: string;
  wallMs: number;
  success: boolean;
  state: string;
  error?: string;
  confirmationId?: string;
  recommendation?: string;
  applicationId?: string;
  escalated?: boolean;
  pauseMs?: number;
}

export interface PipelineContext {
  db: any;
  jobRepo: any; jdRepo: any; matchRepo: any; resumeRepo: any; coverRepo: any; appRepo: any;
  profile: any;
  engine: any; // ApplicationEngine
}

/** Assemble the shared pipeline context (repos, profile, generators, engine). */
export async function createPipelineContext(
  db: any, repos: any, profile: any, engine: any
): Promise<PipelineContext> {
  return {
    db,
    jobRepo: repos.jobRepo, jdRepo: repos.jdRepo, matchRepo: repos.matchRepo,
    resumeRepo: repos.resumeRepo, coverRepo: repos.coverRepo, appRepo: repos.appRepo,
    profile, engine,
  };
}

/**
 * ONE complete real pipeline run for one job:
 * upsert job -> fetch HTML -> JD extraction -> matching -> resume generation ->
 * resume artifact PDF -> cover letter generation -> cover artifact PDF ->
 * ApplicationEngine.apply (Playwright -> Fake ATS form -> upload -> submit -> confirmation)
 * -> application row persisted.
 * Mirrors the verified Phase 2 stage sequence exactly.
 */
export async function runPipelineJob(
  ctx: PipelineContext,
  spec: BenchJobSpec,
  opts: { autoSubmit?: boolean } = {}
): Promise<JobOutcome> {
  const autoSubmit = opts.autoSubmit ?? true;
  const t0 = Date.now();

  // --- DB: company + job
  const companyId = `COMP-${spec.company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` as any;
  await ctx.jobRepo.upsertCompany({ companyId, name: spec.company });
  await ctx.jobRepo.upsertJob({
    jobId: spec.jobId as any, company: spec.company, title: spec.title,
    location: 'Remote', remote: true, url: spec.url,
    source: 'mock', description: spec.description, remotePolicy: 'unspecified',
  } as any, companyId);

  // --- Real JD extraction (fetch page HTML from Fake ATS)
  const { JDExtractor } = await import(path.join(srcPath, 'jd/extractor.ts'));
  const jdExtractor = new JDExtractor();
  const html = await (await fetch(spec.url)).text();
  const ex = jdExtractor.extract({ html, url: spec.url } as any);

  await ctx.jdRepo.upsert({
    jobId: spec.jobId, company: ex.jobDescription.company,
    title: ex.jobDescription.title, location: ex.jobDescription.location,
    remote: ex.jobDescription.remote,
    remotePolicy: ex.jobDescription.remotePolicy || 'fully-remote',
    employmentType: 'full-time', seniority: 'mid',
    description: ex.jobDescription.fullText,
    requiredSkills: JSON.stringify(ex.jobDescription.required_skills || []),
    preferredSkills: JSON.stringify(ex.jobDescription.preferred_skills || []),
    niceToHaveSkills: JSON.stringify(ex.jobDescription.nice_to_have_skills || []),
    responsibilities: JSON.stringify(['test responsibility']),
    requirements: JSON.stringify(['test requirement']),
    benefits: JSON.stringify(['test benefit']),
    experienceRequirements: JSON.stringify([]),
    educationRequirements: JSON.stringify([]),
    certifications: JSON.stringify([]),
    cloudPlatforms: JSON.stringify(ex.jobDescription.cloud_platforms || []),
    programmingLanguages: JSON.stringify(ex.jobDescription.programming_languages || []),
    devopsTools: JSON.stringify(ex.jobDescription.devops_tools || []),
    cicdTools: JSON.stringify(ex.jobDescription.cicd_tools || []),
    monitoringTools: JSON.stringify(ex.jobDescription.monitoring_tools || []),
    databases: JSON.stringify(ex.jobDescription.databases || []),
    securityRequirements: JSON.stringify(ex.jobDescription.security_requirements || []),
    keywords: JSON.stringify(ex.jobDescription.keywords || []),
    applicationQuestions: JSON.stringify(ex.jobDescription.application_questions || []),
    otherConstraints: JSON.stringify(ex.jobDescription.other_constraints || []),
    fullText: ex.jobDescription.fullText,
    source: ex.jobDescription.source, url: spec.url,
    postedAt: new Date(), extractedAt: new Date(),
    confidence: ex.confidence, extractionMethod: ex.extractionMethod,
  } as any);

  // --- Real matching
  const { CandidateMatcher } = await import(path.join(srcPath, 'match/engine.ts'));
  const matcher = new CandidateMatcher();
  const match = matcher.match(ex.jobDescription, ctx.profile);
  await ctx.matchRepo.upsert({
    matchId: `MATCH-${spec.atsJobId}-${Date.now()}`, jobId: spec.jobId, candidateId: ctx.profile.candidateId,
    overallScore: match.overallScore, confidence: 0.8,
    recommendation: match.recommendation,
    requiredMatches: [], preferredMatches: [], niceToHaveMatches: [],
    missingRequired: [], missingPreferred: [],
    reasoning: match.reasoning || [], strengths: match.strengths || [],
    gaps: match.gaps || [], analyzedAt: new Date(),
  } as any);

  // --- Real resume generation + artifact
  const { ResumeGenerator } = await import(path.join(srcPath, 'resume/generator.ts'));
  const resumeGenerator = new ResumeGenerator();
  const resumeRes = await resumeGenerator.generate({
    profile: ctx.profile, jobDescription: ex.jobDescription, matchAnalysis: match,
  } as any);
  const { cvArtifactGenerator } = await import(path.join(srcPath, 'artifacts/generator.ts'));
  const resumePath = await cvArtifactGenerator.generateAndSaveResume(
    resumeRes.resume, ctx.profile, ex.jobDescription, match, resumeRes.sections, 'pdf'
  );
  resumeRes.resume.filePath = resumePath;
  await ctx.resumeRepo.upsert({
    resumeId: resumeRes.resume.resumeId, jobId: spec.jobId, candidateId: ctx.profile.candidateId,
    filePath: resumePath, format: 'pdf',
    content: resumeRes.resume.content, keywords: resumeRes.resume.keywords,
    atsScore: resumeRes.atsScore, templateId: resumeRes.resume.templateId,
    generatedAt: resumeRes.resume.generatedAt, version: resumeRes.resume.version,
  } as any);

  // --- Real cover letter generation + artifact
  const { CoverLetterGenerator } = await import(path.join(srcPath, 'cover/generator.ts'));
  const coverGenerator = new CoverLetterGenerator();
  const coverRes = await coverGenerator.generate({
    profile: ctx.profile, jobDescription: ex.jobDescription, matchAnalysis: match,
  } as any);
  const coverPath = await cvArtifactGenerator.generateAndSaveCoverLetter(
    coverRes.coverLetter, ctx.profile, ex.jobDescription, 'pdf'
  );
  coverRes.coverLetter.filePath = coverPath;
  await ctx.coverRepo.upsert({
    coverLetterId: coverRes.coverLetter.coverLetterId, jobId: spec.jobId, candidateId: ctx.profile.candidateId,
    content: coverRes.coverLetter.content, filePath: coverPath,
    templateId: coverRes.coverLetter.template_id, generatedAt: coverRes.coverLetter.generatedAt,
  } as any);

  // --- Real browser application (visible Playwright against Fake ATS)
  const result = await ctx.engine.apply({
    jobId: spec.jobId as any, profile: ctx.profile, autoSubmit, jobUrl: spec.url,
    resume: resumeRes.resume, coverLetter: coverRes.coverLetter,
    jobDescription: ex.jobDescription, matchAnalysis: match,
  } as any);

  if (result.application) {
    // Phase 5A: measure DB persistence of the application row (after
    // application completion, before the job wall ends).
    const perf = await import(path.join(srcPath, 'performance/index.ts'));
    const { STAGES: ST } = await import(path.join(srcPath, 'performance/stages.ts'));
    const persistTimer = perf.startTimer({ stage: ST.DB_PERSIST_APPLICATION });
    await ctx.appRepo.create(result.application);
    persistTimer.end(true);
  }

  // Escalation instrumentation (benchmark H): pause duration from real application events
  const events: any[] = Array.isArray(result.events) ? result.events : [];
  const escalationEvt = events.find(e => e.type === 'human_escalation');
  const resumeEvt = events.find(e => e.type === 'user_answer_received');

  return {
    jobId: spec.jobId,
    atsJobId: spec.atsJobId,
    wallMs: Date.now() - t0,
    success: !!result.success,
    state: result.application?.state,
    error: result.error,
    confirmationId: result.application?.confirmationId,
    recommendation: match.recommendation,
    applicationId: result.application?.applicationId,
    escalated: !!escalationEvt,
    pauseMs:
      escalationEvt && resumeEvt
        ? new Date(resumeEvt.timestamp).getTime() - new Date(escalationEvt.timestamp).getTime()
        : 0,
  };
}

export interface TimingSummary {
  count: number; totalMs: number; avgMs: number; medianMs: number;
  p95Ms: number; minMs: number; maxMs: number; jobsPerHour: number;
}

export function summarize(times: number[], batchMs: number): TimingSummary {
  const sorted = [...times].sort((a, b) => a - b);
  const n = sorted.length;
  const totalMs = sorted.reduce((s, t) => s + t, 0);
  const avgMs = n ? totalMs / n : 0;
  const medianMs = n ? (n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : 0;
  const p95Ms = n ? sorted[Math.min(n - 1, Math.floor(n * 0.95))] : 0;
  return {
    count: n,
    totalMs: Math.round(totalMs),
    avgMs: Math.round(avgMs),
    medianMs: Math.round(medianMs),
    p95Ms: Math.round(p95Ms),
    minMs: n ? sorted[0] : 0,
    maxMs: n ? sorted[n - 1] : 0,
    jobsPerHour: batchMs > 0 ? Math.round((n / batchMs) * 3600000 * 100) / 100 : 0,
  };
}

/** Persist raw benchmark results as JSON for the final report. */
export function writeResult(name: string, data: Record<string, any>): string {
  fs.mkdirSync(resultsDir, { recursive: true });
  const file = path.join(resultsDir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

export function fmt(n: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(n);
}

/** Standard result block printed by every benchmark for the raw-run report. */
export function printRawRun(header: string, data: Record<string, any>): void {
  console.log(`\n===== RAW RUN: ${header} =====`);
  for (const [k, v] of Object.entries(data)) {
    console.log(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  console.log(`===== END RAW RUN: ${header} =====\n`);
}
