/**
 * JD Verifier - verifies extracted job description quality and completeness.
 */

import type { JobDescription, JDVerificationResult } from './types.ts';
import { logger } from '../core/logger.ts';

const REQUIRED_FIELDS: (keyof JobDescription)[] = [
  'title',
  'company',
  'location',
  'fullText',
];

const IMPORTANT_FIELDS: (keyof JobDescription)[] = [
  'requiredSkills',
  'responsibilities',
  'experienceRequirements',
  'seniority',
  'employmentType',
];

export class JDVerifier {
  verify(jd: JobDescription): JDVerificationResult {
    const issues: string[] = [];
    let score = 0;
    const maxScore = REQUIRED_FIELDS.length * 2 + IMPORTANT_FIELDS.length;

    // Check required fields
    for (const field of REQUIRED_FIELDS) {
      const value = jd[field];
      if (!value || (Array.isArray(value) && value.length === 0) || (typeof value === 'string' && value.trim().length === 0)) {
        issues.push(`Missing required field: ${field}`);
      } else {
        score += 2;
      }
    }

    // Check important fields
    for (const field of IMPORTANT_FIELDS) {
      const value = jd[field];
      if (!value || (Array.isArray(value) && value.length === 0)) {
        issues.push(`Missing important field: ${field}`);
      } else {
        score += 1;
      }
    }

    // Check content quality
    if (jd.fullText.length < 300) {
      issues.push('Job description text is too short (< 300 chars)');
    } else if (jd.fullText.length < 1000) {
      score += 0.5;
    } else {
      score += 1;
    }

    // Check skills extraction
    const totalSkills = jd.requiredSkills.length + jd.preferredSkills.length + jd.niceToHaveSkills.length;
    if (totalSkills === 0) {
      issues.push('No skills extracted from job description');
    } else if (totalSkills < 3) {
      issues.push('Very few skills extracted');
      score += 0.5;
    } else {
      score += 1;
    }

    // Check for placeholder/unknown values
    if (jd.company === 'Unknown Company') issues.push('Company name not extracted');
    if (jd.title === 'Unknown Position') issues.push('Job title not extracted');

    const confidence = Math.max(0, Math.min(1, score / maxScore));
    const verified = confidence >= 0.6 && issues.filter(i => i.startsWith('Missing required')).length === 0;
    const complete = issues.length === 0;

    logger.info('JD verification completed', {
      jobId: jd.jobId,
      verified,
      confidence,
      issuesCount: issues.length,
      complete,
    });

    return {
      verified,
      confidence,
      issues,
      complete,
    };
  }

  async verifyWithRetry(
    extractor: (input: any) => any,
    input: any,
    maxRetries: number = 3
  ): Promise<JDVerificationResult> {
    let lastResult: JDVerificationResult;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const jd = extractor(input);
      lastResult = this.verify(jd);
      
      if (lastResult.verified) {
        return lastResult;
      }
      
      logger.warn('JD verification failed, retrying', { 
        attempt, 
        maxRetries, 
        issues: lastResult.issues 
      });
      
      // Wait before retry
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
    
    return lastResult!;
  }
}
