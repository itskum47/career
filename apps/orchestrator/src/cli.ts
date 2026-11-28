#!/usr/bin/env node
/**
 * Job Agent Orchestrator CLI
 * Main entry point for the autonomous job application system.
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../../../src/core/config.ts';
import { logger } from '../../../src/core/logger.ts';
import { loadProfile } from '../../../src/profile/loader.ts';
import { createDatabaseClient, closeDatabaseClient } from '../../../src/database/client.ts';
import { JobRepository, JobDescriptionRepository, MatchRepository, ResumeRepository, CoverLetterRepository, ApplicationRepository, ApplicationEventRepository, BrowserSessionRepository, QuestionAnswerRepository, CandidateProfileRepository } from '../../../src/database/repositories.ts';
import { default as DiscoveryManager, createDefaultDiscoveryManager } from '../../../src/discovery/manager.ts';
import { SEARCH_LOCATIONS } from '../../../src/discovery/catalog.ts';
import { JDExtractor } from '../../../src/jd/extractor.ts';
import { JDVerifier } from '../../../src/jd/verifier.ts';
import { JobDeduplicator } from '../../../src/jd/deduplication.ts';
import type { CompanyId, JobId, CandidateId } from '../../../src/core/types.ts';
import type { JobDescription as JDJobDescription } from '../../../src/jd/types.ts';
import type { ResumeVersion as ResumeResumeVersion } from '../../../src/resume/types.ts';
import { CandidateMatcher } from '../../../src/match/engine.ts';
import { ResumeGenerator } from '../../../src/resume/generator.ts';
import { ATSValidator } from '../../../src/ats/validator.ts';
import { CoverLetterGenerator } from '../../../src/cover/generator.ts';
import { BrowserController } from '../../../src/browser/controller.ts';
import { ApplicationEngine } from '../../../src/application/engine.ts';
import { QuestionClassifier } from '../../../src/application/question-classifier.ts';
import { createWorkerManager, getWorkerManager, getAllHandlers } from '../../../src/worker/index.ts';
import { getEscalationManager, createEscalationManager } from '../../../src/escalation/index.ts';
import { cvArtifactGenerator } from '../../../src/artifacts/index.ts';
import { excelSync } from '../../../src/sync/index.ts';
import { generatePerformanceReport } from './performance-cmd.ts';
import { preflightDuplicateCheck, DuplicateApplicationError } from '../../../src/application/duplicate-guard.ts';
import { DiscoveryOrchestrator, sourceNote } from '../../../src/discovery/orchestrator.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const program = new Command();

program
  .name('job-agent')
  .description('Autonomous multi-agent job application system')
  .version('1.0.0');

program
  .command('discover')
  .description('Discover jobs from configured sources')
  .option('-k, --keywords <keywords...>', 'Keywords to search for')
  .option('-l, --locations <locations...>', 'Locations to search in')
  .option('-r, --remote', 'Remote only')
  .option('-s, --seniority <seniority...>', 'Seniority levels')
  .option('-m, --max <number>', 'Maximum results', '50')
  .action(async (options) => {
    await runDiscovery(options);
  });

program
  .command('discovery:run')
  .description('Phase 6 pipeline: discover -> normalize -> dedupe -> full JD -> route -> prioritize (NEVER submits)')
  .option('-k, --keywords <keywords...>', 'Keywords to search for')
  .option('-l, --locations <locations...>', 'Locations to search in')
  .option('-r, --remote', 'Remote only')
  .option('-m, --max <number>', 'Max jobs per source', '25')
  .option('--only <sources>', 'Comma-separated source allowlist (registry onlySources)')
  .option('--exclude <sources>', 'Comma-separated source denylist')
  .option('--only-mock', 'Only the mock fixture source (tests/benchmarks)')
  .option('--no-fetch-jd', 'Skip full-JD HTTP fetch (pure discovery measurement)')
  .option('--persist', 'Persist normalized jobs + routes to the DB (6R)')
  .option('--json <path>', 'Write run metrics JSON to this path')
  .option('--capabilities', 'Print the source capability report (6B) and exit')
  .action(async (options) => {
    await runDiscoveryPipeline(options);
  });

program
  .command('extract')
  .description('Extract and verify job descriptions')
  .option('-j, --job-id <jobId>', 'Specific job ID to process')
  .option('--all-unverified', 'Process all unverified jobs')
  .action(async (options) => {
    await runJDExtraction(options);
  });

program
  .command('match')
  .description('Match jobs against candidate profile')
  .option('-j, --job-id <jobId>', 'Specific job ID to match')
  .option('--all-verified', 'Match all verified jobs')
  .action(async (options) => {
    await runMatching(options);
  });

program
  .command('generate')
  .description('Generate resume and cover letter for a job')
  .requiredOption('-j, --job-id <jobId>', 'Job ID')
  .option('--resume-only', 'Generate only resume')
  .option('--cover-only', 'Generate only cover letter')
  .action(async (options) => {
    await runGeneration(options);
  });

program
  .command('apply')
  .description('Apply to a job using browser automation')
  .requiredOption('-j, --job-id <jobId>', 'Job ID')
  .option('--auto-submit', 'Auto-submit without confirmation')
  .action(async (options) => {
    await runApplication(options);
  });

program
  .command('run')
  .description('Run full pipeline: discover -> extract -> match -> generate -> apply')
  .option('-k, --keywords <keywords...>', 'Keywords to search for')
  .option('-l, --locations <locations...>', 'Locations')
  .option('-m, --max <number>', 'Max jobs to process', '10')
  .option('--dry-run', 'Run without submitting applications')
  .action(async (options) => {
    await runFullPipeline(options);
  });

program
  .command('status')
  .description('Show application status')
  .option('-a, --application-id <appId>', 'Specific application ID')
  .action(async (options) => {
    await showStatus(options);
  });

program
  .command('resume')
  .description('Resume a paused application')
  .requiredOption('-a, --application-id <appId>', 'Application ID')
  .action(async (options) => {
    await resumeApplication(options);
  });

program
  .command('sync')
  .description('Sync data to Excel tracker')
  .option('--output <path>', 'Output file path')
  .option('--start-date <date>', 'Start date filter (ISO)')
  .option('--end-date <date>', 'End date filter (ISO)')
  .action(async (options) => {
    await syncToExcel(options);
  });

program
  .command('dashboard')
  .description('Start dashboard server')
  .option('-p, --port <port>', 'Port', '3000')
  .action(async (options) => {
    await startDashboard(options.port);
  });

program
  .command('worker:start')
  .description('Start worker queues')
  .option('-c, --concurrency <number>', 'Concurrency per queue', '5')
  .action(async (options) => {
    await startWorkers(options);
  });

program
  .command('worker:stop')
  .description('Stop worker queues')
  .option('--force', 'Force stop without waiting')
  .action(async (options) => {
    await stopWorkers(options);
  });

program
  .command('worker:status')
  .description('Show worker queue status')
  .action(async () => {
    await showWorkerStatus();
  });

program
  .command('performance:report')
  .description('Generate performance report')
  .action(async () => {
    await generatePerformanceReport();
  });

program
  .command('worker:enqueue')
  .description('Enqueue a job')
  .requiredOption('-t, --type <type>', 'Job type (discover, extract, match, generate-resume, generate-cover-letter, validate-ats, apply, sync-excel, sync-db)')
  .option('-p, --payload <json>', 'Job payload as JSON', '{}')
  .option('--priority <priority>', 'Priority (low, normal, high, critical)', 'normal')
  .action(async (options) => {
    await enqueueJob(options);
  });

program
  .command('worker:retry')
  .description('Retry a failed job')
  .requiredOption('-j, --job-id <jobId>', 'Job ID to retry')
  .action(async (options) => {
    await retryJob(options);
  });

program
  .command('escalation:list')
  .description('List pending escalations')
  .option('--status <status>', 'Filter by status (pending, answered, expired, cancelled)')
  .option('--application-id <appId>', 'Filter by application ID')
  .action(async (options) => {
    await listEscalations(options);
  });

program
  .command('escalation:answer')
  .description('Answer an escalation')
  .requiredOption('-e, --escalation-id <id>', 'Escalation ID')
  .requiredOption('-a, --answer <answer>', 'Answer text')
  .action(async (options) => {
    await answerEscalation(options);
  });

program
  .command('escalation:stats')
  .description('Show escalation statistics')
  .action(async () => {
    await showEscalationStats();
  });

program
  .command('escalation:recover')
  .description('Recover paused applications')
  .action(async () => {
    await recoverApplications();
  });

program
  .command('artifact:generate')
  .description('Generate CV and cover letter artifacts')
  .requiredOption('-j, --job-id <jobId>', 'Job ID')
  .option('--format <format>', 'Output format (pdf, html, json)', 'pdf')
  .option('--resume-only', 'Generate only resume')
  .option('--cover-only', 'Generate only cover letter')
  .action(async (options) => {
    await generateArtifacts(options);
  });

program
  .command('artifact:list')
  .description('List generated artifacts')
  .action(async () => {
    await listArtifacts();
  });

async function initializeServices(initBrowser = false) {
  const db = await createDatabaseClient();
  await db.runMigrations(path.join(__dirname, '../../../migrations'));

  const jobRepo = new JobRepository(db);
  const jdRepo = new JobDescriptionRepository(db);
  const matchRepo = new MatchRepository(db);
  const resumeRepo = new ResumeRepository(db);
  const coverRepo = new CoverLetterRepository(db);
  const appRepo = new ApplicationRepository(db);
  const eventRepo = new ApplicationEventRepository(db);
  const browserRepo = new BrowserSessionRepository(db);
  const qaRepo = new QuestionAnswerRepository(db);
  const profileRepo = new CandidateProfileRepository(db);

  const discoveryManager = createDefaultDiscoveryManager();
  const jdExtractor = new JDExtractor();
  const jdVerifier = new JDVerifier();
  const jdDeduplicator = new JobDeduplicator();
  const matcher = new CandidateMatcher();
  const resumeGenerator = new ResumeGenerator();
  const atsValidator = new ATSValidator();
  const coverGenerator = new CoverLetterGenerator();
  const browserController = new BrowserController();
  const questionClassifier = new QuestionClassifier();
  const appEngine = new ApplicationEngine();

  if (initBrowser) {
    await browserController.initialize();
  }

  return {
    db,
    jobRepo,
    jdRepo,
    matchRepo,
    resumeRepo,
    coverRepo,
    appRepo,
    eventRepo,
    browserRepo,
    qaRepo,
    profileRepo,
    discoveryManager,
    jdExtractor,
    jdVerifier,
    jdDeduplicator,
    matcher,
    resumeGenerator,
    atsValidator,
    coverGenerator,
    browserController,
    questionClassifier,
    appEngine,
  };
}

async function runDiscovery(options: any) {
  logger.info('Starting job discovery', options);
  const services = await initializeServices(false);

  const criteria = {
    keywords: options.keywords || ['devops', 'platform engineer', 'kubernetes', 'aws', 'terraform'],
    locations: options.locations || ['Remote', 'Bengaluru', 'San Francisco'],
    remote: options.remote,
    seniority: options.seniority || ['senior', 'lead', 'principal', 'staff'],
    maxResults: parseInt(options.max, 10),
  };

  // Get jobs from discovery manager
  const allJobs = await services.discoveryManager.discover(criteria);
  const jobs: any[] = allJobs.slice(0, criteria.maxResults);
  logger.info(`Discovered ${jobs.length} jobs`);

  // Deduplicate
  const { unique } = services.jdDeduplicator.deduplicate(jobs);
  logger.info(`After deduplication: ${unique.length} unique jobs`);

  // Store companies and jobs
  for (const job of unique) {
    const companyId = `COMP-${job.company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` as CompanyId;
    await services.jobRepo.upsertCompany({ companyId, name: job.company });
    const coreJob = job as any;
    coreJob.remotePolicy = job.remotePolicy || 'unspecified';
    await services.jobRepo.upsertJob(coreJob, companyId);
  }

  await closeDatabaseClient();
  logger.info('Discovery completed');
}

/**
 * Phase 6 — full discovery pipeline (discovery ONLY, never submits).
 * DISCOVERY -> NORMALIZATION -> DEDUPE -> FULL JD -> ROUTE -> PRIORITIZE.
 */
async function runDiscoveryPipeline(options: any) {
  const registryCfg: import('../../../src/discovery/registry.ts').RegistryConfig = {};
  if (options.onlyMock) registryCfg.onlyMock = true;
  if (options.only) registryCfg.onlySources = String(options.only).split(',').map((s: string) => s.trim()).filter(Boolean);
  if (options.exclude) registryCfg.excludeSources = String(options.exclude).split(',').map((s: string) => s.trim()).filter(Boolean);
  if (options.max) registryCfg.maxJobsPerSource = parseInt(options.max, 10);

  const config: import('../../../src/discovery/types.ts').DiscoveryConfig = {
    adapters: {},
    concurrency: 5,
    rateLimitMs: 1000,
    retryAttempts: 3,
    retryDelayMs: 2000,
    onlyMock: registryCfg.onlyMock,
    onlySources: registryCfg.onlySources,
    excludeSources: registryCfg.excludeSources,
    maxJobsPerSource: registryCfg.maxJobsPerSource,
  };

  const orchestrator = new DiscoveryOrchestrator({
    config,
    fetchFullJd: options.fetchJd !== false,
    priorityContext: {
      roleFamilies: undefined,
      candidateSkills: ['devops', 'kubernetes', 'aws', 'terraform', 'docker', 'ci/cd', 'linux', 'python', 'jenkins'],
      candidateExperienceYears: 6,
      preferredLocations: ['Remote India', 'Pune', 'Bengaluru', 'Hyderabad', 'Mumbai'],
      freshnessHalfLifeDays: 14,
    },
  });

  if (options.capabilities) {
    const report = orchestrator.getManager().getRegistry().capabilityReport();
    console.log(`\nSource capability report (${report.length} sources):`);
    for (const r of report) {
      console.log(
        `  ${r.enabled ? '[on ]' : '[off]'} ${r.source.padEnd(18)} ${String(r.support).padEnd(10)} ` +
        `discovery=${String(r.discovery).padEnd(8)} application=${r.application ? 'yes' : 'no '} ` +
        `login=${r.loginRequired ? 'yes' : 'no '} pri=${r.priority}` +
        (r.reason ? `\n        reason: ${r.reason}` : '') +
        (r.evidence ? `\n        evidence: ${r.evidence}` : '')
      );
    }
    return;
  }

  const criteria = {
    // 6C: broad DevOps role-family search (not exact-title-only) — used both
    // as the portal search query and the relevance haystack filter.
    keywords: options.keywords || [
      'devops', 'sre', 'site reliability', 'platform engineer', 'cloud engineer',
      'infrastructure engineer', 'build engineer', 'release engineer', 'kubernetes',
    ],
    // 6D: full metro + remote coverage by default (17 configured locations).
    locations: options.locations || SEARCH_LOCATIONS.map(l => l.label),
    // 6D: -r restricts to remote; by default BOTH on-site metro and remote
    // jobs are discovered (remote eligibility is decided in prioritization,
    // never assumed at search time).
    remote: options.remote === true ? true : undefined,
    maxResults: parseInt(options.max || '25', 10),
  };

  const result = await orchestrator.run(criteria);

  console.log('\n=== Phase 6 discovery pipeline (no applications submitted) ===');
  console.log(`sources queried:        ${result.sourcesQueried.length} (${result.sourcesQueried.join(', ') || 'none'})`);
  console.log(`searches completed:     ${result.searchesCompleted} (failed: ${result.searchesFailed})`);
  console.log(`raw jobs discovered:    ${result.rawJobsDiscovered}`);
  console.log(`normalized jobs:        ${result.normalizedJobs}`);
  console.log(`unique (canonical):     ${result.uniqueJobs}`);
  console.log(`duplicates removed:     ${result.duplicates} (ratio ${(result.duplicateRatio * 100).toFixed(1)}%)`);
  console.log(`ambiguous pairs:        ${result.ambiguousPairs} (kept separate — conservative)`);
  console.log(`complete JD:            ${result.completeJdCount}/${result.uniqueJobs} (${(result.completeJdRate * 100).toFixed(1)}%)`);
  if (Object.keys(result.jdFailureReasons).length) {
    console.log(`JD incomplete reasons:  ${JSON.stringify(result.jdFailureReasons)}`);
  }
  console.log(`routes resolved:        ${result.routesResolved}/${result.uniqueJobs} (${(result.routeAvailability * 100).toFixed(1)}%)`);
  console.log(`route breakdown:        ${JSON.stringify(result.routeCounts)}`);
  console.log(`jobs by source:         ${JSON.stringify(result.jobsBySource)}`);
  console.log(`source latency ms:      ${JSON.stringify(result.sourceLatencyMs)}`);
  console.log(`eligible queue:         ${result.eligibility.eligible} (ineligible retained: ${result.eligibility.ineligible})`);
  if (Object.keys(result.eligibility.ineligibleReasons).length) {
    console.log(`ineligible reasons:     ${JSON.stringify(result.eligibility.ineligibleReasons)}`);
  }
  console.log(`queued (eligible):      ${result.queue.length}`);
  console.log(`wall time:              ${result.wallMs} ms`);

  if (options.persist) {
    const services = await initializeServices(false);
    for (const rec of result.records) {
      const j = rec.job;
      const companyId = `COMP-${j.company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` as CompanyId;
      await services.jobRepo.upsertCompany({ companyId, name: j.company });
      const { jdHash } = await import('../../../src/discovery/identity.ts');
      const effectiveJobId = await services.jobRepo.upsertNormalizedJob({
        internalJobId: j.internalJobId,
        source: j.source,
        sourceJobId: j.sourceJobId,
        sourceUrl: j.sourceUrl,
        canonicalJobUrl: j.canonicalJobUrl,
        applicationUrl: j.applicationUrl,
        company: j.company,
        title: j.title,
        location: j.location,
        remote: j.remote,
        remotePolicy: j.remotePolicy,
        allowedCountries: j.allowedCountries,
        employmentType: j.employmentType,
        seniority: j.seniority,
        salary: j.salary,
        postedAt: j.postedAt,
        description: j.description,
        ats: j.ats,
        jdHash: jdHash(j.description),
        jdComplete: j.jdComplete,
        canonicalKey: rec.canonical.canonicalKey,
        dedupeConfidence: rec.canonical.dedupeConfidence,
        priorityScore: rec.score,
        priorityRank: rec.rank,
      }, companyId, {
        discoveredFrom: rec.route.discoveredFrom,
        canonicalSource: rec.route.canonicalSource,
        applicationRoute: rec.route.route,
      });
      // Preserve every source occurrence (6F).
      for (const occ of rec.canonical.occurrences) {
        await services.jobRepo.addJobOccurrence({
          occurrenceId: `OCC-${occ.internalJobId}-${occ.source}`.slice(0, 60),
          canonicalKey: rec.canonical.canonicalKey,
          jobId: effectiveJobId as any,
          source: occ.source,
          sourceJobId: occ.sourceJobId,
          sourceUrl: occ.sourceUrl,
          dedupeConfidence: rec.canonical.dedupeConfidence,
        });
      }
    }
    // 6N — persist source health snapshots.
    for (const m of result.health) {
      const lat = (m as any).latenciesMs as number[] | undefined;
      await services.jobRepo.upsertSourceHealth({
        source: m.source, state: m.state,
        searchesAttempted: m.searchesAttempted, searchesCompleted: m.searchesCompleted,
        jobsDiscovered: m.jobsDiscovered, jobsNormalized: m.jobsNormalized,
        duplicates: m.duplicates, uniqueJobs: m.uniqueJobs,
        jdRetrievalSuccess: m.jdRetrievalSuccess, jdRetrievalAttempts: m.jdRetrievalAttempts,
        routeResolutionSuccess: m.routeResolutionSuccess, routeResolutionAttempts: m.routeResolutionAttempts,
        applicationSuccess: m.applicationSuccess, applicationAttempts: m.applicationAttempts,
        failures: m.failures, loginInterruptions: m.loginInterruptions,
        captchaInterruptions: m.captchaInterruptions, timeouts: m.timeouts,
        avgLatencyMs: 0, lastError: m.lastError,
      }).catch((e: unknown) => logger.warn('source health persist failed', { source: m.source, error: String(e) }));
      void lat;
    }
    await closeDatabaseClient();
    console.log(`\npersisted ${result.records.length} canonical jobs to DB (6R)`);
  }

  if (options.json) {
    const metrics = {
      generatedAt: new Date().toISOString(),
      sourcesQueried: result.sourcesQueried,
      searchesCompleted: result.searchesCompleted,
      searchesFailed: result.searchesFailed,
      rawJobsDiscovered: result.rawJobsDiscovered,
      normalizedJobs: result.normalizedJobs,
      uniqueJobs: result.uniqueJobs,
      duplicates: result.duplicates,
      duplicateRatio: result.duplicateRatio,
      ambiguousPairs: result.ambiguousPairs,
      completeJdCount: result.completeJdCount,
      completeJdRate: result.completeJdRate,
      jdFailureReasons: result.jdFailureReasons,
      routesResolved: result.routesResolved,
      routeAvailability: result.routeAvailability,
      routeCounts: result.routeCounts,
      jobsBySource: result.jobsBySource,
      sourceLatencyMs: result.sourceLatencyMs,
      sourceFailures: result.sourceFailures,
      eligibility: result.eligibility,
      queued: result.queue.length,
      wallMs: result.wallMs,
      health: result.health,
      topQueue: result.queue.slice(0, 20).map(r => ({
        rank: r.rank, score: r.score, source: r.job.source, sourceJobId: r.job.sourceJobId,
        company: r.job.company, title: r.job.title, location: r.job.location,
        remote: r.job.remote, allowedCountries: r.job.allowedCountries,
        route: r.route.route, ats: r.route.ats,
        applicationUrl: r.job.applicationUrl,
        jdComplete: r.job.jdComplete, url: r.job.canonicalJobUrl,
      })),
    };
    fs.mkdirSync(path.dirname(options.json), { recursive: true });
    fs.writeFileSync(options.json, JSON.stringify(metrics, null, 2), 'utf8');
    console.log(`metrics written: ${options.json}`);
  }
}

async function runJDExtraction(options: any) {
  logger.info('Starting JD extraction', options);
  const services = await initializeServices(false);

  let jobs: any[] = [];
  if (options.jobId) {
    const job = await services.jobRepo.getJob(options.jobId as any);
    if (job) jobs = [job];
  } else if (options.allUnverified) {
    jobs = await services.jobRepo.getUnverifiedJobs(100);
  }

  logger.info(`Processing ${jobs.length} jobs for JD extraction`);

  for (const job of jobs) {
    try {
      const extractionResult = services.jdExtractor.extract({
        html: job.description,
        url: job.url,
      });

      const verificationResult = await services.jdVerifier.verify(extractionResult.jobDescription);

      if (verificationResult.verified) {
        const coreJD = extractionResult.jobDescription as any;
        coreJD.jobId = job.jobId as JobId;
        await services.jdRepo.upsert(coreJD);
        await services.jobRepo.markJobVerified(job.jobId as JobId, verificationResult.confidence, extractionResult.jobDescription.fullText);
        logger.info(`JD extracted and verified for ${job.jobId}`, { confidence: verificationResult.confidence });
      } else {
        logger.warn(`JD verification failed for ${job.jobId}`, { issues: verificationResult.issues });
      }
    } catch (error) {
      logger.error(`JD extraction failed for ${job.jobId}`, { error: String(error) });
    }
  }

  await closeDatabaseClient();
  logger.info('JD extraction completed');
}

async function runMatching(options: any) {
  logger.info('Starting candidate matching', options);
  const services = await initializeServices(false);
  const profile = await loadProfile();

  let jobs: any[] = [];
  if (options.jobId) {
    const job = await services.jobRepo.getJob(options.jobId as any);
    const jd = await services.jdRepo.getByJobId(options.jobId as any);
    if (job && jd) jobs = [{ job, jd }];
  } else if (options.allVerified) {
    // Would need a query for verified jobs with JDs
    logger.warn('Not implemented: all-verified matching');
  }

  for (const { job, jd } of jobs) {
    const match = services.matcher.match(jd, profile);
    await services.matchRepo.upsert(match);
    logger.info(`Matched ${job.jobId}`, { score: match.overallScore, recommendation: match.recommendation });
  }

  await closeDatabaseClient();
  logger.info('Matching completed');
}

async function runGeneration(options: any) {
  logger.info('Starting resume/cover letter generation', options);
  const services = await initializeServices(false);
  const profile = await loadProfile();

  const job = await services.jobRepo.getJob(options.jobId as any);
  const jd = await services.jdRepo.getByJobId(options.jobId as any);
  const match = await services.matchRepo.getByJobId(options.jobId as any, profile.candidateId);

  if (!job || !jd || !match) {
    logger.error('Job, JD, or match not found', { jobId: options.jobId });
    await closeDatabaseClient();
    return;
  }

  if (!options.coverOnly) {
    const resumeResult = await services.resumeGenerator.generate({
      profile,
      jobDescription: jd as any,
      matchAnalysis: match,
      templateId: 'technical',
    });

    const resumeVersion = resumeResult.resume as any;
    resumeVersion.jobId = options.jobId as JobId;
    resumeVersion.candidateId = profile.candidateId;
    await services.resumeRepo.upsert(resumeVersion);
    logger.info('Resume generated', { resumeId: resumeVersion.resumeId, atsScore: resumeVersion.atsScore?.overall });
  }

  if (!options.resumeOnly) {
    const coverResult = await services.coverGenerator.generate({
      profile,
      jobDescription: jd,
      matchAnalysis: match,
      tone: 'professional',
    });

    await services.coverRepo.upsert(coverResult.coverLetter);
    logger.info('Cover letter generated', { coverLetterId: coverResult.coverLetter.coverLetterId });
  }

  await closeDatabaseClient();
  logger.info('Generation completed');
}

async function runApplication(options: any) {
  logger.info('Starting application', options);
  const services = await initializeServices(false);
  const profile = await loadProfile();

  // Phase 6X — duplicate application protection (pre-flight).
  const dupCheck = await preflightDuplicateCheck({
    appRepo: services.appRepo,
    jobId: options.jobId as JobId,
    candidateId: profile.candidateId,
    canonicalKey: options.canonicalKey,
    applicationUrl: options.applicationUrl,
  });
  if (dupCheck.blocked) {
    logger.warn('Application blocked by duplicate protection (6X)', {
      jobId: options.jobId,
      matchedOn: dupCheck.matchedOn,
      reason: dupCheck.reason,
    });
    await closeDatabaseClient();
    return;
  }

  await services.appEngine.initialize();
  const jobRecord = await services.jobRepo.getJob(options.jobId as any);
  const resumes = await services.resumeRepo.getByJobId(options.jobId as any, profile.candidateId);
  const covers = await services.coverRepo.getByJobId(options.jobId as any, profile.candidateId);
  const result = await services.appEngine.apply({
    jobId: options.jobId as any,
    profile,
    autoSubmit: options.autoSubmit,
    jobUrl: options.applicationUrl || jobRecord?.applicationUrl || jobRecord?.url,
    resume: resumes[0],
    coverLetter: covers[0],
    jobDescription: await services.jdRepo.getByJobId(options.jobId as any),
    matchAnalysis: await services.matchRepo.getByJobId(options.jobId as any, profile.candidateId),
  });

  logger.info('Application completed', { success: result.success, applicationId: result.application.applicationId });

  await closeDatabaseClient();
}

async function runFullPipeline(options: any) {
  logger.info('Starting full pipeline', options);
  const services = await initializeServices(false);
  const profile = await loadProfile();
  await services.profileRepo.upsert(profile);

  // Discover
  const criteria = {
    keywords: options.keywords || ['devops', 'platform engineer', 'kubernetes', 'aws'],
    locations: options.locations || ['Remote', 'Bengaluru'],
    remote: true,
    seniority: ['senior', 'lead', 'principal', 'staff'],
    maxResults: parseInt(options.max, 10),
  };

  // Get jobs from discovery manager
  const allJobs = await services.discoveryManager.discover(criteria);
  const jobs: any[] = allJobs.slice(0, criteria.maxResults);
  const { unique } = services.jdDeduplicator.deduplicate(jobs);
  logger.info(`Pipeline: ${unique.length} unique jobs discovered`);

  // Process each job
  for (const job of unique) {
    const companyId = `COMP-${job.company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` as CompanyId;
    await services.jobRepo.upsertCompany({ companyId, name: job.company });
    const coreJob = job as any;
    coreJob.remotePolicy = job.remotePolicy || 'unspecified';
    await services.jobRepo.upsertJob(coreJob, companyId);

    // Extract JD
    const extractionResult = services.jdExtractor.extract({ html: job.description, url: job.url });
    const verificationResult = await services.jdVerifier.verify(extractionResult.jobDescription);

    if (!verificationResult.verified) {
      logger.warn(`Skipping ${job.jobId} - JD verification failed`);
      continue;
    }

    const coreJD = extractionResult.jobDescription as any;
    coreJD.jobId = job.jobId as JobId;
    await services.jdRepo.upsert(coreJD);
    await services.jobRepo.markJobVerified(job.jobId as JobId, verificationResult.confidence, extractionResult.jobDescription.fullText);

    // Match
    const match = services.matcher.match(coreJD, profile);
    await services.matchRepo.upsert(match);

    if (match.recommendation !== 'APPLY') {
      logger.info(`Skipping ${job.jobId} - recommendation: ${match.recommendation}`);
      continue;
    }

    // Generate
    const resumeResult = await services.resumeGenerator.generate({
      profile,
      jobDescription: coreJD,
      matchAnalysis: match,
      templateId: 'technical',
    });
    const resumeVersion = resumeResult.resume as any;
    resumeVersion.jobId = job.jobId as JobId;
    resumeVersion.candidateId = profile.candidateId;
    await services.resumeRepo.upsert(resumeVersion);

    const coverResult = await services.coverGenerator.generate({
      profile,
      jobDescription: coreJD,
      matchAnalysis: match,
      tone: 'professional',
    });
    await services.coverRepo.upsert(coverResult.coverLetter);

    // Apply
    if (!options.dryRun) {
      // App engine (browser + escalation) must be initialized before applying.
      try { await services.appEngine.initialize(); } catch (e) { logger.warn('App engine init failed', { error: String(e) }); }
      // Phase 6X — duplicate application protection (pre-flight).
      const dupCheck = await preflightDuplicateCheck({
        appRepo: services.appRepo,
        jobId: job.jobId as JobId,
        candidateId: profile.candidateId,
      });
      if (dupCheck.blocked) {
        logger.warn(`Skipping ${job.jobId} — duplicate protection (6X)`, { reason: dupCheck.reason });
        continue;
      }
      const appResult = await services.appEngine.apply({
        jobId: job.jobId as JobId,
        profile,
        autoSubmit: config.application.autoSubmit,
        jobUrl: (job as any).applicationUrl || (job as any).url,
      });
      logger.info(`Applied to ${job.jobId}`, { success: appResult.success });
    } else {
      logger.info(`Dry run - would apply to ${job.jobId}`);
    }
  }

  await closeDatabaseClient();
  logger.info('Full pipeline completed');
}

async function showStatus(options: any) {
  const services = await initializeServices(false);

  if (options.applicationId) {
    const app = await services.appRepo.getById(options.applicationId as any);
    if (app) {
      console.log(`Application: ${app.applicationId}`);
      console.log(`  Job: ${app.jobId}`);
      console.log(`  State: ${app.state}`);
      console.log(`  Status: ${app.status}`);
      console.log(`  Created: ${app.createdAt}`);
      console.log(`  Updated: ${app.updatedAt}`);

      const events = await services.eventRepo.getByApplicationId(app.applicationId);
      console.log('\nEvents:');
      for (const e of events) {
        console.log(`  ${e.timestamp.toISOString()} - ${e.type}: ${e.message}`);
      }
    }
  } else {
    const pending = await services.appRepo.getPendingApplications(20);
    console.log(`Pending applications: ${pending.length}`);
    for (const app of pending) {
      console.log(`  ${app.applicationId} - ${app.jobId} - ${app.state}`);
    }
  }

  await closeDatabaseClient();
}

async function resumeApplication(options: any) {
  const services = await initializeServices(false);
  const profile = await loadProfile();

  await services.appEngine.initialize();
  const result = await services.appEngine.resume(options.applicationId as any, profile);
  logger.info('Resume completed', { success: result.success });

  await closeDatabaseClient();
}

async function syncToExcel(options: any = {}) {
  const services = await initializeServices(false);

  logger.info('Syncing to Excel...');

  const result = await excelSync.sync(
    services.appRepo,
    services.jobRepo,
    services.matchRepo,
    services.resumeRepo,
    services.coverRepo,
    options
  );

  logger.info('Excel sync completed', { filePath: result.filePath, synced: result.applicationsSynced });
  console.log(`Excel saved: ${result.filePath}`);
  console.log(`Applications synced: ${result.applicationsSynced}`);
  console.log(`Sheets: ${result.sheets.join(', ')}`);

  await closeDatabaseClient();
}

async function startDashboard(port: string) {
  logger.info(`Starting dashboard on port ${port}...`);
  // TODO: Implement dashboard server
  logger.info('Dashboard not yet implemented');
}

async function startWorkers(options: any) {
  logger.info('Starting worker queues', { concurrency: options.concurrency });

  const manager = createWorkerManager({
    defaultConfig: {
      concurrency: parseInt(options.concurrency, 10),
    },
    globalEventHandler: (event) => {
      logger.debug('Worker event', { type: event.type, jobId: event.jobId, jobType: event.jobType });
    },
    globalErrorHandler: (error, job) => {
      logger.error('Worker error', { error: error.message, jobId: job?.id, jobType: job?.type });
    },
  });

  const handlers = getAllHandlers();
  for (const [type] of handlers) {
    manager.registerQueue(type, handlers);
  }

  await manager.startAll();
  logger.info('Worker queues started. Press Ctrl+C to stop.');

  // Handle shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down workers...');
    await manager.stopAll(true);
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Shutting down workers...');
    await manager.stopAll(true);
    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => {});
}

async function stopWorkers(options: any) {
  const manager = getWorkerManager();
  if (!manager) {
    logger.warn('No worker manager running');
    return;
  }

  await manager.stopAll(!options.force);
  logger.info('Worker queues stopped');
}

async function showWorkerStatus() {
  const manager = getWorkerManager();
  if (!manager) {
    logger.warn('No worker manager running');
    return;
  }

  const stats = await manager.getAllQueueStats();
  const metrics = manager.getAllMetrics();

  console.log('\n=== Worker Queue Status ===\n');
  for (const type of manager.getRegisteredTypes()) {
    const s = stats[type];
    const m = metrics[type];
    console.log(`${type}:`);
    console.log(`  Waiting: ${s.waiting} | Active: ${s.active} | Completed: ${s.completed} | Failed: ${s.failed} | Delayed: ${s.delayed} | Dead Letter: ${s.deadLetter}`);
    console.log(`  Processed: ${m.jobsProcessed} | Succeeded: ${m.jobsSucceeded} | Failed: ${m.jobsFailed} | Retried: ${m.jobsRetried}`);
    console.log(`  Avg Time: ${m.averageProcessingTimeMs.toFixed(0)}ms | Active: ${m.currentActiveJobs}`);
    console.log('');
  }

  console.log(`Healthy: ${manager.isHealthy() ? 'Yes' : 'No'}`);
}

async function enqueueJob(options: any) {
  const manager = getWorkerManager();
  if (!manager) {
    logger.error('Worker manager not running. Start with "job-agent worker:start"');
    return;
  }

  let payload: any;
  try {
    payload = JSON.parse(options.payload);
  } catch (error) {
    logger.error('Invalid JSON payload', { error: String(error) });
    return;
  }

  const jobId = await manager.addJob(options.type as any, payload, {
    priority: options.priority as any,
  });

  logger.info('Job enqueued', { jobId, type: options.type });
  console.log(`Job enqueued: ${jobId}`);
}

async function retryJob(options: any) {
  const manager = getWorkerManager();
  if (!manager) {
    logger.error('Worker manager not running');
    return;
  }

  const result = await manager.retryFailedJob(options.jobId);
  if (result) {
    logger.info('Job requeued for retry', { jobId: options.jobId });
    console.log(`Job ${options.jobId} requeued for retry`);
  } else {
    logger.warn('Job not found or not retryable', { jobId: options.jobId });
    console.log(`Job ${options.jobId} not found or not retryable`);
  }
}

async function listEscalations(options: any) {
  const escalationManager = createEscalationManager();
  await escalationManager.initialize();

  const filter: any = {};
  if (options.status) {
    filter.status = options.status.split(',') as any;
  }
  if (options.applicationId) {
    filter.applicationId = options.applicationId;
  }

  const escalations = await escalationManager.getEscalations(filter);

  console.log(`\n=== Escalations (${escalations.length}) ===\n`);
  for (const e of escalations) {
    console.log(`ID: ${e.id}`);
    console.log(`  Application: ${e.applicationId}`);
    console.log(`  Question: ${e.question}`);
    console.log(`  Category: ${e.category} | Urgency: ${e.urgency} | Status: ${e.status}`);
    console.log(`  Created: ${e.createdAt.toISOString()}`);
    if (e.answeredAt) {
      console.log(`  Answered: ${e.answeredAt.toISOString()} by ${e.answeredBy}`);
      console.log(`  Answer: ${e.answer}`);
    }
    if (e.expiresAt) {
      console.log(`  Expires: ${e.expiresAt.toISOString()}`);
    }
    console.log('');
  }
}

async function answerEscalation(options: any) {
  const escalationManager = createEscalationManager();
  await escalationManager.initialize();

  const result = await escalationManager.answerEscalation(options.escalationId, options.answer, 'user', 1.0, 'user-provided');
  if (result) {
    logger.info('Escalation answered', { id: options.escalationId });
    console.log(`Escalation ${options.escalationId} answered`);
  } else {
    logger.warn('Escalation not found', { id: options.escalationId });
    console.log(`Escalation ${options.escalationId} not found`);
  }
}

async function showEscalationStats() {
  const escalationManager = createEscalationManager();
  await escalationManager.initialize();

  const stats = await escalationManager.getStats();

  console.log('\n=== Escalation Statistics ===\n');
  console.log(`Total: ${stats.total}`);
  console.log(`Pending: ${stats.pending}`);
  console.log(`Answered: ${stats.answered}`);
  console.log(`Expired: ${stats.expired}`);
  console.log(`Avg Response Time: ${stats.averageResponseTimeMs.toFixed(0)}ms`);
  console.log('\nBy Category:');
  for (const [cat, count] of Object.entries(stats.byCategory)) {
    console.log(`  ${cat}: ${count}`);
  }
  console.log('\nBy Urgency:');
  for (const [urg, count] of Object.entries(stats.byUrgency)) {
    console.log(`  ${urg}: ${count}`);
  }
}

async function recoverApplications() {
  const escalationManager = createEscalationManager();
  await escalationManager.initialize();

  const snapshots = await escalationManager.recoverPausedApplications();
  console.log(`\nRecovered ${snapshots.length} paused applications:`);
  for (const s of snapshots) {
    console.log(`  ${s.applicationId} - State: ${s.state} - Version: ${s.version}`);
  }
}

async function generateArtifacts(options: any) {
  const services = await initializeServices(false);
  const profile = await loadProfile();

  const job = await services.jobRepo.getJob(options.jobId as any);
  const jd = await services.jdRepo.getByJobId(options.jobId as any);
  const match = await services.matchRepo.getByJobId(options.jobId as any, profile.candidateId);
  const resumes = await services.resumeRepo.getByJobId(options.jobId as any, profile.candidateId);
  const covers = await services.coverRepo.getByJobId(options.jobId as any, profile.candidateId);

  if (!job || !jd || !match || resumes.length === 0) {
    logger.error('Required data not found for artifact generation', { jobId: options.jobId });
    await closeDatabaseClient();
    return;
  }

  const resume = resumes[0];
  const coverLetter = covers[0];

  // We need sections from the resume generator - regenerate to get them
  const resumeResult = await services.resumeGenerator.generate({
    profile,
    jobDescription: jd as any,
    matchAnalysis: match,
    templateId: 'technical',
  });

  const format = options.format as 'pdf' | 'html' | 'json' || 'pdf';

  if (!options.coverOnly) {
    const resumePath = await cvArtifactGenerator.generateAndSaveResume(
      resume as any,
      profile,
      jd as any,
      match,
      resumeResult.sections,
      format
    );
    logger.info('Resume artifact generated', { path: resumePath });
    console.log(`Resume saved: ${resumePath}`);
  }

  if (!options.resumeOnly && coverLetter && coverLetter.content) {
    const coverPath = await cvArtifactGenerator.generateAndSaveCoverLetter(
      coverLetter as any,
      profile,
      jd as any,
      format
    );
    logger.info('Cover letter artifact generated', { path: coverPath });
    console.log(`Cover letter saved: ${coverPath}`);
  } else if (!options.resumeOnly) {
    logger.warn('Cover letter not found or has no content, skipping cover letter artifact generation');
  }

  await closeDatabaseClient();
}

async function listArtifacts() {
  const fs = await import('fs');
  const path = await import('path');
  const outputDir = config.desktop.cvOutputDir;

  if (!fs.existsSync(outputDir)) {
    console.log('No artifacts directory found');
    return;
  }

  const files = fs.readdirSync(outputDir).filter(f =>
    f.endsWith('.pdf') || f.endsWith('.html') || f.endsWith('.json') || f.endsWith('.docx')
  );

  console.log(`\n=== Artifacts in ${outputDir} (${files.length}) ===\n`);
  for (const file of files.sort().reverse()) {
    const stats = fs.statSync(path.join(outputDir, file));
    console.log(`${file} (${(stats.size / 1024).toFixed(1)} KB, ${stats.mtime.toLocaleDateString()})`);
  }
}

program.parseAsync(process.argv).catch((error) => {
  logger.error('CLI error', { error: String(error) });
  process.exit(1);
});