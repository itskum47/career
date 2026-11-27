/**
 * CV Artifact Generator - generates and saves CV/cover letter files to ~/Desktop/cv/
 * with database path tracking.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { fileStorage } from '../shared/storage.ts';
import { config } from '../core/config.ts';
import { logger } from '../core/logger.ts';
import { startTimer } from '../performance/index.ts';
import { STAGES } from '../performance/stages.ts';
import { artifactCache } from '../cache/artifact-cache.ts';
import { cacheObserver } from '../cache/cache-observability.ts';
import type { ResumeVersion, CoverLetter, MasterProfile, ResumeSection, ResumeSectionType } from '../core/types.ts';
import type { JobDescription } from '../jd/types.ts';
import type { MatchAnalysis } from '../match/types.ts';
import PDFDocument from 'pdfkit';
import type { JobDescription as JDJobDescription } from '../jd/types.ts';

/**
 * Phase 4C: keys must cover all relevant input state but exclude fields that
 * are regenerated on every run (timestamps/ids) — otherwise the key would
 * differ on every call and the cache could never hit. Semantic content is
 * preserved: generated `content` strings ARE part of the key, so a
 * date-stamped resume/cover letter invalidates naturally when its content
 * changes (e.g., across days).
 */
const VOLATILE_KEY_PARTS = [
  'extractedat', 'postedat', 'analyzedat', 'generatedat', 'validatedat',
  'capturedat', 'fetchedat', 'matchid', 'resumeid', 'coverletterid',
  'createdat', 'updatedat', 'timestamp', 'applicationid', 'sessionid',
  // The JD extractor emits a NEW random jobId per extraction when it cannot
  // derive one from the URL (measured: "JOB-extracted:unknown:job-<rand>").
  // Artifact PDFs never render jobId, and jobs remain fully distinguished in
  // the key by url/title/company/fullText/skills — so it must not participate.
  'jobid',
];

function stableArtifactHash(value: unknown): string {
  const normalize = (v: any): any => {
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(normalize);
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) {
      if (VOLATILE_KEY_PARTS.includes(k.toLowerCase())) continue;
      out[k] = normalize(val);
    }
    return out;
  };
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

export interface CVArtifactResult {
  resumePath?: string;
  coverLetterPath?: string;
  resumeFormat: 'pdf' | 'docx' | 'html' | 'json';
  coverLetterFormat: 'pdf' | 'docx' | 'html' | 'json';
}

export class CVArtifactGenerator {
  private outputDir: string;

  constructor() {
    this.outputDir = config.desktop.cvOutputDir;
    this.ensureDirectory();
  }

  private ensureDirectory(): void {
    try {
      if (!fs.existsSync(this.outputDir)) {
        fs.mkdirSync(this.outputDir, { recursive: true });
        logger.info('Created CV output directory', { path: this.outputDir });
      }
    } catch (error) {
      // Non-fatal: the CV output dir may be unavailable (e.g. sandbox). CV
      // saving will fail later with a clear error. On a normal Mac Terminal
      // this path works fine.
      logger.warn('Could not create CV output directory', { path: this.outputDir, error: String(error) });
    }
  }

  async generateAndSaveResume(
    resume: ResumeVersion,
    profile: MasterProfile,
    jobDescription: JDJobDescription,
    matchAnalysis: MatchAnalysis,
    sections: ResumeSection[],
    format: 'pdf' | 'docx' | 'html' | 'json' = 'pdf'
  ): Promise<string> {
    // Phase 4C: measure artifact cost before deciding on cache wiring
    const timer = startTimer({ stage: STAGES.ARTIFACT_PDF_RESUME });

    // Phase 4C: artifact cache wiring — semantically safe because the artifact
    // is a pure function of (profile, JD, match, resume content, sections,
    // template/version, format); a hit additionally requires byte-level
    // integrity of the cached file. DB remains the source of truth; the flag
    // keeps the legacy behavior when disabled.
    let cacheKey = '';
    const useCache = config.cache.artifactEnabled;
    if (useCache) {
      try {
        cacheKey = artifactCache.generateKey(
          stableArtifactHash({ profile }),
          stableArtifactHash({ jd: jobDescription, match: matchAnalysis, resumeMeta: { version: resume.version, generatorVersion: resume.generatorVersion }, sections }),
          `${resume.generatorVersion || '1.0.0'}:${format}`,
          '1.0.0'
        );
        const entry = await artifactCache.get(cacheKey);
        if (entry && entry.artifactType === 'resume' && entry.contentHash && fs.existsSync(entry.filePath)) {
          const bytes = await fs.promises.readFile(entry.filePath);
          const currentHash = createHash('sha256').update(bytes).digest('hex');
          if (currentHash === entry.contentHash) {
            cacheObserver.record('artifact', 'hit');
            timer.end(true);
            logger.info('Resume artifact cache hit', { path: entry.filePath, key: cacheKey });
            return entry.filePath;
          }
        }
        cacheObserver.record('artifact', 'miss');
      } catch (e) {
        logger.warn('Artifact cache lookup failed, regenerating', { error: String(e) });
      }
    }

    const fileName = fileStorage.generateCVFileName(jobDescription.company, jobDescription.title, format as 'pdf' | 'docx');
    const filePath = path.join(this.outputDir, fileName);

    let content: Buffer | string;

    switch (format) {
      case 'pdf':
        content = await this.generateResumePDF(resume, profile, jobDescription, matchAnalysis, sections);
        break;
      case 'html':
        content = this.generateResumeHTML(resume, profile, jobDescription, matchAnalysis, sections);
        break;
      case 'json':
        content = this.generateResumeJSON(resume, profile, jobDescription, matchAnalysis, sections);
        break;
      case 'docx':
      default:
        // For docx, fall back to HTML which can be converted
        content = this.generateResumeHTML(resume, profile, jobDescription, matchAnalysis, sections);
        break;
    }

    await fs.promises.writeFile(filePath, content);
    logger.info('Resume artifact saved', { path: filePath, format, resumeId: resume.resumeId });
    if (useCache && cacheKey) {
      try {
        const contentHash = createHash('sha256').update(content).digest('hex');
        await artifactCache.set(cacheKey, filePath, 'resume', contentHash);
        cacheObserver.record('artifact', 'write');
      } catch (e) {
        logger.warn('Artifact cache write failed', { error: String(e) });
      }
    }
    timer.end(true);

    return filePath;
  }

  async generateAndSaveCoverLetter(
    coverLetter: CoverLetter,
    profile: MasterProfile,
    jobDescription: JDJobDescription,
    format: 'pdf' | 'docx' | 'html' | 'json' = 'pdf'
  ): Promise<string> {
    const timer = startTimer({ stage: STAGES.ARTIFACT_PDF_COVER });

    // Phase 4C: same safe-wiring contract as the resume artifact above.
    let cacheKey = '';
    const useCache = config.cache.artifactEnabled;
    if (useCache) {
      try {
        cacheKey = artifactCache.generateKey(
          stableArtifactHash({ profile }),
          stableArtifactHash({ jd: jobDescription, coverContent: coverLetter.content }),
          `${coverLetter.templateId || 'standard'}:${format}`,
          '1.0.0'
        );
        const entry = await artifactCache.get(cacheKey);
        if (entry && entry.artifactType === 'cover' && entry.contentHash && fs.existsSync(entry.filePath)) {
          const bytes = await fs.promises.readFile(entry.filePath);
          const currentHash = createHash('sha256').update(bytes).digest('hex');
          if (currentHash === entry.contentHash) {
            cacheObserver.record('artifact', 'hit');
            timer.end(true);
            logger.info('Cover letter artifact cache hit', { path: entry.filePath, key: cacheKey });
            return entry.filePath;
          }
        }
        cacheObserver.record('artifact', 'miss');
      } catch (e) {
        logger.warn('Artifact cache lookup failed, regenerating', { error: String(e) });
      }
    }

    const fileName = fileStorage.generateCoverLetterFileName(jobDescription.company, jobDescription.title, format as 'pdf' | 'docx');
    const filePath = path.join(this.outputDir, fileName);

    let content: Buffer | string;

    switch (format) {
      case 'pdf':
        content = await this.generateCoverLetterPDF(coverLetter, profile, jobDescription);
        break;
      case 'html':
        content = this.generateCoverLetterHTML(coverLetter, profile, jobDescription);
        break;
      case 'json':
        content = this.generateCoverLetterJSON(coverLetter, profile, jobDescription);
        break;
      case 'docx':
      default:
        content = this.generateCoverLetterHTML(coverLetter, profile, jobDescription);
        break;
    }

    await fs.promises.writeFile(filePath, content);
    logger.info('Cover letter artifact saved', { path: filePath, format, coverLetterId: coverLetter.coverLetterId });
    if (useCache && cacheKey) {
      try {
        const contentHash = createHash('sha256').update(content).digest('hex');
        await artifactCache.set(cacheKey, filePath, 'cover', contentHash);
        cacheObserver.record('artifact', 'write');
      } catch (e) {
        logger.warn('Artifact cache write failed', { error: String(e) });
      }
    }
    timer.end(true);

    return filePath;
  }

  private async generateResumePDF(
    resume: ResumeVersion,
    profile: MasterProfile,
    jobDescription: JobDescription,
    matchAnalysis: MatchAnalysis,
    sections: ResumeSection[]
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Header
      doc.fontSize(24).font('Helvetica-Bold').text(profile.personal.fullName, { align: 'center' });
      doc.moveDown(0.5);

      const contactInfo = [
        profile.personal.email,
        profile.personal.phone,
        profile.personal.location,
        profile.personal.linkedin ? `LinkedIn: ${profile.personal.linkedin}` : '',
        profile.personal.github ? `GitHub: ${profile.personal.github}` : '',
        profile.personal.portfolio ? `Portfolio: ${profile.personal.portfolio}` : '',
      ].filter(Boolean).join('  |  ');

      doc.fontSize(10).font('Helvetica').text(contactInfo, { align: 'center' });
      doc.moveDown(1);

      // Line separator
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(1);

      // Sections
      const sortedSections = sections.sort((a, b) => a.order - b.order);
      for (const section of sortedSections) {
        if (section.content.trim() === 'None') continue;

        doc.fontSize(14).font('Helvetica-Bold').text(section.title);
        doc.moveDown(0.3);

        doc.fontSize(10).font('Helvetica').text(section.content, { align: 'left' });
        doc.moveDown(1);
      }

      // Footer with metadata
      doc.moveDown(2);
      doc.fontSize(8).font('Helvetica-Oblique').text(
        `Generated for ${jobDescription.title} at ${jobDescription.company} | Match: ${matchAnalysis.overallScore}% | ${new Date().toLocaleDateString()}`,
        { align: 'center' }
      );

      doc.end();
    });
  }

  private generateResumeHTML(
    resume: ResumeVersion,
    profile: MasterProfile,
    jobDescription: JobDescription,
    matchAnalysis: MatchAnalysis,
    sections: ResumeSection[]
  ): string {
    const sortedSections = sections.sort((a, b) => a.order - b.order);

    const contactInfo = [
      profile.personal.email,
      profile.personal.phone,
      profile.personal.location,
      profile.personal.linkedin ? `<a href="${profile.personal.linkedin}">LinkedIn</a>` : '',
      profile.personal.github ? `<a href="${profile.personal.github}">GitHub</a>` : '',
      profile.personal.portfolio ? `<a href="${profile.personal.portfolio}">Portfolio</a>` : '',
    ].filter(Boolean).join(' | ');

    let html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${profile.personal.fullName} - ${jobDescription.title} at ${jobDescription.company}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 40px 20px; line-height: 1.6; color: #333; }
    h1 { font-size: 28px; margin-bottom: 8px; color: #1a1a1a; text-align: center; }
    .contact { text-align: center; color: #666; margin-bottom: 30px; font-size: 14px; }
    .contact a { color: #2563eb; text-decoration: none; }
    .section { margin-bottom: 30px; }
    .section-title { font-size: 16px; font-weight: 600; color: #1a1a1a; border-bottom: 2px solid #2563eb; padding-bottom: 4px; margin-bottom: 12px; }
    .section-content { white-space: pre-wrap; }
    .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e5e5e5; text-align: center; color: #999; font-size: 12px; }
  </style>
</head>
<body>
  <h1>${profile.personal.fullName}</h1>
  <div class="contact">${contactInfo}</div>
`;

    for (const section of sortedSections) {
      if (section.content.trim() === 'None') continue;

      html += `
  <div class="section">
    <div class="section-title">${section.title}</div>
    <div class="section-content">${this.escapeHtml(section.content)}</div>
  </div>
`;
    }

    html += `
  <div class="footer">
    Generated for ${jobDescription.title} at ${jobDescription.company} | Match: ${matchAnalysis.overallScore}% | ${new Date().toLocaleDateString()}
  </div>
</body>
</html>`;

    return html;
  }

  private generateResumeJSON(
    resume: ResumeVersion,
    profile: MasterProfile,
    jobDescription: JobDescription,
    matchAnalysis: MatchAnalysis,
    sections: ResumeSection[]
  ): string {
    const data = {
      resumeId: resume.resumeId,
      jobId: resume.jobId,
      candidateId: resume.candidateId,
      version: resume.version,
      format: resume.format,
      generatedAt: resume.generatedAt,
      profile: {
        name: profile.personal.fullName,
        email: profile.personal.email,
        phone: profile.personal.phone,
        location: profile.personal.location,
        linkedin: profile.personal.linkedin,
        github: profile.personal.github,
        portfolio: profile.personal.portfolio,
        summary: profile.personal.summary,
      },
      jobDescription: {
        company: jobDescription.company,
        title: jobDescription.title,
        location: jobDescription.location,
        url: jobDescription.sourceUrl,
      },
      matchAnalysis: {
        overallScore: matchAnalysis.overallScore,
        recommendation: matchAnalysis.recommendation,
        missingRequired: matchAnalysis.missingRequired,
      },
      sections: sections.map(s => ({
        type: s.type,
        title: s.title,
        content: s.content,
        order: s.order,
        emphasis: s.emphasis,
      })),
    };

    return JSON.stringify(data, null, 2);
  }

  private async generateCoverLetterPDF(
    coverLetter: CoverLetter,
    profile: MasterProfile,
    jobDescription: JobDescription
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Date and employer info
      doc.fontSize(10).font('Helvetica').text(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }));
      doc.moveDown(1);

      doc.text(`${jobDescription.company}`);
      doc.text(jobDescription.location);
      doc.moveDown(1);

      // Salutation
      doc.text('Dear Hiring Manager,');
      doc.moveDown(1);

      // Content
      doc.fontSize(11).text(coverLetter.content, { align: 'left', paragraphGap: 10 });
      doc.moveDown(2);

      // Closing
      doc.text('Sincerely,');
      doc.moveDown(1);
      doc.text(profile.personal.fullName);
      doc.moveDown(1);

      // Contact info
      doc.fontSize(10).text(profile.personal.email);
      doc.text(profile.personal.phone);
      if (profile.personal.linkedin) doc.text(`LinkedIn: ${profile.personal.linkedin}`);

      doc.end();
    });
  }

  private generateCoverLetterHTML(
    coverLetter: CoverLetter,
    profile: MasterProfile,
    jobDescription: JobDescription
  ): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cover Letter - ${profile.personal.fullName} for ${jobDescription.title} at ${jobDescription.company}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 40px 20px; line-height: 1.7; color: #333; }
    .header { margin-bottom: 30px; }
    .date { margin-bottom: 20px; }
    .company { margin-bottom: 30px; }
    .content { white-space: pre-wrap; margin-bottom: 30px; }
    .closing { margin-top: 40px; }
    .signature { margin-top: 20px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="date">${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
    <div class="company">
      <strong>${jobDescription.company}</strong><br>
      ${jobDescription.location}
    </div>
  </div>
  <p>Dear Hiring Manager,</p>
  <div class="content">${this.escapeHtml(coverLetter.content)}</div>
  <div class="closing">
    <p>Sincerely,</p>
    <div class="signature">
      <strong>${profile.personal.fullName}</strong><br>
      ${profile.personal.email}<br>
      ${profile.personal.phone}<br>
      ${profile.personal.linkedin ? `LinkedIn: <a href="${profile.personal.linkedin}">${profile.personal.linkedin}</a>` : ''}
    </div>
  </div>
</body>
</html>`;
  }

  private generateCoverLetterJSON(
    coverLetter: CoverLetter,
    profile: MasterProfile,
    jobDescription: JobDescription
  ): string {
    const data = {
      coverLetterId: coverLetter.coverLetterId,
      jobId: coverLetter.jobId,
      candidateId: coverLetter.candidateId,
      templateId: coverLetter.templateId,
      generatedAt: coverLetter.generatedAt,
      profile: {
        name: profile.personal.fullName,
        email: profile.personal.email,
        phone: profile.personal.phone,
        linkedin: profile.personal.linkedin,
      },
      jobDescription: {
        company: jobDescription.company,
        title: jobDescription.title,
        location: jobDescription.location,
        url: jobDescription.sourceUrl,
      },
      content: coverLetter.content,
    };

    return JSON.stringify(data, null, 2);
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&')
      .replace(/</g, '<')
      .replace(/>/g, '>')
      .replace(/"/g, '"')
      .replace(/'/g, '&#039;');
  }
}

export const cvArtifactGenerator = new CVArtifactGenerator();