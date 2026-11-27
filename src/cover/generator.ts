/**
 * Cover Letter Generator - creates job-specific cover letters.
 */

import type { CoverLetterInput, CoverLetterResult, CoverLetter, CoverLetterTemplate } from './types.ts';
import type { MasterProfile, JobId } from '../core/types.ts';
import type { JobDescription } from '../jd/types.ts';
import type { MatchAnalysis } from '../match/types.ts';
import { logger } from '../core/logger.ts';
import { startTimer } from '../performance/timer.ts';
import { STAGES } from '../performance/stages.ts';
import { detectFabricatedClaims, partitionCertifications, profileProfileVersion, withUnverifiedFieldsWithheld } from '../profile/profile-integrity.ts';

export class CoverLetterGenerator {
  private templates: Map<string, CoverLetterTemplate> = new Map();

  constructor() {
    this.templates.set('standard', {
      id: 'standard',
      name: 'Standard Professional',
      structure: ['header', 'opening', 'qualifications', 'motivation', 'closing'],
      tone: 'professional',
    });

    this.templates.set('enthusiastic', {
      id: 'enthusiastic',
      name: 'Enthusiastic',
      structure: ['header', 'opening', 'passion', 'qualifications', 'fit', 'closing'],
      tone: 'enthusiastic',
    });

    this.templates.set('concise', {
      id: 'concise',
      name: 'Concise',
      structure: ['header', 'opening', 'key_match', 'closing'],
      tone: 'concise',
    });

    this.templates.set('storytelling', {
      id: 'storytelling',
      name: 'Storytelling',
      structure: ['header', 'hook', 'story', 'qualifications', 'vision', 'closing'],
      tone: 'storytelling',
    });
  }

  async generate(input: CoverLetterInput): Promise<CoverLetterResult> {
    const { profile, jobDescription, matchAnalysis, tone = 'professional', templateId } = input;
    
    const template = this.templates.get(templateId || tone) || this.templates.get('standard')!;
    
    const timer = startTimer({ stage: STAGES.COVER_GENERATION, jobId: jobDescription.jobId });
    
    logger.info('Generating cover letter', { 
      jobId: jobDescription.jobId, 
      template: template.id,
      tone 
    });

    // Phase 9: withhold unverified profile values (e.g. an unconfirmed LinkedIn
    // URL) before anything is written into a letter an employer will read.
    const { profile: safeProfile, withheld } = withUnverifiedFieldsWithheld(profile);
    const content = this.buildCoverLetter(safeProfile, jobDescription, matchAnalysis, template);
    
    const coverLetter: CoverLetter = {
      coverLetterId: `CL-${jobDescription.jobId}-${Date.now()}`,
      jobId: jobDescription.jobId as JobId,
      candidateId: profile.candidateId,
      content,
      generatedAt: new Date(),
      templateId: template.id,
      // Phase 9: bind the letter to the profile version it was written from.
      profileVersion: profileProfileVersion(profile),
    };

    const warnings: string[] = [];
    if (content.length < 200) warnings.push('Cover letter may be too short');
    if (content.length > 500) warnings.push('Cover letter may be too long');
    if (!content.includes(jobDescription.company)) warnings.push('Company name not found in cover letter');
    if (!content.includes(jobDescription.title)) warnings.push('Job title not found in cover letter');
    // A cover letter must never carry a withdrawn claim either.
    for (const f of detectFabricatedClaims(content)) {
      warnings.push(`withdrawn claim detected in cover letter (${f.id}) — this letter must not be uploaded`);
    }
    for (const w of partitionCertifications(profile.certifications).withheld) {
      warnings.push(`certification withheld: "${w.name}" — ${w.reason}`);
    }
    for (const field of withheld) {
      warnings.push(`unverified field withheld: ${field} — not confirmed as belonging to the candidate`);
    }

    timer.end(true);
    return { coverLetter, content, warnings };
  }

  private buildCoverLetter(
    profile: MasterProfile,
    jd: JobDescription,
    match: MatchAnalysis,
    template: CoverLetterTemplate
  ): string {
    const { personal } = profile;
    const sections: string[] = [];

    // Header
    sections.push(this.renderHeader(personal, jd));

    // Build body sections based on template
    for (const sectionName of template.structure) {
      if (sectionName === 'header') continue; // Already added
      
      let sectionContent = '';
      switch (sectionName) {
        case 'opening':
          sectionContent = this.renderOpening(personal, jd, template.tone);
          break;
        case 'qualifications':
          sectionContent = this.renderQualifications(profile, jd, match);
          break;
        case 'motivation':
          sectionContent = this.renderMotivation(profile, jd);
          break;
        case 'passion':
          sectionContent = this.renderPassion(profile, jd);
          break;
        case 'fit':
          sectionContent = this.renderFit(profile, jd, match);
          break;
        case 'key_match':
          sectionContent = this.renderKeyMatch(profile, jd, match);
          break;
        case 'hook':
          sectionContent = this.renderHook(profile, jd);
          break;
        case 'story':
          sectionContent = this.renderStory(profile, jd);
          break;
        case 'vision':
          sectionContent = this.renderVision(profile, jd);
          break;
        case 'closing':
          sectionContent = this.renderClosing(personal, jd, template.tone);
          break;
      }
      
      if (sectionContent) sections.push(sectionContent);
    }

    return sections.join('\n\n');
  }

  private renderHeader(personal: MasterProfile['personal'], jd: JobDescription): string {
    const date = new Date().toLocaleDateString('en-US', { 
      year: 'numeric', month: 'long', day: 'numeric' 
    });
    
    return [
      `${personal.fullName}`,
      `${personal.email} | ${personal.phone}`,
      personal.linkedin ? `LinkedIn: ${personal.linkedin}` : '',
      personal.location,
      '',
      date,
      '',
      `Hiring Manager`,
      `${jd.company}`,
      `${jd.location}`,
      '',
      `Re: Application for ${jd.title} Position`,
    ].filter(Boolean).join('\n');
  }

  private renderOpening(personal: MasterProfile['personal'], jd: JobDescription, tone: string): string {
    const openings: Record<string, string> = {
      professional: `I am writing to express my interest in the ${jd.title} position at ${jd.company}. With my background in ${this.getPrimaryDomain(personal.summary)}, I am confident I can contribute significantly to your team.`,
      enthusiastic: `I was thrilled to discover the ${jd.title} opening at ${jd.company}! As someone who has followed ${jd.company}'s work in ${this.getCompanyDomain(jd)}, I would love to bring my expertise to your innovative team.`,
      concise: `I am applying for the ${jd.title} role at ${jd.company}. My ${this.getYearsExperience(personal.summary)}+ years of experience align well with your requirements.`,
      storytelling: `When I first encountered ${jd.company}'s approach to ${this.getCompanyDomain(jd)}, it resonated deeply with my own professional journey. The ${jd.title} position represents exactly the kind of challenge I've been preparing for.`,
    };
    return openings[tone] || openings.professional;
  }

  private renderQualifications(profile: MasterProfile, jd: JobDescription, match: MatchAnalysis): string {
    const matchedRequired = jd.requiredSkills.filter(s => 
      !match.missingRequired.some(m => m.skill === s.name)
    ).slice(0, 4);
    
    const matchedPreferred = jd.preferredSkills.filter(s => 
      !match.missingPreferred.some(m => m.skill === s.name)
    ).slice(0, 3);

    const relevantExperience = profile.experience
      .filter(e => jd.cloudPlatforms.some(c => e.technologies.some(t => t.toLowerCase().includes(c.toLowerCase()))) ||
                  jd.programmingLanguages.some(p => e.technologies.some(t => t.toLowerCase().includes(p.toLowerCase()))))
      .slice(0, 2);

    let content = 'My qualifications for this role include:\n\n';
    
    if (matchedRequired.length > 0) {
      content += `**Required Skills Match:**\n`;
      content += matchedRequired.map(s => `• ${s.name} (${s.category})`).join('\n');
      content += '\n\n';
    }

    if (matchedPreferred.length > 0) {
      content += `**Preferred Skills Match:**\n`;
      content += matchedPreferred.map(s => `• ${s.name} (${s.category})`).join('\n');
      content += '\n\n';
    }

    if (relevantExperience.length > 0) {
      content += `**Relevant Experience:**\n`;
      content += relevantExperience.map(e => 
        `• ${e.title} at ${e.company}: ${e.achievements[0] || e.description.substring(0, 100)}...`
      ).join('\n');
    }

    return content;
  }

  private renderMotivation(profile: MasterProfile, jd: JobDescription): string {
    return `I am particularly drawn to ${jd.company} because of your work in ${this.getCompanyDomain(jd)}. 
${profile.personal.summary.split('.')[0]}. I am eager to contribute to ${jd.company}'s mission and grow alongside a team that values ${jd.keywords.slice(0, 3).join(', ')}.`;
  }

  private renderPassion(profile: MasterProfile, jd: JobDescription): string {
    return `My passion for ${jd.cloudPlatforms[0] || 'cloud technologies'} and ${jd.programmingLanguages[0] || 'software engineering'} drives me to continuously improve and innovate. ${jd.company}'s reputation for ${jd.keywords[0] || 'excellence'} aligns perfectly with my career aspirations.`;
  }

  private renderFit(profile: MasterProfile, jd: JobDescription, match: MatchAnalysis): string {
    return `With a ${match.overallScore}% overall match and strong alignment in ${jd.cloudPlatforms[0] || 'cloud platforms'} and ${jd.programmingLanguages[0] || 'programming'}, I believe I would be a great fit for your team. My experience with ${profile.skills.slice(0, 3).map(s => s.name).join(', ')} directly applies to your current challenges.`;
  }

  private renderKeyMatch(profile: MasterProfile, jd: JobDescription, match: MatchAnalysis): string {
    const topMatches = [
      ...jd.requiredSkills.filter(s => !match.missingRequired.some(m => m.skill === s.name)).slice(0, 3),
      ...jd.preferredSkills.filter(s => !match.missingPreferred.some(m => m.skill === s.name)).slice(0, 2),
    ];

    return `Key qualifications:\n${topMatches.map(s => `• ${s.name}: ${s.category}`).join('\n')}`;
  }

  private renderHook(profile: MasterProfile, jd: JobDescription): string {
    const topAchievement = profile.achievements[0];
    if (topAchievement) {
      return `In my previous role, I ${topAchievement.description.toLowerCase()}. This experience taught me the value of ${jd.keywords[0] || 'innovation'} — a principle I see reflected in ${jd.company}'s work.`;
    }
    return `Throughout my career, I've focused on ${profile.skills[0]?.category || 'technical excellence'} — a focus that aligns with ${jd.company}'s approach to ${this.getCompanyDomain(jd)}.`;
  }

  private renderStory(profile: MasterProfile, jd: JobDescription): string {
    const relevantExp = profile.experience.find(e => 
      jd.cloudPlatforms.some(c => e.technologies.some(t => t.toLowerCase().includes(c.toLowerCase())))
    );
    
    if (relevantExp) {
      return `At ${relevantExp.company}, I led the effort to ${relevantExp.achievements[0] || 'modernize infrastructure'}. 
This project required deep expertise in ${jd.cloudPlatforms[0] || 'cloud platforms'} and ${jd.programmingLanguages[0] || 'automation'} — 
exactly the skills your ${jd.title} role demands.`;
    }
    return `My journey in ${this.getPrimaryDomain(profile.personal.summary)} has prepared me for this moment.`;
  }

  private renderVision(profile: MasterProfile, jd: JobDescription): string {
    return `I see an opportunity to contribute to ${jd.company}'s ${jd.keywords[0] || 'technical'} initiatives, particularly around ${jd.cloudPlatforms[0] || 'cloud infrastructure'} and ${jd.devopsTools[0] || 'automation'}. My goal is to help ${jd.company} achieve ${jd.responsibilities[0] || 'operational excellence'} while growing as a ${jd.title}.`;
  }

  private renderClosing(personal: MasterProfile['personal'], jd: JobDescription, tone: string): string {
    const closings: Record<string, string> = {
      professional: `Thank you for your consideration. I look forward to discussing how my experience can benefit ${jd.company}.`,
      enthusiastic: `I would love the opportunity to speak with you about how I can contribute to ${jd.company}'s continued success!`,
      concise: `Thank you for your time. I'm available to discuss this role at your convenience.`,
      storytelling: `I would be honored to bring my experience to ${jd.company} and help write the next chapter of your success story.`,
    };
    
    return `${closings[tone] || closings.professional}\n\nSincerely,\n${personal.fullName}`;
  }

  private getPrimaryDomain(summary: string): string {
    const domains = ['cloud', 'devops', 'backend', 'frontend', 'data', 'ml', 'ai', 'security', 'platform'];
    for (const domain of domains) {
      if (summary.toLowerCase().includes(domain)) return domain;
    }
    return 'software engineering';
  }

  private getCompanyDomain(jd: JobDescription): string {
    if (jd.cloudPlatforms.length > 0) return jd.cloudPlatforms[0];
    if (jd.programmingLanguages.length > 0) return jd.programmingLanguages[0];
    return 'technology';
  }

  private getYearsExperience(summary: string): string {
    const match = summary.match(/(\d+)\+?\s*years?/);
    return match ? match[1] : '5';
  }
}
