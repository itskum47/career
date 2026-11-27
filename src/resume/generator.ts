/**
 * Resume Generator - creates job-specific resumes from master profile.
 */

import type { ResumeGenerationInput, ResumeGenerationResult, ResumeSection, ResumeSectionType, ResumeVersion, ATSScore, ATSScoreDetail } from './types.ts';
import type { MasterProfile, SkillEntry, ExperienceEntry, ProjectEntry, EducationEntry } from '../core/types.ts';
import type { JobDescription } from '../jd/types.ts';
import type { MatchAnalysis } from '../match/types.ts';
import { generateJobId } from '../core/ids.ts';
import { logger } from '../core/logger.ts';
import { startTimer } from '../performance/timer.ts';
import { STAGES } from '../performance/stages.ts';
import { detectFabricatedClaims, partitionCertifications, profileProfileVersion, withUnverifiedFieldsWithheld } from '../profile/profile-integrity.ts';

export class ResumeGenerator {
  private templates: Map<string, ResumeSectionType[]> = new Map();

  constructor() {
    // Default template - standard professional
    this.templates.set('standard', [
      'header',
      'summary',
      'skills',
      'experience',
      'projects',
      'education',
      'certifications',
    ]);
    
    // Technical template - skills first
    this.templates.set('technical', [
      'header',
      'summary',
      'skills',
      'projects',
      'experience',
      'education',
      'certifications',
    ]);
    
    // Senior template - experience first
    this.templates.set('senior', [
      'header',
      'summary',
      'experience',
      'skills',
      'projects',
      'education',
      'certifications',
    ]);
  }

  async generate(input: ResumeGenerationInput): Promise<ResumeGenerationResult> {
    const { profile, jobDescription, matchAnalysis } = input;
    const templateId = input.templateId || this.selectTemplate(jobDescription, matchAnalysis);
    const sectionOrder = this.templates.get(templateId) || this.templates.get('standard')!;
    
    const timer = startTimer({ stage: STAGES.RESUME_GENERATION, jobId: jobDescription.jobId });

    logger.info('Generating resume', { 
      jobId: jobDescription.jobId, 
      template: templateId 
    });

    // Phase 9: values the profile marks as unverified (e.g. an unconfirmed
    // LinkedIn URL) are withheld from the document entirely — an employer reads
    // a printed URL as a confirmed identity claim.
    const { profile: safeProfile, withheld: withheldFieldPaths } = withUnverifiedFieldsWithheld(profile);

    // Generate tailored sections
    const sections = this.generateSections(safeProfile, jobDescription, matchAnalysis, sectionOrder);
    
    // Build resume content
    const content = this.buildResumeContent(safeProfile, sections);
    
    // Create resume version
    const resume: ResumeVersion = {
      resumeId: `RES-${jobDescription.jobId}-${Date.now()}`,
      jobId: jobDescription.jobId,
      candidateId: profile.candidateId,
      version: 1,
      format: 'json',
      filePath: '', // Will be set after file generation
      generatedAt: new Date(),
      generatorVersion: '1.0.0',
      // Phase 9: bind the artifact to the exact profile it was built from, so a
      // later profile edit (or a re-lock) can never leave this file uploadable.
      profileVersion: profileProfileVersion(profile),
    };

    // Calculate ATS score
    const atsScore = this.calculateATSScore(sections, jobDescription, matchAnalysis);

    const warnings: string[] = [];
    if (atsScore.overall < 70) {
      warnings.push(`ATS score (${atsScore.overall}) below threshold (70)`);
    }
    if (matchAnalysis.missingRequired.length > 0) {
      warnings.push(`Missing required skills: ${matchAnalysis.missingRequired.map((g: { skill: string }) => g.skill).join(', ')}`);
    }

    // Phase 9: never ship a document built from withdrawn claims.
    const fabricated = detectFabricatedClaims(content);
    for (const f of fabricated) {
      warnings.push(`withdrawn claim detected in generated content (${f.id}) — this resume must not be uploaded`);
    }
    const withheld = partitionCertifications(profile.certifications).withheld;
    for (const w of withheld) {
      warnings.push(`certification withheld: "${w.name}" — ${w.reason}`);
    }
    for (const field of withheldFieldPaths) {
      warnings.push(`unverified field withheld: ${field} — not confirmed as belonging to the candidate`);
    }

    timer.end(true);
    return {
      resume,
      sections,
      atsScore,
      warnings,
    };
  }

  private selectTemplate(jd: JobDescription, match: MatchAnalysis): string {
    if (jd.seniority === 'senior' || jd.seniority === 'lead' || jd.seniority === 'principal') {
      return 'senior';
    }
    if (jd.programmingLanguages.length > 3 || jd.cloudPlatforms.length > 2) {
      return 'technical';
    }
    return 'standard';
  }

  private generateSections(
    profile: MasterProfile,
    jd: JobDescription,
    match: MatchAnalysis,
    sectionOrder: ResumeSectionType[]
  ): ResumeSection[] {
    const sections: ResumeSection[] = [];
    let order = 1;

    for (const sectionType of sectionOrder) {
      let section: ResumeSection | undefined = undefined;

      switch (sectionType) {
        case 'header':
          section = this.generateHeader(profile);
          break;
        case 'summary':
          section = this.generateSummary(profile, jd, match);
          break;
        case 'skills':
          section = this.generateSkills(profile, jd, match);
          break;
        case 'experience':
          section = this.generateExperience(profile, jd, match);
          break;
        case 'projects':
          section = this.generateProjects(profile, jd, match);
          break;
        case 'education':
          section = this.generateEducation(profile, jd);
          break;
        case 'certifications':
          section = this.generateCertifications(profile, jd);
          break;
        case 'achievements':
          section = this.generateAchievements(profile, jd);
          break;
      }

      if (section) {
        section.order = order++;
        sections.push(section);
      }
    }

    return sections;
  }

  private generateHeader(profile: MasterProfile): ResumeSection {
    const { personal } = profile;
    const content = [
      personal.fullName,
      `${personal.email} | ${personal.phone}`,
      personal.location,
      personal.linkedin ? `LinkedIn: ${personal.linkedin}` : '',
      personal.github ? `GitHub: ${personal.github}` : '',
      personal.portfolio ? `Portfolio: ${personal.portfolio}` : '',
    ].filter(Boolean).join('\n');

    return {
      type: 'header',
      title: 'Contact Information',
      content,
      order: 0,
      emphasis: 'high',
    };
  }

  private generateSummary(profile: MasterProfile, jd: JobDescription, match: MatchAnalysis): ResumeSection {
    const baseSummary = profile.personal.summary;
    const matchedSkills = [
      ...match.missingRequired.map(g => g.skill).slice(0, 3).map(s => `NOT: ${s}`),
      ...jd.requiredSkills.filter(s => !match.missingRequired.some(m => m.skill === s.name))
        .slice(0, 5).map(s => s.name),
    ];

    const tailoredSummary = `${baseSummary}

Key qualifications for this role:
${matchedSkills.filter(s => !s.startsWith('NOT:')).map(s => `• ${s}`).join('\n')}`;

    return {
      type: 'summary',
      title: 'Professional Summary',
      content: tailoredSummary,
      order: 0,
      emphasis: 'high',
    };
  }

  private generateSkills(profile: MasterProfile, jd: JobDescription, match: MatchAnalysis): ResumeSection {
    // Prioritize skills that match job requirements
    const requiredSkillNames = new Set(jd.requiredSkills.map(s => s.name.toLowerCase()));
    const preferredSkillNames = new Set(jd.preferredSkills.map(s => s.name.toLowerCase()));
    const allJDSkills = new Set([...requiredSkillNames, ...preferredSkillNames]);

    // Sort skills: matched required first, then matched preferred, then others
    const sortedSkills = [...profile.skills].sort((a, b) => {
      const aLower = a.name.toLowerCase();
      const bLower = b.name.toLowerCase();
      
      const aRequired = requiredSkillNames.has(aLower);
      const bRequired = requiredSkillNames.has(bLower);
      const aPreferred = preferredSkillNames.has(aLower);
      const bPreferred = preferredSkillNames.has(bLower);
      
      if (aRequired && !bRequired) return -1;
      if (!aRequired && bRequired) return 1;
      if (aPreferred && !bPreferred) return -1;
      if (!aPreferred && bPreferred) return 1;
      
      // Within same category, sort by proficiency
      const profValues = { expert: 5, advanced: 4, intermediate: 3, beginner: 2, learning: 1 };
      return (profValues[b.proficiency as keyof typeof profValues] || 0) - 
             (profValues[a.proficiency as keyof typeof profValues] || 0);
    });

    // Group by category
    const byCategory: Record<string, SkillEntry[]> = {};
    for (const skill of sortedSkills) {
      if (!byCategory[skill.category]) byCategory[skill.category] = [];
      byCategory[skill.category].push(skill);
    }

    const categoryOrder = [
      'cloud', 'containerization', 'ci-cd', 'infrastructure-as-code',
      'monitoring', 'scripting', 'programming', 'database', 
      'networking', 'security', 'soft', 'other'
    ];

    const contentParts: string[] = [];
    for (const category of categoryOrder) {
      const skills = byCategory[category];
      if (!skills || skills.length === 0) continue;
      
      const displayName = category.charAt(0).toUpperCase() + category.slice(1).replace(/-/g, ' ');
      const skillNames = skills.slice(0, 8).map(s => {
        const isRequired = requiredSkillNames.has(s.name.toLowerCase());
        const isPreferred = preferredSkillNames.has(s.name.toLowerCase());
        const marker = isRequired ? ' ★' : isPreferred ? ' ☆' : '';
        return `${s.name} (${s.proficiency}, ${s.yearsExperience} yrs)${marker}`;
      }).join(', ');
      
      contentParts.push(`${displayName}: ${skillNames}`);
    }

    return {
      type: 'skills',
      title: 'Technical Skills',
      content: contentParts.join('\n\n'),
      order: 0,
      emphasis: 'high',
    };
  }

  private generateExperience(profile: MasterProfile, jd: JobDescription, match: MatchAnalysis): ResumeSection {
    // Sort experiences by relevance to job
    const relevantKeywords = [
      ...jd.cloudPlatforms,
      ...jd.programmingLanguages,
      ...jd.devopsTools,
      ...jd.cicdTools,
      ...jd.databases,
    ].map(k => k.toLowerCase());

    const sortedExperiences = [...profile.experience].sort((a, b) => {
      const aText = `${a.title} ${a.description} ${a.technologies.join(' ')}`.toLowerCase();
      const bText = `${b.title} ${b.description} ${b.technologies.join(' ')}`.toLowerCase();
      
      const aMatches = relevantKeywords.filter(k => aText.includes(k)).length;
      const bMatches = relevantKeywords.filter(k => bText.includes(k)).length;
      
      if (aMatches !== bMatches) return bMatches - aMatches;
      
      // Current roles first
      if (a.current && !b.current) return -1;
      if (!a.current && b.current) return 1;
      
      // More recent first
      return b.startDate.getTime() - a.startDate.getTime();
    });

    const contentParts = sortedExperiences.slice(0, 5).map(exp => {
      const duration = exp.current 
        ? `${exp.startDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })} - Present`
        : `${exp.startDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })} - ${exp.endDate!.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`;
      
      const location = exp.location ? ` | ${exp.location}` : '';
      const remote = exp.remote ? ' (Remote)' : '';
      
      let content = `**${exp.title}** at **${exp.company}**${location}${remote}\n${duration}\n\n`;
      
      // Tailor description - emphasize relevant achievements
      const relevantAchievements = exp.achievements.filter(ach => 
        relevantKeywords.some(k => ach.toLowerCase().includes(k))
      );
      const otherAchievements = exp.achievements.filter(ach => 
        !relevantKeywords.some(k => ach.toLowerCase().includes(k))
      );
      
      const displayAchievements = [...relevantAchievements, ...otherAchievements].slice(0, 5);
      content += displayAchievements.map(a => `• ${a}`).join('\n');
      
      if (exp.technologies.length > 0) {
        content += `\nTechnologies: ${exp.technologies.join(', ')}`;
      }
      
      return content;
    });

    return {
      type: 'experience',
      title: 'Professional Experience',
      content: contentParts.join('\n\n---\n\n'),
      order: 0,
      emphasis: 'high',
    };
  }

  private generateProjects(profile: MasterProfile, jd: JobDescription, match: MatchAnalysis): ResumeSection {
    const relevantKeywords = [
      ...jd.cloudPlatforms,
      ...jd.programmingLanguages,
      ...jd.devopsTools,
      ...jd.cicdTools,
      ...jd.databases,
    ].map(k => k.toLowerCase());

    const sortedProjects = [...profile.projects].sort((a, b) => {
      const aText = `${a.name} ${a.description} ${a.technologies.join(' ')}`.toLowerCase();
      const bText = `${b.name} ${b.description} ${b.technologies.join(' ')}`.toLowerCase();
      
      const aMatches = relevantKeywords.filter(k => aText.includes(k)).length;
      const bMatches = relevantKeywords.filter(k => bText.includes(k)).length;
      
      return bMatches - aMatches;
    }).slice(0, 4);

    const contentParts = sortedProjects.map(proj => {
      let content = `**${proj.name}**\n${proj.description}\n`;
      
      if (proj.highlights.length > 0) {
        content += proj.highlights.map(h => `• ${h}`).join('\n');
      }
      
      if (proj.technologies.length > 0) {
        content += `\nTechnologies: ${proj.technologies.join(', ')}`;
      }
      
      if (proj.url) content += `\n[${proj.url}](${proj.url})`;
      if (proj.repository) content += `\n[Repository](${proj.repository})`;
      
      return content;
    });

    return {
      type: 'projects',
      title: 'Key Projects',
      content: contentParts.join('\n\n---\n\n'),
      order: 0,
      emphasis: 'medium',
    };
  }

  private generateEducation(profile: MasterProfile, jd: JobDescription): ResumeSection {
    const contentParts = profile.education.map(edu => {
      let content = `**${edu.degree} in ${edu.field}**\n${edu.institution}`;
      
      if (edu.location) content += `, ${edu.location}`;
      // A date the source document does not state is left unstated, not guessed.
      if (edu.startDate || edu.endDate) {
        const start = edu.startDate ? edu.startDate.getFullYear() : 'n/a';
        const end = edu.endDate ? edu.endDate.getFullYear() : 'Present';
        content += `\n${start} - ${end}`;
      }
      
      if (edu.gpa) content += ` | GPA: ${edu.gpa}`;
      if (edu.honors && edu.honors.length > 0) content += `\nHonors: ${edu.honors.join(', ')}`;
      if (edu.relevantCoursework && edu.relevantCoursework.length > 0) {
        content += `\nRelevant Coursework: ${edu.relevantCoursework.join(', ')}`;
      }
      
      return content;
    });

    return {
      type: 'education',
      title: 'Education',
      content: contentParts.join('\n\n'),
      order: 0,
      emphasis: 'medium',
    };
  }

  private generateCertifications(profile: MasterProfile, jd: JobDescription): ResumeSection {
    // Phase 9: a generic CV label ("AWS Certification") is NOT a credential.
    // Only entries the candidate has verified may be rendered as one.
    const { claimable, withheld } = partitionCertifications(profile.certifications);

    if (claimable.length === 0) {
      return {
        type: 'certifications',
        title: 'Certifications',
        content: withheld.length > 0
          ? 'Not listed in this document — certification details pending candidate confirmation.'
          : 'None',
        order: 0,
        emphasis: 'low',
      };
    }

    // Prioritize certifications relevant to job
    const relevantCerts = claimable.filter(cert => {
      const certText = `${cert.name} ${cert.issuer}`.toLowerCase();
      return jd.certifications.some(c => certText.includes(c.toLowerCase())) ||
             jd.cloudPlatforms.some(c => certText.includes(c.toLowerCase())) ||
             jd.devopsTools.some(c => certText.includes(c.toLowerCase()));
    });

    const otherCerts = claimable.filter(c => !relevantCerts.includes(c));
    const allCerts = [...relevantCerts, ...otherCerts].slice(0, 6);

    const contentParts = allCerts.map(cert => {
      let content = `**${cert.name}** — ${cert.issuer}`;
      if (cert.issueDate) {
        content += `\nIssued: ${cert.issueDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`;
      }
      if (cert.expiryDate) content += ` | Expires: ${cert.expiryDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`;
      if (cert.credentialId) content += ` | ID: ${cert.credentialId}`;
      return content;
    });

    return {
      type: 'certifications',
      title: 'Certifications',
      content: contentParts.join('\n\n'),
      order: 0,
      emphasis: 'medium',
    };
  }

  private generateAchievements(profile: MasterProfile, jd: JobDescription): ResumeSection | undefined {
    if (profile.achievements.length === 0) return undefined;

    const relevantAchievements = profile.achievements
      .filter(a => a.impact && jd.keywords.some(k => a.impact!.toLowerCase().includes(k.toLowerCase())))
      .slice(0, 3);

    const otherAchievements = profile.achievements
      .filter(a => !relevantAchievements.includes(a))
      .slice(0, 2);

    const allAchievements = [...relevantAchievements, ...otherAchievements];

    const contentParts = allAchievements.map(a => {
      let content = `**${a.title}** (${a.category})\n${a.description}`;
      if (a.date) content += `\n${a.date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`;
      if (a.impact) content += `\nImpact: ${a.impact}`;
      if (a.url) content += `\n[Details](${a.url})`;
      return content;
    });

    return {
      type: 'achievements',
      title: 'Achievements & Recognition',
      content: contentParts.join('\n\n'),
      order: 0,
      emphasis: 'low',
    };
  }

  private buildResumeContent(profile: MasterProfile, sections: ResumeSection[]): string {
    return sections
      .sort((a, b) => a.order - b.order)
      .map(s => `## ${s.title}\n\n${s.content}`)
      .join('\n\n---\n\n');
  }

  private calculateATSScore(
    sections: ResumeSection[], 
    jd: JobDescription, 
    match: MatchAnalysis
  ): ATSScore {
    const details: ATSScoreDetail[] = [];
    
    // Keyword coverage
    const resumeText = sections.map(s => s.content).join(' ').toLowerCase();
    const jdKeywords = [...jd.requiredSkills, ...jd.preferredSkills, ...jd.niceToHaveSkills]
      .map(s => s.name.toLowerCase());
    const keywordMatches = jdKeywords.filter(k => resumeText.includes(k)).length;
    const keywordCoverage = jdKeywords.length > 0 ? keywordMatches / jdKeywords.length : 1;
    
    details.push({
      criterion: 'Keyword Coverage',
      score: Math.round(keywordCoverage * 100),
      maxScore: 100,
      weight: 0.25,
      notes: `${keywordMatches}/${jdKeywords.length} keywords found`,
    });

    // Skill coverage (from match analysis)
    details.push({
      criterion: 'Required Skill Coverage',
      score: match.requiredSkillCoverage,
      maxScore: 100,
      weight: 0.25,
      notes: `${match.missingRequired.length} required skills missing`,
    });

    // Experience relevance
    details.push({
      criterion: 'Experience Relevance',
      score: match.experienceMatch,
      maxScore: 100,
      weight: 0.20,
      notes: 'Based on domain and years matching',
    });

    // Section structure
    const hasRequiredSections = ['header', 'summary', 'skills', 'experience', 'education']
      .every(t => sections.some(s => s.type === t));
    details.push({
      criterion: 'Section Structure',
      score: hasRequiredSections ? 100 : 70,
      maxScore: 100,
      weight: 0.10,
      notes: hasRequiredSections ? 'All required sections present' : 'Missing standard sections',
    });

    // Formatting (assume good for generated)
    details.push({
      criterion: 'Formatting',
      score: 95,
      maxScore: 100,
      weight: 0.10,
      notes: 'Clean generated format',
    });

    // Parsing (assume good)
    details.push({
      criterion: 'Parsing',
      score: 90,
      maxScore: 100,
      weight: 0.05,
      notes: 'Standard text format',
    });

    // Readability
    details.push({
      criterion: 'Readability',
      score: 85,
      maxScore: 100,
      weight: 0.03,
      notes: 'Clear section headers and bullet points',
    });

    // JD alignment
    details.push({
      criterion: 'JD Alignment',
      score: match.overallScore,
      maxScore: 100,
      weight: 0.02,
      notes: `Overall match: ${match.overallScore}%`,
    });

    // Calculate weighted overall
    const overall = Math.round(
      details.reduce((sum, d) => sum + d.score * d.weight, 0)
    );

    return {
      overall,
      keywordCoverage: Math.round(keywordCoverage * 100),
      skillCoverage: match.requiredSkillCoverage,
      experienceRelevance: match.experienceMatch,
      sectionStructure: hasRequiredSections ? 100 : 70,
      formatting: 95,
      parsing: 90,
      readability: 85,
      jdAlignment: match.overallScore,
      details,
      passed: overall >= 70,
      validatedAt: new Date(),
    };
  }
}
