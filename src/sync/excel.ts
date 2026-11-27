/**
 * Excel Synchronization - syncs application data to ~/Desktop/job-applications.xlsx
 */

import ExcelJS from 'exceljs';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../core/config.ts';
import { logger } from '../core/logger.ts';
import type { ApplicationRepository } from '../database/repositories.ts';
import type { JobRepository } from '../database/repositories.ts';
import type { MatchRepository } from '../database/repositories.ts';
import type { ResumeRepository } from '../database/repositories.ts';
import type { CoverLetterRepository } from '../database/repositories.ts';
import type { DiscoveredJob, MatchAnalysis, ResumeVersion, CoverLetter, Application } from '../core/types.ts';

export interface ExcelSyncOptions {
  outputPath?: string;
  startDate?: Date;
  endDate?: Date;
  includeArchived?: boolean;
  sheetName?: string;
}

export interface ExcelSyncResult {
  filePath: string;
  applicationsSynced: number;
  sheets: string[];
}

function safeISO(d: any): string {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  return isNaN(dt.getTime()) ? '' : dt.toISOString();
}

export class ExcelSync {
  private outputPath: string;

  constructor(outputPath?: string) {
    this.outputPath = outputPath || config.desktop.excelPath;
  }

  async sync(
    appRepo: ApplicationRepository,
    jobRepo: JobRepository,
    matchRepo: MatchRepository,
    resumeRepo: ResumeRepository,
    coverRepo: CoverLetterRepository,
    options: ExcelSyncOptions = {}
  ): Promise<ExcelSyncResult> {
    const outputPath = options.outputPath || this.outputPath;
    const dir = path.dirname(outputPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    logger.info('Starting Excel sync', { outputPath });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Job Agent';
    workbook.created = new Date();

    // Get applications
    const applications = await this.getApplications(appRepo, options);
    logger.info('Fetched applications for sync', { count: applications.length });

    // Main Applications sheet
    const appsSheet = workbook.addWorksheet(options.sheetName || 'Applications');
    await this.writeApplicationsSheet(appsSheet, applications, jobRepo, matchRepo, resumeRepo, coverRepo);

    // Jobs sheet
    const jobsSheet = workbook.addWorksheet('Jobs');
    await this.writeJobsSheet(jobsSheet, jobRepo, options);

    // Matches sheet
    const matchesSheet = workbook.addWorksheet('Matches');
    await this.writeMatchesSheet(matchesSheet, matchRepo, options);

    // Resumes sheet
    const resumesSheet = workbook.addWorksheet('Resumes');
    await this.writeResumesSheet(resumesSheet, resumeRepo, options);

    // Cover Letters sheet
    const coversSheet = workbook.addWorksheet('Cover Letters');
    await this.writeCoverLettersSheet(coversSheet, coverRepo, options);

    // Summary sheet
    const summarySheet = workbook.addWorksheet('Summary');
    await this.writeSummarySheet(summarySheet, applications, jobRepo, matchRepo);

    // Save workbook
    await workbook.xlsx.writeFile(outputPath);

    const sheets = workbook.worksheets.map(w => w.name);
    logger.info('Excel sync completed', { outputPath, applicationsSynced: applications.length, sheets });

    return {
      filePath: outputPath,
      applicationsSynced: applications.length,
      sheets,
    };
  }

  private async getApplications(
    appRepo: ApplicationRepository,
    options: ExcelSyncOptions
  ): Promise<Application[]> {
    if (options.startDate || options.endDate) {
      // For date filtering, get all and filter
      const allApps = await appRepo.getAllApplications(10000);
      return allApps.filter(app => {
        if (options.startDate && app.createdAt < options.startDate!) return false;
        if (options.endDate && app.createdAt > options.endDate!) return false;
        return true;
      });
    }
    // Workbook tracks ALL applications (pending AND submitted/confirmed/failed)
    return appRepo.getAllApplications(10000);
  }

  private async writeApplicationsSheet(
    sheet: ExcelJS.Worksheet,
    applications: Application[],
    jobRepo: JobRepository,
    matchRepo: MatchRepository,
    resumeRepo: ResumeRepository,
    coverRepo: CoverLetterRepository
  ): Promise<void> {
    // Define columns
    // Phase 6S: Source / Canonical Source / ATS / Source Job ID / Internal Job ID
    // / Discovery URL / Application URL / Application Route / Status /
    // Confirmation ID — DB remains the source of truth, this sheet is a mirror.
    sheet.columns = [
      { header: 'Application ID', key: 'applicationId', width: 22 },
      { header: 'Internal Job ID', key: 'jobId', width: 22 },
      { header: 'Source Job ID', key: 'sourceJobId', width: 18 },
      { header: 'Source', key: 'source', width: 15 },
      { header: 'Canonical Source', key: 'canonicalSource', width: 20 },
      { header: 'ATS', key: 'atsType', width: 15 },
      { header: 'Company', key: 'company', width: 30 },
      { header: 'Job Title', key: 'title', width: 40 },
      { header: 'Location', key: 'location', width: 25 },
      { header: 'Remote', key: 'remote', width: 10 },
      { header: 'Discovery URL', key: 'discoveryUrl', width: 50 },
      { header: 'Application URL', key: 'applicationUrl', width: 50 },
      { header: 'Application Route', key: 'applicationRoute', width: 20 },
      { header: 'Application State', key: 'state', width: 22 },
      { header: 'Status', key: 'status', width: 15 },
      { header: 'Match Score', key: 'matchScore', width: 12 },
      { header: 'Recommendation', key: 'recommendation', width: 15 },
      { header: 'Applied At', key: 'appliedAt', width: 22 },
      { header: 'Submitted At', key: 'submittedAt', width: 22 },
      { header: 'Confirmed At', key: 'confirmedAt', width: 22 },
      { header: 'Error', key: 'error', width: 50 },
      { header: 'Created At', key: 'createdAt', width: 22 },
      { header: 'Updated At', key: 'updatedAt', width: 22 },
      { header: 'Resume ID', key: 'resumeId', width: 25 },
      { header: 'Cover Letter ID', key: 'coverLetterId', width: 25 },
      { header: 'Confirmation ID', key: 'confirmationId', width: 25 },
      { header: 'Next Action', key: 'nextAction', width: 40 },
      { header: 'Next Action At', key: 'nextActionAt', width: 22 },
    ];

    // Style header row
    sheet.getRow(1).font = { bold: true, size: 11 };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF2563EB' },
    };
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    for (const app of applications) {
      const job = await jobRepo.getJob(app.jobId);
      const match = await matchRepo.getByJobId(app.jobId, app.candidateId);
      const resumes = await resumeRepo.getByJobId(app.jobId, app.candidateId);
      const covers = await coverRepo.getByJobId(app.jobId, app.candidateId);

      sheet.addRow({
        applicationId: app.applicationId,
        jobId: app.jobId,
        sourceJobId: app.sourceJobId || job?.sourceJobId || '',
        source: job?.discoveredFrom || job?.source || '',
        canonicalSource: app.canonicalSource || job?.canonicalSource || '',
        atsType: app.atsType || job?.atsType || '',
        company: job?.company || 'Unknown',
        title: job?.title || 'Unknown',
        location: job?.location || '',
        remote: job?.remote ? 'Yes' : 'No',
        discoveryUrl: job?.url || '',
        applicationUrl: app.applicationUrl || job?.applicationUrl || '',
        applicationRoute: app.applicationRoute || job?.applicationRoute || '',
        state: app.state,
        status: app.status,
        matchScore: match?.overallScore || 0,
        recommendation: match?.recommendation || '',
        appliedAt: safeISO(app.submittedAt),
        submittedAt: safeISO(app.submittedAt),
        confirmedAt: safeISO(app.confirmedAt),
        error: app.error || '',
        createdAt: safeISO(app.createdAt),
        updatedAt: safeISO(app.updatedAt),
        resumeId: resumes[0]?.resumeId || '',
        coverLetterId: covers[0]?.coverLetterId || '',
        confirmationId: app.confirmationId || '',
        nextAction: app.nextAction || '',
        nextActionAt: safeISO(app.nextActionAt),
      });
    }

    // Auto-filter
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: applications.length + 1, column: sheet.columns.length },
    };
  }

  private async writeJobsSheet(
    sheet: ExcelJS.Worksheet,
    jobRepo: JobRepository,
    options: ExcelSyncOptions
  ): Promise<void> {
    sheet.columns = [
      { header: 'Job ID', key: 'jobId', width: 22 },
      { header: 'Source Job ID', key: 'sourceJobId', width: 18 },
      { header: 'Company', key: 'company', width: 30 },
      { header: 'Title', key: 'title', width: 40 },
      { header: 'Location', key: 'location', width: 25 },
      { header: 'Remote', key: 'remote', width: 10 },
      { header: 'Remote Policy', key: 'remotePolicy', width: 18 },
      { header: 'Seniority', key: 'seniority', width: 15 },
      { header: 'Employment Type', key: 'employmentType', width: 18 },
      { header: 'Source', key: 'source', width: 15 },
      { header: 'Canonical Source', key: 'canonicalSource', width: 20 },
      { header: 'ATS', key: 'atsType', width: 15 },
      { header: 'Application Route', key: 'applicationRoute', width: 20 },
      { header: 'JD Complete', key: 'jdComplete', width: 12 },
      { header: 'Discovery URL', key: 'url', width: 50 },
      { header: 'Application URL', key: 'applicationUrl', width: 50 },
      { header: 'Salary', key: 'salary', width: 20 },
      { header: 'Verified', key: 'verified', width: 10 },
      { header: 'Verified Confidence', key: 'verifiedConfidence', width: 18 },
      { header: 'Posted At', key: 'postedAt', width: 22 },
      { header: 'Discovered At', key: 'discoveredAt', width: 22 },
    ];

    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF059669' } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    // 6S: DB is the source of truth — mirror every job row here.
    let jobs: DiscoveredJob[] = [];
    try {
      jobs = await jobRepo.getAllJobs(10000);
    } catch (error) {
      logger.warn('Jobs sheet: failed to load jobs', { error: String(error) });
    }
    if (!jobs.length) {
      sheet.addRow({
        jobId: 'N/A', sourceJobId: '', company: 'No jobs yet — run discovery first',
        title: '', location: '', remote: '', remotePolicy: '', seniority: '',
        employmentType: '', source: '', canonicalSource: '', atsType: '',
        applicationRoute: '', jdComplete: '', url: '', applicationUrl: '', salary: '',
        verified: '', verifiedConfidence: '', postedAt: '', discoveredAt: '',
      });
      return;
    }
    for (const job of jobs) {
      sheet.addRow({
        jobId: job.jobId,
        sourceJobId: job.sourceJobId || '',
        company: job.company || '',
        title: job.title || '',
        location: job.location || '',
        remote: job.remote ? 'Yes' : 'No',
        remotePolicy: job.remotePolicy || '',
        seniority: job.seniority || '',
        employmentType: job.employmentType || '',
        source: job.discoveredFrom || job.source || '',
        canonicalSource: job.canonicalSource || '',
        atsType: job.atsType || '',
        applicationRoute: job.applicationRoute || '',
        jdComplete: job.jdComplete ? 'Yes' : 'No',
        url: job.url || '',
        applicationUrl: job.applicationUrl || '',
        salary: job.salary || '',
        verified: '',
        verifiedConfidence: '',
        postedAt: safeISO(job?.postedAt),
        discoveredAt: '',
      });
    }
  }

  private async writeMatchesSheet(
    sheet: ExcelJS.Worksheet,
    matchRepo: MatchRepository,
    options: ExcelSyncOptions
  ): Promise<void> {
    sheet.columns = [
      { header: 'Match ID', key: 'matchId', width: 22 },
      { header: 'Job ID', key: 'jobId', width: 22 },
      { header: 'Candidate ID', key: 'candidateId', width: 18 },
      { header: 'Overall Score', key: 'overallScore', width: 14 },
      { header: 'Required Skill Coverage', key: 'requiredSkillCoverage', width: 22 },
      { header: 'Preferred Skill Coverage', key: 'preferredSkillCoverage', width: 22 },
      { header: 'Experience Match', key: 'experienceMatch', width: 18 },
      { header: 'Project Relevance', key: 'projectRelevance', width: 18 },
      { header: 'Cloud Platform Match', key: 'cloudPlatformMatch', width: 20 },
      { header: 'Education Match', key: 'educationMatch', width: 16 },
      { header: 'Location Match', key: 'locationMatch', width: 16 },
      { header: 'Authorization Compatibility', key: 'authorizationCompatibility', width: 25 },
      { header: 'Keyword Coverage', key: 'keywordCoverage', width: 18 },
      { header: 'Missing Required', key: 'missingRequired', width: 40 },
      { header: 'Missing Preferred', key: 'missingPreferred', width: 40 },
      { header: 'Recommendation', key: 'recommendation', width: 15 },
      { header: 'Confidence', key: 'confidence', width: 12 },
      { header: 'Analyzed At', key: 'analyzedAt', width: 22 },
    ];

    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7C3AED' } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    sheet.addRow({
      matchId: 'N/A',
      jobId: 'Use job-agent CLI to populate',
      candidateId: '',
      overallScore: '',
      requiredSkillCoverage: '',
      preferredSkillCoverage: '',
      experienceMatch: '',
      projectRelevance: '',
      cloudPlatformMatch: '',
      educationMatch: '',
      locationMatch: '',
      authorizationCompatibility: '',
      keywordCoverage: '',
      missingRequired: '',
      missingPreferred: '',
      recommendation: '',
      confidence: '',
      analyzedAt: '',
    });
  }

  private async writeResumesSheet(
    sheet: ExcelJS.Worksheet,
    resumeRepo: ResumeRepository,
    options: ExcelSyncOptions
  ): Promise<void> {
    sheet.columns = [
      { header: 'Resume ID', key: 'resumeId', width: 22 },
      { header: 'Job ID', key: 'jobId', width: 22 },
      { header: 'Candidate ID', key: 'candidateId', width: 18 },
      { header: 'Version', key: 'version', width: 10 },
      { header: 'Format', key: 'format', width: 12 },
      { header: 'File Path', key: 'filePath', width: 50 },
      { header: 'ATS Score', key: 'atsScore', width: 12 },
      { header: 'Generated At', key: 'generatedAt', width: 22 },
      { header: 'Generator Version', key: 'generatorVersion', width: 18 },
    ];

    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDC2626' } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    sheet.addRow({
      resumeId: 'N/A',
      jobId: 'Use job-agent CLI to populate',
      candidateId: '',
      version: '',
      format: '',
      filePath: '',
      atsScore: '',
      generatedAt: '',
      generatorVersion: '',
    });
  }

  private async writeCoverLettersSheet(
    sheet: ExcelJS.Worksheet,
    coverRepo: CoverLetterRepository,
    options: ExcelSyncOptions
  ): Promise<void> {
    sheet.columns = [
      { header: 'Cover Letter ID', key: 'coverLetterId', width: 22 },
      { header: 'Job ID', key: 'jobId', width: 22 },
      { header: 'Candidate ID', key: 'candidateId', width: 18 },
      { header: 'Template ID', key: 'templateId', width: 18 },
      { header: 'File Path', key: 'filePath', width: 50 },
      { header: 'Generated At', key: 'generatedAt', width: 22 },
    ];

    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEA580C' } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    sheet.addRow({
      coverLetterId: 'N/A',
      jobId: 'Use job-agent CLI to populate',
      candidateId: '',
      templateId: '',
      filePath: '',
      generatedAt: '',
    });
  }

  private async writeSummarySheet(
    sheet: ExcelJS.Worksheet,
    applications: Application[],
    jobRepo: JobRepository,
    matchRepo: MatchRepository
  ): Promise<void> {
    sheet.columns = [
      { header: 'Metric', key: 'metric', width: 35 },
      { header: 'Value', key: 'value', width: 20 },
    ];

    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    // Count by state
    const stateCounts: Record<string, number> = {};
    for (const app of applications) {
      stateCounts[app.state] = (stateCounts[app.state] || 0) + 1;
    }

    // Count by status
    const statusCounts: Record<string, number> = {};
    for (const app of applications) {
      statusCounts[app.status] = (statusCounts[app.status] || 0) + 1;
    }

    const summaryData = [
      { metric: 'Total Applications', value: applications.length },
      { metric: 'Sync Date', value: new Date().toISOString() },
      { metric: '', value: '' },
      { metric: '=== By State ===', value: '' },
      ...Object.entries(stateCounts).map(([state, count]) => ({ metric: `  ${state}`, value: count })),
      { metric: '', value: '' },
      { metric: '=== By Status ===', value: '' },
      ...Object.entries(statusCounts).map(([status, count]) => ({ metric: `  ${status}`, value: count })),
    ];

    for (const row of summaryData) {
      sheet.addRow(row);
    }
  }
}

export const excelSync = new ExcelSync();