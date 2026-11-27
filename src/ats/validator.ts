/**
 * ATS Validator - validates resume against ATS parsing and scoring criteria.
 */

import type { ATSValidationInput, ATSValidationResult, ATSScore, ATSScoreDetail, JobDescription as ATSJobDescription } from './types.ts';
import type { ResumeSection, RemotePolicy } from '../core/types.ts';
import type { JobDescription as JDJobDescription } from '../jd/types.ts';
import { logger } from '../core/logger.ts';

export class ATSValidator {
  private readonly MIN_SCORE = 70;
  private readonly MAX_REVISIONS = 3;

  async validate(input: ATSValidationInput): Promise<ATSValidationResult> {
    const { resumeSections, jobDescription, format, content } = input;

    logger.info('Starting ATS validation', {
      format,
      sections: resumeSections.length,
      contentLength: content.length
    });

    // jobDescription is already in ATS format (ATSJobDescription)
    const atsJD = jobDescription as ATSJobDescription;

    const score = this.calculateScore(resumeSections, atsJD, format, content);
    const revisionSuggestions = this.generateRevisionSuggestions(score, resumeSections, atsJD);
    const revisionNeeded = score.overall < this.MIN_SCORE && revisionSuggestions.length > 0;
    const passed = score.overall >= this.MIN_SCORE;

    return {
      score,
      passed,
      revisionNeeded,
      revisionSuggestions,
    };
  }

  private convertJD(jd: ATSJobDescription): ATSJobDescription {
    return {
      jobId: jd.jobId,
      company: jd.company,
      title: jd.title,
      location: jd.location,
      remote: jd.remote,
      remotePolicy: jd.remotePolicy || 'unspecified',
      seniority: jd.seniority,
      employmentType: jd.employmentType,
      requiredSkills: jd.requiredSkills.map(s => ({
        name: s.name,
        category: s.category,
        importance: s.importance,
        yearsExperience: s.yearsExperience,
        confidence: s.confidence,
      })),
      preferredSkills: jd.preferredSkills.map(s => ({
        name: s.name,
        category: s.category,
        importance: s.importance,
        yearsExperience: s.yearsExperience,
        confidence: s.confidence,
      })),
      niceToHaveSkills: jd.niceToHaveSkills.map(s => ({
        name: s.name,
        category: s.category,
        importance: s.importance,
        yearsExperience: s.yearsExperience,
        confidence: s.confidence,
      })),
      responsibilities: jd.responsibilities,
      experienceRequirements: jd.experienceRequirements,
      educationRequirements: jd.educationRequirements,
      certifications: jd.certifications,
      cloudPlatforms: jd.cloudPlatforms,
      programmingLanguages: jd.programmingLanguages,
      devopsTools: jd.devopsTools,
      cicdTools: jd.cicdTools,
      monitoringTools: jd.monitoringTools,
      databases: jd.databases,
      securityRequirements: jd.securityRequirements,
      keywords: jd.keywords,
      salary: jd.salary ? {
        min: jd.salary.min,
        max: jd.salary.max,
        currency: jd.salary.currency,
        period: jd.salary.period,
        negotiable: jd.salary.negotiable,
      } : undefined,
      visaRequirements: jd.visaRequirements ? {
        sponsorship: jd.visaRequirements.sponsorship,
        details: jd.visaRequirements.details,
      } : undefined,
      applicationQuestions: jd.applicationQuestions.map(q => ({
        question: q.question,
        type: q.type,
        required: q.required,
        options: q.options,
      })),
      otherConstraints: jd.otherConstraints,
      fullText: jd.fullText,
      extractedAt: jd.extractedAt,
      confidence: jd.confidence,
      sourceUrl: jd.sourceUrl,
      extractionMethod: jd.extractionMethod,
    };
  }

  private calculateScore(
    sections: ResumeSection[], 
    jd: ATSJobDescription, 
    format: string,
    content: string
  ): ATSScore {
    const details: ATSScoreDetail[] = [];

    // 1. Keyword Coverage (25%)
    const jdKeywords = [
      ...jd.requiredSkills.map(s => s.name.toLowerCase()),
      ...jd.preferredSkills.map(s => s.name.toLowerCase()),
      ...jd.niceToHaveSkills.map(s => s.name.toLowerCase()),
      ...jd.cloudPlatforms.map(k => k.toLowerCase()),
      ...jd.programmingLanguages.map(k => k.toLowerCase()),
      ...jd.devopsTools.map(k => k.toLowerCase()),
      ...jd.cicdTools.map(k => k.toLowerCase()),
      ...jd.databases.map(k => k.toLowerCase()),
    ];
    
    const uniqueKeywords = [...new Set(jdKeywords)];
    const contentLower = content.toLowerCase();
    const keywordMatches = uniqueKeywords.filter(k => contentLower.includes(k)).length;
    const keywordCoverage = uniqueKeywords.length > 0 ? keywordMatches / uniqueKeywords.length : 1;

    details.push({
      criterion: 'Keyword Coverage',
      score: Math.round(keywordCoverage * 100),
      maxScore: 100,
      weight: 0.25,
      notes: `${keywordMatches}/${uniqueKeywords.length} keywords found`,
    });

    // 2. Skill Coverage (20%)
    const skillCoverage = this.calculateSkillCoverage(sections, jd);
    details.push({
      criterion: 'Skill Coverage',
      score: skillCoverage,
      maxScore: 100,
      weight: 0.20,
      notes: 'Technical skills alignment with JD',
    });

    // 3. Experience Relevance (20%)
    const expRelevance = this.calculateExperienceRelevance(sections, jd);
    details.push({
      criterion: 'Experience Relevance',
      score: expRelevance,
      maxScore: 100,
      weight: 0.20,
      notes: 'Experience section alignment with requirements',
    });

    // 4. Section Structure (15%)
    const structureScore = this.calculateStructureScore(sections);
    details.push({
      criterion: 'Section Structure',
      score: structureScore,
      maxScore: 100,
      weight: 0.15,
      notes: this.getStructureNotes(sections),
    });

    // 5. Formatting (10%)
    const formatScore = this.calculateFormatScore(format, content);
    details.push({
      criterion: 'Formatting',
      score: formatScore,
      maxScore: 100,
      weight: 0.10,
      notes: `Format: ${format}`,
    });

    // 6. Parsing (5%)
    const parsingScore = this.calculateParsingScore(content);
    details.push({
      criterion: 'Parsing',
      score: parsingScore,
      maxScore: 100,
      weight: 0.05,
      notes: 'Text extraction compatibility',
    });

    // 7. Readability (3%)
    const readabilityScore = this.calculateReadabilityScore(content);
    details.push({
      criterion: 'Readability',
      score: readabilityScore,
      maxScore: 100,
      weight: 0.03,
      notes: 'Text clarity and structure',
    });

    // 8. JD Alignment (2%)
    // This would come from match analysis; using a proxy
    const jdAlignment = (keywordCoverage + skillCoverage / 100 + expRelevance / 100) / 3 * 100;
    details.push({
      criterion: 'JD Alignment',
      score: Math.round(jdAlignment),
      maxScore: 100,
      weight: 0.02,
      notes: 'Overall job description alignment',
    });

    // Calculate weighted overall
    const overall = Math.round(
      details.reduce((sum, d) => sum + d.score * d.weight, 0)
    );

    return {
      overall,
      keywordCoverage: Math.round(keywordCoverage * 100),
      skillCoverage,
      experienceRelevance: expRelevance,
      sectionStructure: structureScore,
      formatting: formatScore,
      parsing: parsingScore,
      readability: readabilityScore,
      jdAlignment: Math.round(jdAlignment),
      details,
      passed: overall >= this.MIN_SCORE,
      validatedAt: new Date(),
    };
  }

  private calculateSkillCoverage(sections: ResumeSection[], jd: ATSJobDescription): number {
    const skillsSection = sections.find(s => s.type === 'skills');
    if (!skillsSection) return 50;

    const skillsText = skillsSection.content.toLowerCase();
    const jdSkills = [
      ...jd.requiredSkills.map(s => s.name.toLowerCase()),
      ...jd.preferredSkills.map(s => s.name.toLowerCase()),
    ];

    const matches = jdSkills.filter(s => skillsText.includes(s)).length;
    return jdSkills.length > 0 ? Math.round((matches / jdSkills.length) * 100) : 100;
  }

  private calculateExperienceRelevance(sections: ResumeSection[], jd: ATSJobDescription): number {
    const expSection = sections.find(s => s.type === 'experience');
    if (!expSection) return 40;

    const expText = expSection.content.toLowerCase();
    const jdRequirements = [
      ...jd.cloudPlatforms,
      ...jd.programmingLanguages,
      ...jd.devopsTools,
      ...jd.cicdTools,
      ...jd.databases,
      ...jd.responsibilities,
    ].map(r => r.toLowerCase());

    if (jdRequirements.length === 0) return 80;

    const matches = jdRequirements.filter(r => expText.includes(r)).length;
    return Math.round((matches / jdRequirements.length) * 100);
  }

  private calculateStructureScore(sections: ResumeSection[]): number {
    const requiredSections = ['header', 'summary', 'skills', 'experience', 'education'];
    const presentSections = new Set(sections.map(s => s.type as string));
    const missing = requiredSections.filter(s => !presentSections.has(s));

    if (missing.length === 0) return 100;
    if (missing.length === 1) return 85;
    if (missing.length === 2) return 70;
    return 50;
  }

  private getStructureNotes(sections: ResumeSection[]): string {
    const requiredSections = ['header', 'summary', 'skills', 'experience', 'education'];
    const presentSections = new Set(sections.map(s => s.type as string));
    const missing = requiredSections.filter(s => !presentSections.has(s));
    return missing.length === 0 ? 'All required sections present' : `Missing: ${missing.join(', ')}`;
  }

  private calculateFormatScore(format: string, content: string): number {
    // Format-specific scoring
    switch (format) {
      case 'pdf': return 95;
      case 'docx': return 90;
      case 'html': return 85;
      case 'json': return 80;
      case 'text': return 75;
      default: return 70;
    }
  }

  private calculateParsingScore(content: string): number {
    // Check for parsing issues
    let score = 100;
    
    // Too many special characters
    const specialCharRatio = (content.match(/[^\w\s\-\.\,\:\;\(\)\[\]\/\@]/g) || []).length / content.length;
    if (specialCharRatio > 0.1) score -= 20;
    
    // Very long lines (hard to parse)
    const lines = content.split('\n');
    const longLines = lines.filter(l => l.length > 200).length;
    if (longLines > lines.length * 0.3) score -= 15;
    
    // No clear section delimiters
    const hasHeaders = lines.some(l => l.match(/^#{1,3}\s/) || l.match(/^[A-Z][A-Z\s]{2,}:$/));
    if (!hasHeaders) score -= 10;
    
    return Math.max(50, score);
  }

  private calculateReadabilityScore(content: string): number {
    let score = 100;
    
    // Check sentence length
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 0);
    const avgSentenceLength = sentences.reduce((sum, s) => sum + s.split(/\s+/).length, 0) / sentences.length;
    if (avgSentenceLength > 25) score -= 15;
    
    // Check for bullet points (good for readability)
    const bulletLines = content.split('\n').filter(l => l.trim().match(/^[\-\*\•]\s/)).length;
    const totalLines = content.split('\n').length;
    if (bulletLines / totalLines < 0.1) score -= 10;
    
    // Check for section breaks
    const sectionBreaks = (content.match(/---/g) || []).length;
    if (sectionBreaks < 3) score -= 10;
    
    return Math.max(50, score);
  }

  private generateRevisionSuggestions(
    score: ATSScore, 
    sections: ResumeSection[], 
    jd: ATSJobDescription
  ): string[] {
    const suggestions: string[] = [];

    // Keyword coverage
    if (score.keywordCoverage < 70) {
      const missingKeywords = this.findMissingKeywords(sections, jd);
      if (missingKeywords.length > 0) {
        suggestions.push(`Add missing keywords: ${missingKeywords.slice(0, 5).join(', ')}`);
      }
    }

    // Skill coverage
    if (score.skillCoverage < 70) {
      suggestions.push('Add more technical skills that match job requirements to Skills section');
    }

    // Experience relevance
    if (score.experienceRelevance < 60) {
      suggestions.push('Rewrite experience bullets to include more job-relevant technologies and achievements');
    }

    // Structure
    if (score.sectionStructure < 85) {
      const requiredSections = ['header', 'summary', 'skills', 'experience', 'education'];
      const presentSections = new Set(sections.map(s => s.type as string));
      const missing = requiredSections.filter(s => !presentSections.has(s));
      suggestions.push(`Add missing sections: ${missing.join(', ')}`);
    }

    // Formatting
    if (score.formatting < 80) {
      suggestions.push('Consider using PDF or DOCX format for better ATS compatibility');
    }

    // Parsing
    if (score.parsing < 80) {
      suggestions.push('Simplify formatting - avoid special characters, tables, and complex layouts');
    }

    // Readability
    if (score.readability < 75) {
      suggestions.push('Use more bullet points, shorter sentences, and clear section headers');
    }

    return suggestions.slice(0, 5);
  }

  private findMissingKeywords(sections: ResumeSection[], jd: ATSJobDescription): string[] {
    const content = sections.map(s => s.content).join(' ').toLowerCase();
    const jdKeywords = [
      ...jd.requiredSkills.map(s => s.name.toLowerCase()),
      ...jd.preferredSkills.map(s => s.name.toLowerCase()),
      ...jd.cloudPlatforms.map(k => k.toLowerCase()),
      ...jd.programmingLanguages.map(k => k.toLowerCase()),
      ...jd.devopsTools.map(k => k.toLowerCase()),
    ];
    
    const uniqueKeywords = [...new Set(jdKeywords)];
    return uniqueKeywords.filter(k => !content.includes(k));
  }
}
