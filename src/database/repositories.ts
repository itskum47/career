/**
 * Repository layer for database operations.
 */

import type { DatabaseClient, QueryResult } from './client.ts';
import type { JobId, ApplicationId, CandidateId, CompanyId, MasterProfile } from '../core/types.ts';
import type { DiscoveredJob, JobDescription, MatchAnalysis, ResumeVersion, CoverLetter, Application, ApplicationEvent, BrowserSession, SkillGap } from '../core/types.ts';
import { logger } from '../core/logger.ts';

function rowToJob(row: any): DiscoveredJob {
  return {
    jobId: row.job_id as JobId,
    company: row.company_name,
    title: row.title,
    location: row.location,
    remote: row.remote,
    url: row.url,
    source: row.source as any,
    postedAt: row.posted_at ? new Date(row.posted_at) : undefined,
    description: row.description,
    salary: row.salary_text,
    employmentType: row.employment_type as any,
    seniority: row.seniority as any,
    // Phase 6R — source/route provenance (nullable until 002 migration applied).
    sourceJobId: row.source_job_id ?? undefined,
    discoveredFrom: row.discovered_from ?? undefined,
    canonicalSource: row.canonical_source ?? undefined,
    canonicalJobUrl: row.canonical_job_url ?? undefined,
    applicationUrl: row.application_url ?? undefined,
    applicationRoute: row.application_route ?? undefined,
    atsType: row.ats_type ?? undefined,
    jdHash: row.jd_hash ?? undefined,
    jdComplete: row.jd_complete ? true : undefined,
    canonicalKey: row.canonical_key ?? undefined,
    dedupeConfidence: row.dedupe_confidence ?? undefined,
    allowedCountries: row.allowed_countries ? safeParseArray(row.allowed_countries) : undefined,
    priorityScore: row.priority_score ?? undefined,
    priorityRank: row.priority_rank ?? undefined,
    rawData: parseJsonColumn(row.raw_data),
  };
}

function parseJsonColumn(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function safeParseArray(value: string): string[] | undefined {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : undefined;
  } catch {
    return undefined;
  }
}

function rowToJobDescription(row: any): JobDescription {
  return {
    jobId: row.job_id as JobId,
    company: row.company_name || '',
    title: row.title || '',
    location: row.location || '',
    remote: row.remote,
    remotePolicy: row.remote_policy as any,
    seniority: row.seniority as any,
    employmentType: row.employment_type as any,
    requiredSkills: JSON.parse(row.required_skills || '[]'),
    preferredSkills: JSON.parse(row.preferred_skills || '[]'),
    niceToHaveSkills: JSON.parse(row.nice_to_have_skills || '[]'),
    responsibilities: JSON.parse(row.responsibilities || '[]'),
    experienceRequirements: JSON.parse(row.experience_requirements || '[]'),
    educationRequirements: JSON.parse(row.education_requirements || '[]'),
    certifications: JSON.parse(row.certifications || '[]'),
    cloudPlatforms: JSON.parse(row.cloud_platforms || '[]'),
    programmingLanguages: JSON.parse(row.programming_languages || '[]'),
    devopsTools: JSON.parse(row.devops_tools || '[]'),
    cicdTools: JSON.parse(row.cicd_tools || '[]'),
    monitoringTools: JSON.parse(row.monitoring_tools || '[]'),
    databases: JSON.parse(row.databases || '[]'),
    securityRequirements: JSON.parse(row.security_requirements || '[]'),
    keywords: JSON.parse(row.keywords || '[]'),
    salary: row.salary ? JSON.parse(row.salary) : undefined,
    visaRequirements: row.visa_requirements ? JSON.parse(row.visa_requirements) : undefined,
    applicationQuestions: JSON.parse(row.application_questions || '[]'),
    otherConstraints: JSON.parse(row.other_constraints || '[]'),
    fullText: row.full_text,
    extractedAt: new Date(row.extracted_at),
    confidence: row.confidence,
    sourceUrl: '',
    extractionMethod: row.extraction_method as any,
  };
}

function rowToApplication(row: any): Application {
  return {
    applicationId: row.application_id as ApplicationId,
    jobId: row.job_id as JobId,
    candidateId: row.candidate_id as CandidateId,
    companyId: row.company_id as CompanyId,
    state: row.state as any,
    status: row.status as any,
    resumeId: row.resume_id,
    coverLetterId: row.cover_letter_id,
    browserSessionId: row.browser_session_id,
    confirmationId: row.confirmation_id,
    submittedAt: row.submitted_at ? new Date(row.submitted_at) : undefined,
    confirmedAt: row.confirmed_at ? new Date(row.confirmed_at) : undefined,
    error: row.error,
    notes: row.notes,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    nextAction: row.next_action,
    nextActionAt: row.next_action_at ? new Date(row.next_action_at) : undefined,
    // Phase 6R — where found vs where submitted (nullable columns).
    discoveredFrom: row.discovered_from ?? undefined,
    canonicalSource: row.canonical_source ?? undefined,
    applicationRoute: row.application_route ?? undefined,
    atsType: row.ats_type ?? undefined,
    applicationUrl: row.application_url ?? undefined,
    sourceJobId: row.source_job_id ?? undefined,
    canonicalKey: row.canonical_key ?? undefined,
    loginInterrupted: row.login_interrupted ? true : undefined,
    captchaInterrupted: row.captcha_interrupted ? true : undefined,
  };
}

export class JobRepository {
  private db: DatabaseClient;
  constructor(db: DatabaseClient) {
      this.db = db;
  }

  async upsertCompany(company: { companyId: CompanyId; name: string; domain?: string; careerUrl?: string; atsType?: string }): Promise<void> {
    await this.db.query(`
      INSERT INTO companies (company_id, name, domain, career_url, ats_type)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(company_id) DO UPDATE SET
        name = excluded.name,
        domain = excluded.domain,
        career_url = excluded.career_url,
        ats_type = excluded.ats_type,
        updated_at = CURRENT_TIMESTAMP
    `, [company.companyId, company.name, company.domain, company.careerUrl, company.atsType]);
  }

  async upsertJob(job: DiscoveredJob, companyId: CompanyId): Promise<void> {
    const postedAt = job.postedAt ? job.postedAt.toISOString() : null;
    const remotePolicy = job.remotePolicy ?? null;
    const seniority = job.seniority ?? null;
    const employmentType = job.employmentType ?? null;
    const salary = job.salary ?? null;
    const remote = job.remote ? 1 : 0;
    await this.db.query(`
      INSERT INTO jobs (job_id, company_id, source, title, location, remote, remote_policy, seniority, employment_type, url, description, salary_text, posted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        company_id = excluded.company_id,
        source = excluded.source,
        title = excluded.title,
        location = excluded.location,
        remote = excluded.remote,
        remote_policy = excluded.remote_policy,
        seniority = excluded.seniority,
        employment_type = excluded.employment_type,
        url = excluded.url,
        description = excluded.description,
        salary_text = excluded.salary_text,
        posted_at = excluded.posted_at,
        updated_at = CURRENT_TIMESTAMP
    `, [job.jobId, companyId, job.source, job.title, job.location, remote, remotePolicy, seniority, employmentType, job.url, job.description, salary, postedAt]);
  }

  async getJob(jobId: JobId): Promise<DiscoveredJob | null> {
    const result = await this.db.query(`
      SELECT j.*, c.name as company_name
      FROM jobs j
      JOIN companies c ON j.company_id = c.company_id
      WHERE j.job_id = ?
    `, [jobId]);
    return result.rows.length > 0 ? rowToJob(result.rows[0]) : null;
  }

  async getJobsBySource(source: string, limit = 100): Promise<DiscoveredJob[]> {
    const result = await this.db.query(`
      SELECT j.*, c.name as company_name
      FROM jobs j
      JOIN companies c ON j.company_id = c.company_id
      WHERE j.source = ?
      ORDER BY j.discovered_at DESC
      LIMIT ?
    `, [source, limit]);
    return result.rows.map(rowToJob);
  }

  /** 6S — all jobs for the Excel mirror (DB remains source of truth). */
  async getAllJobs(limit = 10000): Promise<DiscoveredJob[]> {
    const result = await this.db.query(`
      SELECT j.*, c.name as company_name
      FROM jobs j
      JOIN companies c ON j.company_id = c.company_id
      ORDER BY j.discovered_at DESC
      LIMIT ?
    `, [limit]);
    return result.rows.map(rowToJob);
  }

  async getUnverifiedJobs(limit = 100): Promise<DiscoveredJob[]> {
    const result = await this.db.query(`
      SELECT j.*, c.name as company_name
      FROM jobs j
      JOIN companies c ON j.company_id = c.company_id
      WHERE j.verified = FALSE
      ORDER BY j.discovered_at DESC
      LIMIT ?
    `, [limit]);
    return result.rows.map(rowToJob);
  }

  async markJobVerified(jobId: JobId, confidence: number, fullDescription?: string): Promise<void> {
    await this.db.query(`
      UPDATE jobs SET verified = TRUE, verification_confidence = ?, description = COALESCE(?, description), updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ?
    `, [confidence, fullDescription, jobId]);
  }

  // -------------------------------------------------------------------------
  // Phase 6R — source/route tracking for normalized jobs.
  // -------------------------------------------------------------------------

  /**
   * Persist a NormalizedJob with full Phase 6 tracking fields
   * (internal vs source IDs, discovery source, canonical source, route, ATS).
   * Upserts on job_id; url conflicts (unique) fall back to updating by url.
   */
  async upsertNormalizedJob(
    job: {
      internalJobId: JobId; source: string; sourceJobId: string;
      sourceUrl: string; canonicalJobUrl: string; applicationUrl: string;
      company: string; title: string; location: string; remote: boolean;
      remotePolicy?: string; allowedCountries?: string[]; timezone?: string;
      employmentType?: string; seniority?: string; salary?: string;
      postedAt?: Date; description: string; ats?: string;
      jdHash?: string; jdComplete?: boolean; canonicalKey?: string;
      dedupeConfidence?: number; priorityScore?: number; priorityRank?: number;
      ineligibleReasons?: string[];
    },
    companyId: CompanyId,
    route?: { discoveredFrom?: string; canonicalSource?: string; applicationRoute?: string }
  ): Promise<JobId> {
    const j = job;
    // Reuse an existing job_id when the url is already present (unique constraint)
    // so re-running a sweep updates rather than collides.
    const existing = await this.db.query('SELECT job_id FROM jobs WHERE url = ?', [j.sourceUrl]);
    const effectiveJobId: JobId = (existing.rows.length > 0 ? existing.rows[0].job_id : j.internalJobId) as JobId;
    await this.db.query(`
      INSERT INTO jobs (
        job_id, company_id, source, title, location, remote, remote_policy,
        seniority, employment_type, url, description, salary_text, posted_at,
        source_job_id, discovered_from, canonical_source, canonical_job_url,
        application_url, application_route, ats_type, jd_hash, jd_complete,
        canonical_key, dedupe_confidence, allowed_countries, timezone,
        priority_score, priority_rank, ineligible_reasons
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(job_id) DO UPDATE SET
        company_id = excluded.company_id,
        source = excluded.source,
        title = excluded.title,
        location = excluded.location,
        remote = excluded.remote,
        remote_policy = excluded.remote_policy,
        seniority = excluded.seniority,
        employment_type = excluded.employment_type,
        url = excluded.url,
        description = excluded.description,
        salary_text = excluded.salary_text,
        posted_at = excluded.posted_at,
        source_job_id = excluded.source_job_id,
        discovered_from = excluded.discovered_from,
        canonical_source = excluded.canonical_source,
        canonical_job_url = excluded.canonical_job_url,
        application_url = excluded.application_url,
        application_route = excluded.application_route,
        ats_type = excluded.ats_type,
        jd_hash = excluded.jd_hash,
        jd_complete = excluded.jd_complete,
        canonical_key = excluded.canonical_key,
        dedupe_confidence = excluded.dedupe_confidence,
        allowed_countries = excluded.allowed_countries,
        timezone = excluded.timezone,
        priority_score = excluded.priority_score,
        priority_rank = excluded.priority_rank,
        ineligible_reasons = excluded.ineligible_reasons,
        updated_at = CURRENT_TIMESTAMP
    `, [
      effectiveJobId, companyId, j.source, j.title, j.location, j.remote ? 1 : 0, j.remotePolicy ?? null,
      j.seniority ?? null, j.employmentType ?? null, j.sourceUrl, j.description, j.salary ?? null,
      j.postedAt ? j.postedAt.toISOString() : null,
      j.sourceJobId, route?.discoveredFrom ?? j.source, route?.canonicalSource ?? null,
      j.canonicalJobUrl, j.applicationUrl, route?.applicationRoute ?? null, j.ats ?? null,
      j.jdHash ?? null, j.jdComplete ? 1 : 0, j.canonicalKey ?? null, j.dedupeConfidence ?? null,
      j.allowedCountries ? JSON.stringify(j.allowedCountries) : null, j.timezone ?? null,
      j.priorityScore ?? null, j.priorityRank ?? null,
      j.ineligibleReasons?.length ? JSON.stringify(j.ineligibleReasons) : null,
    ]);
    return effectiveJobId;
  }

  /** Preserve every source occurrence of a canonical job (6F). */
  async addJobOccurrence(occ: {
    occurrenceId: string; canonicalKey: string; jobId: JobId;
    source: string; sourceJobId?: string; sourceUrl: string; dedupeConfidence?: number;
  }): Promise<void> {
    await this.db.query(`
      INSERT INTO job_occurrences (occurrence_id, canonical_key, job_id, source, source_job_id, source_url, dedupe_confidence)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(occurrence_id) DO UPDATE SET dedupe_confidence = excluded.dedupe_confidence
    `, [occ.occurrenceId, occ.canonicalKey, occ.jobId, occ.source, occ.sourceJobId ?? null, occ.sourceUrl, occ.dedupeConfidence ?? null]);
  }

  /** All occurrences sharing a canonical identity (6F/6X queries). */
  async getOccurrencesByCanonicalKey(canonicalKey: string): Promise<Array<{
    occurrenceId: string; jobId: JobId; source: string; sourceJobId?: string;
    sourceUrl: string; dedupeConfidence?: number;
  }>> {
    const result = await this.db.query(
      `SELECT * FROM job_occurrences WHERE canonical_key = ? ORDER BY discovered_at ASC`,
      [canonicalKey]
    );
    return result.rows.map((r: any) => ({
      occurrenceId: r.occurrence_id,
      jobId: r.job_id as JobId,
      source: r.source,
      sourceJobId: r.source_job_id ?? undefined,
      sourceUrl: r.source_url,
      dedupeConfidence: r.dedupe_confidence ?? undefined,
    }));
  }

  /** Jobs belonging to a canonical identity (any occurrence). */
  async getJobsByCanonicalKey(canonicalKey: string): Promise<DiscoveredJob[]> {
    const result = await this.db.query(`
      SELECT DISTINCT j.*, c.name as company_name
      FROM jobs j
      JOIN companies c ON j.company_id = c.company_id
      WHERE j.canonical_key = ?
    `, [canonicalKey]);
    return result.rows.map(rowToJob);
  }

  /** 6N — persist per-source health snapshot. */
  async upsertSourceHealth(m: {
    source: string; state: string; searchesAttempted: number; searchesCompleted: number;
    jobsDiscovered: number; jobsNormalized: number; duplicates: number; uniqueJobs: number;
    jdRetrievalSuccess: number; jdRetrievalAttempts: number;
    routeResolutionSuccess: number; routeResolutionAttempts: number;
    applicationSuccess: number; applicationAttempts: number;
    failures: number; loginInterruptions: number; captchaInterruptions: number;
    timeouts: number; avgLatencyMs: number; lastError?: string;
  }): Promise<void> {
    await this.db.query(`
      INSERT INTO source_health (
        source, state, searches_attempted, searches_completed, jobs_discovered,
        jobs_normalized, duplicates, unique_jobs, jd_retrieval_success, jd_retrieval_attempts,
        route_resolution_success, route_resolution_attempts, application_success, application_attempts,
        failures, login_interruptions, captcha_interruptions, timeouts, avg_latency_ms,
        last_error, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(source) DO UPDATE SET
        state = excluded.state,
        searches_attempted = excluded.searches_attempted,
        searches_completed = excluded.searches_completed,
        jobs_discovered = excluded.jobs_discovered,
        jobs_normalized = excluded.jobs_normalized,
        duplicates = excluded.duplicates,
        unique_jobs = excluded.unique_jobs,
        jd_retrieval_success = excluded.jd_retrieval_success,
        jd_retrieval_attempts = excluded.jd_retrieval_attempts,
        route_resolution_success = excluded.route_resolution_success,
        route_resolution_attempts = excluded.route_resolution_attempts,
        application_success = excluded.application_success,
        application_attempts = excluded.application_attempts,
        failures = excluded.failures,
        login_interruptions = excluded.login_interruptions,
        captcha_interruptions = excluded.captcha_interruptions,
        timeouts = excluded.timeouts,
        avg_latency_ms = excluded.avg_latency_ms,
        last_error = excluded.last_error,
        updated_at = CURRENT_TIMESTAMP
    `, [
      m.source, m.state, m.searchesAttempted, m.searchesCompleted, m.jobsDiscovered,
      m.jobsNormalized, m.duplicates, m.uniqueJobs, m.jdRetrievalSuccess, m.jdRetrievalAttempts,
      m.routeResolutionSuccess, m.routeResolutionAttempts, m.applicationSuccess, m.applicationAttempts,
      m.failures, m.loginInterruptions, m.captchaInterruptions, m.timeouts, m.avgLatencyMs,
      m.lastError ?? null,
    ]);
  }

  async getSourceHealth(): Promise<Array<Record<string, any>>> {
    const result = await this.db.query(`SELECT * FROM source_health ORDER BY source ASC`);
    return result.rows;
  }
}

export class JobDescriptionRepository {
  private db: DatabaseClient;
  constructor(db: DatabaseClient) {
      this.db = db;
  }

  async upsert(jd: JobDescription): Promise<void> {
    await this.db.query(`
      INSERT INTO job_descriptions (
        job_id, required_skills, preferred_skills, nice_to_have_skills,
        responsibilities, experience_requirements, education_requirements, certifications,
        cloud_platforms, programming_languages, devops_tools, cicd_tools,
        monitoring_tools, databases, security_requirements, keywords,
        salary, visa_requirements, application_questions, other_constraints,
        full_text, extracted_at, confidence, extraction_method
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        required_skills = excluded.required_skills,
        preferred_skills = excluded.preferred_skills,
        nice_to_have_skills = excluded.nice_to_have_skills,
        responsibilities = excluded.responsibilities,
        experience_requirements = excluded.experience_requirements,
        education_requirements = excluded.education_requirements,
        certifications = excluded.certifications,
        cloud_platforms = excluded.cloud_platforms,
        programming_languages = excluded.programming_languages,
        devops_tools = excluded.devops_tools,
        cicd_tools = excluded.cicd_tools,
        monitoring_tools = excluded.monitoring_tools,
        databases = excluded.databases,
        security_requirements = excluded.security_requirements,
        keywords = excluded.keywords,
        salary = excluded.salary,
        visa_requirements = excluded.visa_requirements,
        application_questions = excluded.application_questions,
        other_constraints = excluded.other_constraints,
        full_text = excluded.full_text,
        extracted_at = excluded.extracted_at,
        confidence = excluded.confidence,
        extraction_method = excluded.extraction_method
    `, [
      jd.jobId,
      JSON.stringify(jd.requiredSkills),
      JSON.stringify(jd.preferredSkills),
      JSON.stringify(jd.niceToHaveSkills),
      JSON.stringify(jd.responsibilities),
      JSON.stringify(jd.experienceRequirements),
      JSON.stringify(jd.educationRequirements),
      JSON.stringify(jd.certifications),
      JSON.stringify(jd.cloudPlatforms),
      JSON.stringify(jd.programmingLanguages),
      JSON.stringify(jd.devopsTools),
      JSON.stringify(jd.cicdTools),
      JSON.stringify(jd.monitoringTools),
      JSON.stringify(jd.databases),
      JSON.stringify(jd.securityRequirements),
      JSON.stringify(jd.keywords),
      jd.salary ? JSON.stringify(jd.salary) : null,
      jd.visaRequirements ? JSON.stringify(jd.visaRequirements) : null,
      JSON.stringify(jd.applicationQuestions),
      JSON.stringify(jd.otherConstraints),
      jd.fullText,
      jd.extractedAt.toISOString(),
      jd.confidence,
      jd.extractionMethod,
    ]);
  }

  async getByJobId(jobId: JobId): Promise<JobDescription | null> {
    const result = await this.db.query(`
      SELECT jd.*, c.name as company_name, j.title
      FROM job_descriptions jd
      JOIN jobs j ON jd.job_id = j.job_id
      JOIN companies c ON j.company_id = c.company_id
      WHERE jd.job_id = ?
    `, [jobId]);
    return result.rows.length > 0 ? rowToJobDescription(result.rows[0]) : null;
  }
}

export class MatchRepository {
  private db: DatabaseClient;
  constructor(db: DatabaseClient) {
      this.db = db;
  }

  async upsert(match: MatchAnalysis): Promise<void> {
    await this.db.query(`
      INSERT INTO match_analyses (
        match_id, job_id, candidate_id, overall_score, required_skill_coverage,
        preferred_skill_coverage, experience_match, project_relevance, cloud_platform_match,
        education_match, location_match, authorization_compatibility, keyword_coverage,
        missing_required, missing_preferred, explanation, recommendation, confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(match_id) DO UPDATE SET
        overall_score = excluded.overall_score,
        required_skill_coverage = excluded.required_skill_coverage,
        preferred_skill_coverage = excluded.preferred_skill_coverage,
        experience_match = excluded.experience_match,
        project_relevance = excluded.project_relevance,
        cloud_platform_match = excluded.cloud_platform_match,
        education_match = excluded.education_match,
        location_match = excluded.location_match,
        authorization_compatibility = excluded.authorization_compatibility,
        keyword_coverage = excluded.keyword_coverage,
        missing_required = excluded.missing_required,
        missing_preferred = excluded.missing_preferred,
        explanation = excluded.explanation,
        recommendation = excluded.recommendation,
        confidence = excluded.confidence
    `, [
      match.matchId,
      match.jobId,
      match.candidateId,
      match.overallScore,
      match.requiredSkillCoverage,
      match.preferredSkillCoverage,
      match.experienceMatch,
      match.projectRelevance,
      match.cloudPlatformMatch,
      match.educationMatch,
      match.locationMatch,
      match.authorizationCompatibility,
      match.keywordCoverage,
      JSON.stringify(match.missingRequired),
      JSON.stringify(match.missingPreferred),
      match.explanation,
      match.recommendation,
      match.confidence,
    ]);
  }

  async getByJobId(jobId: JobId, candidateId: CandidateId): Promise<MatchAnalysis | null> {
    const result = await this.db.query(`
      SELECT * FROM match_analyses WHERE job_id = ? AND candidate_id = ?
    `, [jobId, candidateId]);
    return result.rows.length > 0 ? this.rowToMatch(result.rows[0]) : null;
  }

  private rowToMatch(row: any): MatchAnalysis {
    return {
      matchId: row.match_id,
      jobId: row.job_id as JobId,
      candidateId: row.candidate_id as CandidateId,
      overallScore: row.overall_score,
      requiredSkillCoverage: row.required_skill_coverage,
      preferredSkillCoverage: row.preferred_skill_coverage,
      experienceMatch: row.experience_match,
      projectRelevance: row.project_relevance,
      cloudPlatformMatch: row.cloud_platform_match,
      educationMatch: row.education_match,
      locationMatch: row.location_match,
      authorizationCompatibility: row.authorization_compatibility,
      keywordCoverage: row.keyword_coverage,
      missingRequired: JSON.parse(row.missing_required || '[]'),
      missingPreferred: JSON.parse(row.missing_preferred || '[]'),
      explanation: row.explanation,
      recommendation: row.recommendation as any,
      confidence: row.confidence,
      analyzedAt: new Date(row.analyzed_at),
    };
  }
}

export class ResumeRepository {
  private db: DatabaseClient;
  constructor(db: DatabaseClient) {
      this.db = db;
  }

  async upsert(resume: ResumeVersion): Promise<void> {
    await this.db.query(`
      INSERT INTO resumes (resume_id, job_id, application_id, candidate_id, version, format, file_path, ats_score, ats_details, generated_at, generator_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(resume_id) DO UPDATE SET
        application_id = excluded.application_id,
        version = excluded.version,
        format = excluded.format,
        file_path = excluded.file_path,
        ats_score = excluded.ats_score,
        ats_details = excluded.ats_details,
        generated_at = excluded.generated_at,
        generator_version = excluded.generator_version
    `, [
      resume.resumeId,
      resume.jobId,
      resume.applicationId,
      resume.candidateId,
      resume.version,
      resume.format,
      resume.filePath,
      resume.atsScore?.overall || null,
      resume.atsScore ? JSON.stringify(resume.atsScore) : null,
      resume.generatedAt.toISOString(),
      resume.generatorVersion,
    ]);
  }

  async getByJobId(jobId: JobId, candidateId: CandidateId): Promise<ResumeVersion[]> {
    const result = await this.db.query(`
      SELECT * FROM resumes WHERE job_id = ? AND candidate_id = ? ORDER BY version DESC
    `, [jobId, candidateId]);
    return result.rows.map(this.rowToResume);
  }

  private rowToResume(row: any): ResumeVersion {
    return {
      resumeId: row.resume_id,
      jobId: row.job_id as JobId,
      applicationId: row.application_id as ApplicationId | undefined,
      candidateId: row.candidate_id as CandidateId,
      version: row.version,
      format: row.format as any,
      filePath: row.file_path,
      atsScore: row.ats_details ? JSON.parse(row.ats_details) : undefined,
      generatedAt: new Date(row.generated_at),
      generatorVersion: row.generator_version,
    };
  }
}

export class CoverLetterRepository {
  private db: DatabaseClient;
  constructor(db: DatabaseClient) {
      this.db = db;
  }

  async upsert(cl: CoverLetter): Promise<void> {
    await this.db.query(`
      INSERT INTO cover_letters (cover_letter_id, job_id, application_id, candidate_id, content, file_path, template_id, generated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cover_letter_id) DO UPDATE SET
        application_id = excluded.application_id,
        content = excluded.content,
        file_path = excluded.file_path,
        template_id = excluded.template_id
    `, [
      cl.coverLetterId,
      cl.jobId,
      cl.applicationId,
      cl.candidateId,
      cl.content,
      cl.filePath,
      cl.templateId,
      cl.generatedAt.toISOString(),
    ]);
  }

  async getByJobId(jobId: JobId, candidateId: CandidateId): Promise<CoverLetter[]> {
    const result = await this.db.query(`
      SELECT * FROM cover_letters WHERE job_id = ? AND candidate_id = ? ORDER BY generated_at DESC
    `, [jobId, candidateId]);
    return result.rows.map(this.rowToCoverLetter);
  }

  private rowToCoverLetter(row: any): CoverLetter {
    return {
      coverLetterId: row.cover_letter_id,
      jobId: row.job_id as JobId,
      applicationId: row.application_id as ApplicationId | undefined,
      candidateId: row.candidate_id as CandidateId,
      content: row.content,
      filePath: row.file_path,
      generatedAt: new Date(row.generated_at),
      templateId: row.template_id,
    };
  }
}

export class ApplicationRepository {
  private db: DatabaseClient;
  constructor(db: DatabaseClient) {
      this.db = db;
  }

  /**
   * Phase 6W/6X — durable "a submit click was started" marker, written BEFORE
   * the irreversible click so a crash can never erase the knowledge that a real
   * click happened (measured: APP-20261008-000099 lost exactly this).
   */
  async markSubmissionStarted(
    applicationId: ApplicationId,
    phase: string,
    at: Date = new Date()
  ): Promise<void> {
    await this.db.query(
      `UPDATE applications SET submission_started_at = ?, submission_state = ?, updated_at = ? WHERE application_id = ?`,
      [at.toISOString(), phase, at.toISOString(), applicationId]
    );
  }

  async markSubmissionPhase(applicationId: ApplicationId, phase: string): Promise<void> {
    await this.db.query(
      `UPDATE applications SET submission_state = ?, updated_at = ? WHERE application_id = ?`,
      [phase, new Date().toISOString(), applicationId]
    );
  }

  async create(application: Application): Promise<void> {
    await this.db.query(`
      INSERT INTO applications (
        application_id, job_id, candidate_id, company_id, state, status,
        resume_id, cover_letter_id, browser_session_id, confirmation_id,
        submitted_at, confirmed_at, error, notes, created_at, updated_at,
        next_action, next_action_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      application.applicationId,
      application.jobId,
      application.candidateId,
      application.companyId,
      application.state,
      application.status,
      application.resumeId,
      application.coverLetterId,
      application.browserSessionId,
      application.confirmationId,
      application.submittedAt?.toISOString(),
      application.confirmedAt?.toISOString(),
      application.error,
      application.notes,
      application.createdAt.toISOString(),
      application.updatedAt.toISOString(),
      application.nextAction,
      application.nextActionAt?.toISOString(),
    ]);
  }

  async updateState(applicationId: ApplicationId, state: Application['state'], status: Application['status'], error?: string): Promise<void> {
    await this.db.query(`
      UPDATE applications SET state = ?, status = ?, error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE application_id = ?
    `, [state, status, error, applicationId]);
  }

  async update(application: Application): Promise<void> {
    await this.db.query(`
      UPDATE applications SET
        state = ?, status = ?, resume_id = ?, cover_letter_id = ?,
        browser_session_id = ?, confirmation_id = ?,
        submitted_at = ?, confirmed_at = ?, error = ?, notes = ?,
        updated_at = CURRENT_TIMESTAMP, next_action = ?, next_action_at = ?
      WHERE application_id = ?
    `, [
      application.state, application.status, application.resumeId,
      application.coverLetterId, application.browserSessionId,
      application.confirmationId, application.submittedAt?.toISOString(),
      application.confirmedAt?.toISOString(), application.error,
      application.notes, application.nextAction, application.nextActionAt?.toISOString(),
      application.applicationId,
    ]);
  }

  async getById(applicationId: ApplicationId): Promise<Application | null> {
    const result = await this.db.query(`
      SELECT * FROM applications WHERE application_id = ?
    `, [applicationId]);
    return result.rows.length > 0 ? rowToApplication(result.rows[0]) : null;
  }

  async getByJobId(jobId: JobId, candidateId: CandidateId): Promise<Application | null> {
    const result = await this.db.query(`
      SELECT * FROM applications WHERE job_id = ? AND candidate_id = ?
    `, [jobId, candidateId]);
    return result.rows.length > 0 ? rowToApplication(result.rows[0]) : null;
  }

  async getByState(state: Application['state'], limit = 100): Promise<Application[]> {
    const result = await this.db.query(`
      SELECT * FROM applications WHERE state = ? ORDER BY created_at DESC LIMIT ?
    `, [state, limit]);
    return result.rows.map(rowToApplication);
  }

  // -------------------------------------------------------------------------
  // Phase 6X — duplicate application protection (pre-flight guard).
  //
  // States that mean "an application already exists / is in flight / done"
  // for a canonical job. Matching ANY of these => DO NOT APPLY AGAIN.
  //   completed:  SUBMITTED, CONFIRMED, INTERVIEW, ASSESSMENT, OFFER
  //   in-flight:  BROWSER_STARTED, FORM_ANALYZING, FORM_FILLING,
  //               PAUSED_FOR_USER, READY_TO_SUBMIT, SUBMISSION_UNCERTAIN
  // Not blocking (may legitimately retry): DISCOVERED..READY_TO_APPLY,
  //   SKIPPED, REJECTED, WITHDRAWN, ERROR, BLOCKED.
  // -------------------------------------------------------------------------
  static readonly BLOCKING_STATES: readonly Application['state'][] = [
    'BROWSER_STARTED', 'FORM_ANALYZING', 'FORM_FILLING', 'PAUSED_FOR_USER',
    'READY_TO_SUBMIT', 'SUBMITTED', 'CONFIRMED', 'SUBMISSION_UNCERTAIN',
    'INTERVIEW', 'ASSESSMENT', 'OFFER',
  ];
  static readonly BLOCKING_STATUS: readonly Application['status'][] = [
    'in_progress', 'submitted', 'confirmed', 'interviewing', 'assessment', 'offer',
  ];

  /**
   * 6X pre-flight: is there already an application for this job that blocks
   * a second submission? Checks the exact job_id first.
   */
  async findBlockingApplication(jobId: JobId, candidateId: CandidateId): Promise<Application | null> {
    const states = ApplicationRepository.BLOCKING_STATES;
    const statuses = ApplicationRepository.BLOCKING_STATUS;
    const result = await this.db.query(`
      SELECT * FROM applications
      WHERE job_id = ? AND candidate_id = ?
        AND (state IN (${states.map(() => '?').join(',')})
             OR status IN (${statuses.map(() => '?').join(',')}))
      ORDER BY created_at DESC LIMIT 1
    `, [jobId, candidateId, ...states, ...statuses]);
    return result.rows.length > 0 ? rowToApplication(result.rows[0]) : null;
  }

  /**
   * 6X pre-flight across a canonical identity: multiple portal listings
   * resolving to one canonical job must yield ONE application opportunity.
   * Joins jobs on canonical_key (falls back to application_url match).
   */
  async findBlockingApplicationByCanonical(
    canonicalKey: string | undefined,
    applicationUrl: string | undefined,
    candidateId: CandidateId
  ): Promise<Application | null> {
    const states = ApplicationRepository.BLOCKING_STATES;
    const statuses = ApplicationRepository.BLOCKING_STATUS;
    const conds: string[] = [];
    const params: unknown[] = [candidateId];
    if (canonicalKey) {
      conds.push('j.canonical_key = ?');
      params.push(canonicalKey);
    }
    if (applicationUrl) {
      conds.push('j.application_url = ?');
      params.push(applicationUrl);
    }
    if (!conds.length) return null;
    params.push(...states, ...statuses);
    const result = await this.db.query(`
      SELECT a.* FROM applications a
      JOIN jobs j ON a.job_id = j.job_id
      WHERE a.candidate_id = ?
        AND (${conds.join(' OR ')})
        AND (a.state IN (${states.map(() => '?').join(',')})
             OR a.status IN (${statuses.map(() => '?').join(',')}))
      ORDER BY a.created_at DESC LIMIT 1
    `, params);
    return result.rows.length > 0 ? rowToApplication(result.rows[0]) : null;
  }

  /**
   * 6R — persist where the application was found vs where it was submitted.
   * Also flags login/CAPTCHA interruptions (6K/6L) on the record itself.
   */
  async recordApplicationRoute(applicationId: ApplicationId, route: {
    discoveredFrom?: string;
    canonicalSource?: string;
    applicationRoute?: string;
    atsType?: string;
    applicationUrl?: string;
    sourceJobId?: string;
    canonicalKey?: string;
    loginInterrupted?: boolean;
    captchaInterrupted?: boolean;
  }): Promise<void> {
    await this.db.query(`
      UPDATE applications SET
        discovered_from = COALESCE(?, discovered_from),
        canonical_source = COALESCE(?, canonical_source),
        application_route = COALESCE(?, application_route),
        ats_type = COALESCE(?, ats_type),
        application_url = COALESCE(?, application_url),
        source_job_id = COALESCE(?, source_job_id),
        canonical_key = COALESCE(?, canonical_key),
        login_interrupted = COALESCE(?, login_interrupted),
        captcha_interrupted = COALESCE(?, captcha_interrupted),
        updated_at = CURRENT_TIMESTAMP
      WHERE application_id = ?
    `, [
      route.discoveredFrom ?? null, route.canonicalSource ?? null,
      route.applicationRoute ?? null, route.atsType ?? null,
      route.applicationUrl ?? null, route.sourceJobId ?? null,
      route.canonicalKey ?? null,
      route.loginInterrupted ?? null, route.captchaInterrupted ?? null,
      applicationId,
    ]);
  }

  async getPendingApplications(limit = 100): Promise<Application[]> {
    const result = await this.db.query(`
      SELECT * FROM applications
      WHERE state IN ('DISCOVERED', 'VERIFIED', 'ANALYZED', 'MATCHED', 'RESUME_GENERATED', 'RESUME_VALIDATED', 'READY_TO_APPLY', 'BROWSER_STARTED', 'FORM_ANALYZING', 'FORM_FILLING', 'READY_TO_SUBMIT')
      ORDER BY created_at ASC
      LIMIT ?
    `, [limit]);
    return result.rows.map(rowToApplication);
  }

  /** All applications regardless of state - used by the Excel workbook so submitted/confirmed rows appear. */
  async getAllApplications(limit = 10000): Promise<Application[]> {
    const result = await this.db.query(`
      SELECT * FROM applications
      ORDER BY created_at DESC
      LIMIT ?
    `, [limit]);
    return result.rows.map(rowToApplication);
  }
}

export class ApplicationEventRepository {
  private db: DatabaseClient;
  constructor(db: DatabaseClient) {
      this.db = db;
  }

  async create(event: ApplicationEvent): Promise<void> {
    await this.db.query(`
      INSERT INTO application_events (event_id, application_id, type, from_state, to_state, agent, message, metadata, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      event.eventId,
      event.applicationId,
      event.type,
      event.fromState,
      event.toState,
      event.agent,
      event.message,
      event.metadata ? JSON.stringify(event.metadata) : null,
      event.timestamp.toISOString(),
    ]);
  }

  async getByApplicationId(applicationId: ApplicationId): Promise<ApplicationEvent[]> {
    const result = await this.db.query(`
      SELECT * FROM application_events WHERE application_id = ? ORDER BY timestamp ASC
    `, [applicationId]);
    return result.rows.map(this.rowToEvent);
  }

  private rowToEvent(row: any): ApplicationEvent {
    return {
      eventId: row.event_id,
      applicationId: row.application_id as ApplicationId,
      type: row.type as any,
      fromState: row.from_state as any,
      toState: row.to_state as any,
      agent: row.agent,
      message: row.message,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      timestamp: new Date(row.timestamp),
    };
  }
}

export class BrowserSessionRepository {
  private db: DatabaseClient;
  constructor(db: DatabaseClient) {
      this.db = db;
  }

  async upsert(session: BrowserSession): Promise<void> {
    await this.db.query(`
      INSERT INTO browser_sessions (session_id, application_id, job_id, url, state, cookies, local_storage, screenshot_paths, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        application_id = excluded.application_id,
        job_id = excluded.job_id,
        url = excluded.url,
        state = excluded.state,
        cookies = excluded.cookies,
        local_storage = excluded.local_storage,
        screenshot_paths = excluded.screenshot_paths,
        updated_at = CURRENT_TIMESTAMP
    `, [
      session.sessionId,
      session.applicationId,
      session.jobId,
      session.url,
      session.state,
      JSON.stringify(session.cookies),
      JSON.stringify(session.localStorage),
      JSON.stringify(session.screenshotPaths),
      session.createdAt.toISOString(),
      session.updatedAt.toISOString(),
    ]);
  }

  async getByApplicationId(applicationId: ApplicationId): Promise<BrowserSession | null> {
    const result = await this.db.query(`
      SELECT * FROM browser_sessions WHERE application_id = ? ORDER BY updated_at DESC LIMIT 1
    `, [applicationId]);
    return result.rows.length > 0 ? this.rowToSession(result.rows[0]) : null;
  }

  private rowToSession(row: any): BrowserSession {
    return {
      sessionId: row.session_id,
      applicationId: row.application_id as ApplicationId,
      jobId: row.job_id as JobId,
      url: row.url,
      state: row.state as any,
      cookies: JSON.parse(row.cookies || '[]'),
      localStorage: JSON.parse(row.local_storage || '{}'),
      screenshotPaths: JSON.parse(row.screenshot_paths || '[]'),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

export class QuestionAnswerRepository {
  private db: DatabaseClient;
  constructor(db: DatabaseClient) {
      this.db = db;
  }

  async get(questionHash: string): Promise<{ answer: string; confidence: number; source: string } | null> {
    const result = await this.db.query(`
      SELECT answer, confidence, source FROM question_answers
      WHERE question_hash = ? AND (expires_at IS NULL OR expires_at > datetime('now'))
    `, [questionHash]);
    return result.rows.length > 0 ? {
      answer: result.rows[0].answer,
      confidence: result.rows[0].confidence,
      source: result.rows[0].source,
    } : null;
  }

  async set(questionHash: string, question: string, answer: string, category: string, source: string, confidence: number, expiresAt?: Date): Promise<void> {
    await this.db.query(`
      INSERT INTO question_answers (answer_id, question_hash, question, answer, category, source, confidence, expires_at, used_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(question_hash) DO UPDATE SET
        answer = excluded.answer,
        category = excluded.category,
        source = excluded.source,
        confidence = excluded.confidence,
        expires_at = excluded.expires_at,
        used_count = question_answers.used_count + 1,
        answered_at = CURRENT_TIMESTAMP
    `, [
      `ANS-${questionHash}`,
      questionHash,
      question,
      answer,
      category,
      source,
      confidence,
      expiresAt?.toISOString(),
    ]);
  }
}

export class CandidateProfileRepository {
  private db: DatabaseClient;
  constructor(db: DatabaseClient) {
      this.db = db;
  }

  async upsert(profile: MasterProfile): Promise<void> {
    await this.db.query(`
      INSERT INTO candidate_profiles (
        candidate_id, personal_info, education, experience, projects,
        skills, certifications, achievements, preferences, authorization,
        compensation, question_answers, version, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(candidate_id) DO UPDATE SET
        personal_info = excluded.personal_info,
        education = excluded.education,
        experience = excluded.experience,
        projects = excluded.projects,
        skills = excluded.skills,
        certifications = excluded.certifications,
        achievements = excluded.achievements,
        preferences = excluded.preferences,
        authorization = excluded.authorization,
        compensation = excluded.compensation,
        question_answers = excluded.question_answers,
        version = excluded.version,
        updated_at = CURRENT_TIMESTAMP
    `, [
      profile.candidateId,
      JSON.stringify(profile.personal),
      JSON.stringify(profile.education),
      JSON.stringify(profile.experience),
      JSON.stringify(profile.projects),
      JSON.stringify(profile.skills),
      JSON.stringify(profile.certifications),
      JSON.stringify(profile.achievements),
      JSON.stringify(profile.preferences),
      JSON.stringify(profile.authorization),
      JSON.stringify(profile.compensation),
      JSON.stringify(profile.questionAnswers),
      profile.version,
    ]);
  }

  async getByCandidateId(candidateId: string): Promise<MasterProfile | null> {
    const result = await this.db.query(`
      SELECT * FROM candidate_profiles WHERE candidate_id = ?
    `, [candidateId]);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      candidateId: row.candidate_id as CandidateId,
      personal: JSON.parse(row.personal_info),
      education: JSON.parse(row.education),
      experience: JSON.parse(row.experience),
      projects: JSON.parse(row.projects),
      skills: JSON.parse(row.skills),
      certifications: JSON.parse(row.certifications),
      achievements: JSON.parse(row.achievements),
      preferences: JSON.parse(row.preferences),
      authorization: JSON.parse(row.authorization),
      compensation: JSON.parse(row.compensation),
      questionAnswers: JSON.parse(row.question_answers),
      version: row.version,
      updatedAt: new Date(row.updated_at),
    } as MasterProfile;
  }
}
/**
 * Phase 6W/6X — SubmissionJournalRepository.
 *
 * Append-only, written BEFORE the irreversible Submit click. The duplicate
 * guard reads it so a crashed run can never silently allow a second submit.
 * Secret-free by construction: method/host/path/status/resourceType/timing only.
 */
export interface SubmissionJournalRow {
  entryId: string;
  applicationId: string;
  jobId: string;
  candidateId?: string;
  companyId?: string;
  applicationRoute?: string;
  atsType?: string;
  phase: string;
  method?: string;
  host?: string;
  path?: string;
  status?: number | null;
  resourceType?: string;
  elapsedMs?: number;
  sessionId?: string;
  detail?: string;
  createdAt?: string;
}

export class SubmissionJournalRepository {
  constructor(private db: DatabaseClient) {}

  async append(entry: SubmissionJournalRow & { entryId: string }): Promise<void> {
    await this.db.query(
      `INSERT OR REPLACE INTO submission_journal (
        entry_id, application_id, job_id, candidate_id, company_id,
        application_route, ats_type, phase, method, host, path, status,
        resource_type, elapsed_ms, session_id, detail, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.entryId,
        entry.applicationId,
        entry.jobId,
        entry.candidateId ?? null,
        entry.companyId ?? null,
        entry.applicationRoute ?? null,
        entry.atsType ?? null,
        entry.phase,
        entry.method ?? null,
        entry.host ?? null,
        entry.path ?? null,
        entry.status ?? null,
        entry.resourceType ?? null,
        entry.elapsedMs ?? null,
        entry.sessionId ?? null,
        entry.detail ?? null,
        new Date().toISOString(),
      ]
    );
  }

  async findByApplication(applicationId: string): Promise<SubmissionJournalRow[]> {
    const result = await this.db.query(
      `SELECT * FROM submission_journal WHERE application_id = ? ORDER BY created_at ASC, rowid ASC`,
      [applicationId]
    );
    return result.rows.map(rowToSubmissionJournalRow);
  }

  async findByJob(jobId: string): Promise<SubmissionJournalRow[]> {
    const result = await this.db.query(
      `SELECT * FROM submission_journal WHERE job_id = ? ORDER BY created_at ASC, rowid ASC`,
      [jobId]
    );
    return result.rows.map(rowToSubmissionJournalRow);
  }

  /**
   * True when a submit click may already have reached the ATS for this job
   * (any click-bearing phase, excluding an explicit `failed`).
   */
  async hasClickBearingAttempt(jobId: string, clickBearingPhases: readonly string[]): Promise<SubmissionJournalRow | null> {
    const result = await this.db.query(
      `SELECT * FROM submission_journal
       WHERE job_id = ? AND phase IN (${clickBearingPhases.map(() => '?').join(',')})
       ORDER BY created_at DESC LIMIT 1`,
      [jobId, ...clickBearingPhases]
    );
    return result.rows.length > 0 ? rowToSubmissionJournalRow(result.rows[0]) : null;
  }
}

function rowToSubmissionJournalRow(row: any): SubmissionJournalRow {
  return {
    entryId: row.entry_id,
    applicationId: row.application_id,
    jobId: row.job_id,
    candidateId: row.candidate_id ?? undefined,
    companyId: row.company_id ?? undefined,
    applicationRoute: row.application_route ?? undefined,
    atsType: row.ats_type ?? undefined,
    phase: row.phase,
    method: row.method ?? undefined,
    host: row.host ?? undefined,
    path: row.path ?? undefined,
    status: row.status ?? null,
    resourceType: row.resource_type ?? undefined,
    elapsedMs: row.elapsed_ms ?? undefined,
    sessionId: row.session_id ?? undefined,
    detail: row.detail ?? undefined,
    createdAt: row.created_at ?? undefined,
  };
}
