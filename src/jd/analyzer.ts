/**
 * JD Analyzer - orchestrates extraction, verification, and analysis.
 */

import type { JobDescription, JDExtractionInput, JDAnalysisResult } from './types.ts';
import type { DiscoveredJob } from '../discovery/types.ts';
import { JDExtractor } from './extractor.ts';
import { JDVerifier } from './verifier.ts';
import { JobDeduplicator } from './deduplication.ts';
import { logger } from '../core/logger.ts';

export class JDAnalyzer {
  private extractor = new JDExtractor();
  private verifier = new JDVerifier();
  private deduplicator = new JobDeduplicator();

  async processJob(discoveredJob: DiscoveredJob, html: string): Promise<JobDescription | null> {
    logger.info('Processing job for JD extraction', { jobId: discoveredJob.jobId });

    // Extract JD from HTML
    const input: JDExtractionInput = {
      html,
      url: discoveredJob.url,
    };

    const extractionResult = this.extractor.extract(input);
    let jd = extractionResult.jobDescription;
    jd.confidence = extractionResult.confidence;

    // Verify JD quality
    const verification = this.verifier.verify(jd);
    
    if (!verification.verified) {
      logger.warn('JD verification failed', { 
        jobId: discoveredJob.jobId, 
        issues: verification.issues 
      });
      return null;
    }

    logger.info('JD processed successfully', { 
      jobId: discoveredJob.jobId, 
      confidence: jd.confidence 
    });

    return jd;
  }

  async processJobs(jobs: DiscoveredJob[], htmlMap: Map<string, string>): Promise<JobDescription[]> {
    // First deduplicate
    const { unique } = this.deduplicator.deduplicate(jobs);
    
    const results: JobDescription[] = [];
    
    for (const job of unique) {
      const html = htmlMap.get(job.url);
      if (!html) {
        logger.warn('No HTML for job URL', { url: job.url });
        continue;
      }

      const jd = await this.processJob(job, html);
      if (jd) {
        results.push(jd);
      }
    }

    return results;
  }

  analyzeJD(jd: JobDescription): JDAnalysisResult {
    // The extractor already does analysis, but we can add more sophisticated analysis here
    return {
      requiredSkills: jd.requiredSkills,
      preferredSkills: jd.preferredSkills,
      niceToHaveSkills: jd.niceToHaveSkills,
      responsibilities: jd.responsibilities,
      experienceRequirements: jd.experienceRequirements,
      educationRequirements: jd.educationRequirements,
      cloudPlatforms: jd.cloudPlatforms,
      programmingLanguages: jd.programmingLanguages,
      devopsTools: jd.devopsTools,
      cicdTools: jd.cicdTools,
      monitoringTools: jd.monitoringTools,
      databases: jd.databases,
      securityRequirements: jd.securityRequirements,
      keywords: jd.keywords,
      seniority: jd.seniority,
      remotePolicy: jd.remotePolicy || 'unspecified',
      employmentType: jd.employmentType,
      salary: jd.salary,
      visaRequirements: jd.visaRequirements,
      applicationQuestions: jd.applicationQuestions,
      otherConstraints: jd.otherConstraints,
    };
  }

  clearDeduplicationCache(): void {
    this.deduplicator.clear();
  }
}
