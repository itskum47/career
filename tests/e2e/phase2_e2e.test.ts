import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {FakeATSServer} from './fake-ats.ts';
import path from 'path';

const testDir = path.dirname(new URL(import.meta.url, import.meta.url).pathname);
const projectRoot = path.resolve(testDir, '../../');
const srcPath = path.join(projectRoot, 'src');

// Pin the DB path: vitest workers may be reused across test files, and Phase 3
// benchmark files set their own DB_PATH before src/core/config.ts loads.
import os from 'os';
import fs from 'fs';
const __tmpDb = path.join(os.tmpdir(), `job-agent-phase2-e2e-${process.pid}.db`);
process.env.DB_PATH = __tmpDb;

let server: FakeATSServer;

beforeAll(async () => {
  server = new FakeATSServer(32500);
  await server.start();
});

afterAll(async () => {
  await server.stop();
  for (const suf of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(__tmpDb + suf); } catch {}
  }
});

describe('Phase 2: End-to-End Fake ATS Pipeline', () => {
  it('should run discovery, find JOB-fake-ats, and execute full pipeline', async () => {
    const discoveryModule = await import(path.join(srcPath, 'discovery/manager.ts'));
    const DiscoveryManager = discoveryModule.default;
    const discoveryManager = new DiscoveryManager({ onlyMock: true });
    console.log('[TEST] DiscoveryManager initialized with onlyMock=true');

    const discoveredJobs = await discoveryManager.discover({
      keywords: [], locations: [], remote: true, seniority: [],
      maxResults: 10, postedWithinDays: 365
    });

    console.log('Discovered jobs count:', discoveredJobs.length);
    discoveredJobs.forEach((j: any) => console.log('  -', j.jobId, j.title, j.url.substring(0, 50)));

    const fakeJob = discoveredJobs.find((j: any) => j.jobId === 'JOB-fake-ats');
    expect(fakeJob).toBeDefined();
    expect(fakeJob?.jobId).toBe('JOB-fake-ats');

    const jobId = fakeJob.jobId as any;
    const jobUrl = fakeJob.url as any;

    // DB setup
    const {createDatabaseClient} = await import(path.join(srcPath, 'database/client.ts'));
    const db = await createDatabaseClient();
    await db.runMigrations(path.join(projectRoot, 'migrations'));
    await db.query('PRAGMA foreign_keys = OFF');

    const {JobRepository, JobDescriptionRepository, MatchRepository, ResumeRepository, CoverLetterRepository} = await import(path.join(srcPath, 'database/repositories.ts'));
    const jobRepo = new JobRepository(db);
    const jdRepo = new JobDescriptionRepository(db);
    const matchRepo = new MatchRepository(db);
    const resumeRepo = new ResumeRepository(db);
    const coverRepo = new CoverLetterRepository(db);

    const profileModule = await import(path.join(srcPath, 'profile/loader.ts'));
    const profile = await profileModule.loadProfile();

    // Upsert job
    await jobRepo.upsertCompany({companyId: 'COMP-testcorp' as any, name: 'TestCorp'});
    await jobRepo.upsertJob({
      jobId, company: 'TestCorp', title: 'DevOps Engineer',
      location: 'Remote', remote: true, url: jobUrl,
      source: fakeJob.source, description: fakeJob.description,
      remotePolicy: 'unspecified'
    } as any, 'COMP-testcorp' as any);

    // TASK 3: Real JD Extraction
    const {JDExtractor} = await import(path.join(srcPath, 'jd/extractor.ts'));
    const jdExtractor = new JDExtractor();
    // Fetch HTML from Fake ATS URL using global fetch (Node.js ESM)
    const fetchRes = await fetch(jobUrl);
    const html = await fetchRes.text();
    const extractionResult = jdExtractor.extract({html, url: jobUrl} as any);
    console.log('JD extracted:', extractionResult.jobDescription.title, extractionResult.jobDescription.company);
    console.log('  Confidence:', extractionResult.confidence);

    await jdRepo.upsert({
      jobId, company: extractionResult.jobDescription.company,
      title: extractionResult.jobDescription.title, location: extractionResult.jobDescription.location,
      remote: extractionResult.jobDescription.remote,
      remotePolicy: extractionResult.jobDescription.remotePolicy || 'fully-remote',
      employmentType: 'full-time', seniority: 'mid',
      description: extractionResult.jobDescription.fullText,
      requiredSkills: JSON.stringify(extractionResult.jobDescription.required_skills || []),
      preferredSkills: JSON.stringify(extractionResult.jobDescription.preferred_skills || []),
      niceToHaveSkills: JSON.stringify(extractionResult.jobDescription.nice_to_have_skills || []),
      responsibilities: JSON.stringify(['test responsibility']),
      requirements: JSON.stringify(['test requirement']),
      benefits: JSON.stringify(['test benefit']),
      experienceRequirements: JSON.stringify([]),
      educationRequirements: JSON.stringify([]),
      certifications: JSON.stringify([]),
      cloudPlatforms: JSON.stringify(extractionResult.jobDescription.cloud_platforms || []),
      programmingLanguages: JSON.stringify(extractionResult.jobDescription.programming_languages || []),
      devopsTools: JSON.stringify(extractionResult.jobDescription.devops_tools || []),
      cicdTools: JSON.stringify(extractionResult.jobDescription.cicd_tools || []),
      monitoringTools: JSON.stringify(extractionResult.jobDescription.monitoring_tools || []),
      databases: JSON.stringify(extractionResult.jobDescription.databases || []),
      securityRequirements: JSON.stringify(extractionResult.jobDescription.security_requirements || []),
      keywords: JSON.stringify(extractionResult.jobDescription.keywords || []),
      applicationQuestions: JSON.stringify(extractionResult.jobDescription.application_questions || []),
      otherConstraints: JSON.stringify(extractionResult.jobDescription.other_constraints || []),
      fullText: extractionResult.jobDescription.fullText,
      source: extractionResult.jobDescription.source, url: jobUrl,
      postedAt: new Date(), extractedAt: new Date(),
      confidence: extractionResult.confidence, extractionMethod: extractionResult.extractionMethod
    } as any);

    // TASK 4 & 5: Real matching
    const {CandidateMatcher} = await import(path.join(srcPath, 'match/engine.ts'));
    const matcher = new CandidateMatcher();
    const matchAnalysis = matcher.match(extractionResult.jobDescription, profile);
    console.log('Matching:', matchAnalysis.overallScore, matchAnalysis.recommendation);

    const matchId = 'MATCH-' + Date.now();
    await matchRepo.upsert({
      matchId, jobId, candidateId: profile.candidateId,
      overallScore: matchAnalysis.overallScore, confidence: 0.8,
      recommendation: matchAnalysis.recommendation,
      requiredMatches: [], preferredMatches: [], niceToHaveMatches: [],
      missingRequired: [], missingPreferred: [],
      reasoning: matchAnalysis.reasoning || [], strengths: matchAnalysis.strengths || [],
      gaps: matchAnalysis.gaps || [], analyzedAt: new Date()
    } as any);

    // TASK 6: Real resume generation
    const {ResumeGenerator} = await import(path.join(srcPath, 'resume/generator.ts'));
    const resumeGenerator = new ResumeGenerator();
    const resumeResult = await resumeGenerator.generate({
      profile, jobDescription: extractionResult.jobDescription, matchAnalysis
    } as any);
    console.log('Resume generated, ATS score:', resumeResult.atsScore.overall);

    // Generate and save actual resume file using CVArtifactGenerator
    const {cvArtifactGenerator} = await import(path.join(srcPath, 'artifacts/generator.ts'));
    const resumePath = await cvArtifactGenerator.generateAndSaveResume(
      resumeResult.resume,
      profile,
      extractionResult.jobDescription,
      matchAnalysis,
      resumeResult.sections,
      'pdf'
    );
    console.log('Resume artifact saved:', resumePath);
    resumeResult.resume.filePath = resumePath;

    await resumeRepo.upsert({
      resumeId: resumeResult.resume.resumeId,
      jobId, candidateId: profile.candidateId,
      filePath: resumePath, format: 'pdf',
      content: resumeResult.resume.content, keywords: resumeResult.resume.keywords,
      atsScore: resumeResult.atsScore,
      templateId: resumeResult.resume.templateId,
      generatedAt: resumeResult.resume.generatedAt, version: resumeResult.resume.version
    } as any);

    // TASK 6: Cover letter generation
    const {CoverLetterGenerator} = await import(path.join(srcPath, 'cover/generator.ts'));
    const coverGenerator = new CoverLetterGenerator();
    const coverResult = await coverGenerator.generate({
      profile, jobDescription: extractionResult.jobDescription, matchAnalysis
    } as any);
    console.log('Cover letter generated');

    // Generate and save actual cover letter file using CVArtifactGenerator
    const coverPath = await cvArtifactGenerator.generateAndSaveCoverLetter(
      coverResult.coverLetter,
      profile,
      extractionResult.jobDescription,
      'pdf'
    );
    console.log('Cover letter artifact saved:', coverPath);
    coverResult.coverLetter.filePath = coverPath;

    await coverRepo.upsert({
      coverLetterId: coverResult.coverLetter.coverLetterId,
      jobId, candidateId: profile.candidateId,
      content: coverResult.coverLetter.content,
      filePath: coverPath,
      templateId: coverResult.coverLetter.template_id,
      generatedAt: coverResult.coverLetter.generatedAt
    } as any);

    // TASK 7: Real Application Engine
    const {ApplicationEngine} = await import(path.join(srcPath, 'application/engine.ts'));
    const appEngine = new ApplicationEngine();
    await appEngine.initialize();
    console.log('ApplicationEngine initialized');

    // Job URL from the discovered job (uses external ATS ID ATS-JOB-001 from MockDiscoveryAdapter)
    // jobUrl is already declared above as fakeJob.url

    // FIRST TEST: AUTO_SUBMIT=false
    console.log('Running with AUTO_SUBMIT=false');
    const result = await appEngine.apply({
      jobId, profile, autoSubmit: false, jobUrl,
      resume: resumeResult.resume,
      coverLetter: coverResult.coverLetter,
      jobDescription: extractionResult.jobDescription,
      matchAnalysis: matchAnalysis
    } as any);
    console.log('Result auto=false: success=%s, state=%s, error=%s', result.success, result.application.state, result.error);

    // SECOND TEST: AUTO_SUBMIT=true
    console.log('Running with AUTO_SUBMIT=true');
    const result2 = await appEngine.apply({
      jobId, profile, autoSubmit: true, jobUrl,
      resume: resumeResult.resume,
      coverLetter: coverResult.coverLetter,
      jobDescription: extractionResult.jobDescription,
      matchAnalysis: matchAnalysis
    } as any);
    console.log('Result auto=true: success=%s, state=%s, confirmationId=%s', result2.success, result2.application.state, result2.application.confirmationId);
    if (result2.error) console.log('Error:', result2.error);

    await appEngine.close();
    console.log('ApplicationEngine closed');

    // Save application records to DB
    const {ApplicationRepository} = await import(path.join(srcPath, 'database/repositories.ts'));
    const appRepo = new ApplicationRepository(db);
    
    // Save both applications (autoSubmit=false is READY_TO_SUBMIT, autoSubmit=true is CONFIRMED)
    if (result.application) {
      await appRepo.create(result.application);
      console.log('Application 1 saved to DB:', result.application.applicationId, 'state:', result.application.state);
    }
    if (result2.application) {
      await appRepo.create(result2.application);
      console.log('Application 2 saved to DB:', result2.application.applicationId, 'state:', result2.application.state);
    }

    // DB verification
    const jobCheck = await jobRepo.getJob(jobId);
    const jdCheck = await jdRepo.getByJobId(jobId);
    const matchCheck = await matchRepo.getByJobId(jobId);
    const resumeCheck = await resumeRepo.getByJobId(jobId);
    const coverCheck = await coverRepo.getByJobId(jobId);

    console.log('DB verification: Job=%s, JD=%s, Match=%s, Resume=%s, Cover=%s',
      !!jobCheck, !!jdCheck, !!matchCheck, !!resumeCheck, !!coverCheck);

    expect(jobCheck).toBeDefined();
    expect(jdCheck).toBeDefined();
    expect(matchCheck).toBeDefined();
    expect(resumeCheck).toBeDefined();
    expect(coverCheck).toBeDefined();
    expect(result.success || result2.success).toBeTruthy();

    // TASK 9: Excel Sync verification
    console.log('\n=== EXCEL SYNC ===');
    const {excelSync} = await import(path.join(srcPath, 'sync/excel.ts'));
    
    const excelResult = await excelSync.sync(
      appRepo, jobRepo, matchRepo, resumeRepo, coverRepo, {}
    );
    console.log('Excel sync result: filePath=%s, applicationsSynced=%d', excelResult.filePath, excelResult.applicationsSynced);
    console.log('Excel sheets: %s', excelResult.sheets.join(', '));
    
    // Verify Excel file exists
    const fs = await import('fs');
    const excelExists = fs.existsSync(excelResult.filePath);
    console.log('Excel file exists:', excelExists);
    expect(excelExists).toBe(true);
    expect(excelResult.applicationsSynced).toBeGreaterThanOrEqual(1);

    // TASK 10: Performance collector verification
    console.log('\n=== PERFORMANCE ===');
    // Import from hooks to get same instance used by source code via require()
    const {performanceCollector} = await import(path.join(srcPath, 'performance/hooks.ts'));
    const measurements = performanceCollector.getMeasurements();
    console.log('Total measurements collected:', measurements.length);
    
    const stats = performanceCollector.calculateStats();
    console.log('Performance stages:');
    for (const stat of stats) {
      console.log(`  ${stat.stage}: count=${stat.count}, avg=${Math.round(stat.average)}ms, success=${stat.successCount}/${stat.count}`);
    }
    
    const overall = performanceCollector.calculateOverall();
    console.log('Overall: totalJobs=' + overall.totalJobs + ', totalTimeMs=' + Math.round(overall.totalTimeMs));
    
    // Verify we captured timing data
    expect(measurements.length).toBeGreaterThan(0);
    expect(stats.length).toBeGreaterThan(0);
    
    console.log('\n=== PHASE 2 COMPLETE ===');
    console.log('Final state (autoSubmit=false): %s', result.application.state);
    console.log('Final state (autoSubmit=true): %s', result2.application.state);
    console.log('Confirmation ID: %s', result2.application.confirmationId);
  }, 120000);
});