/**
 * Question Classifier - classifies application questions and determines answer source.
 */

import type { ApplicationQuestion, QuestionClassifierResult } from './types.ts';
import type { MasterProfile } from '../core/types.ts';
import { logger } from '../core/logger.ts';

const KNOWN_PATTERNS: Record<string, { field: string; category: string }> = {
  'first name': { field: 'personal.firstName', category: 'personal' },
  'last name': { field: 'personal.lastName', category: 'personal' },
  'full name': { field: 'personal.fullName', category: 'personal' },
  'email': { field: 'personal.email', category: 'personal' },
  'phone': { field: 'personal.phone', category: 'personal' },
  'telephone': { field: 'personal.phone', category: 'personal' },
  'mobile': { field: 'personal.phone', category: 'personal' },
  'address': { field: 'personal.location', category: 'personal' },
  'city': { field: 'personal.location', category: 'personal' },
  'state': { field: 'personal.location', category: 'personal' },
  'zip': { field: 'personal.location', category: 'personal' },
  'postal code': { field: 'personal.location', category: 'personal' },
  'country': { field: 'personal.location', category: 'personal' },
  'linkedin': { field: 'personal.linkedin', category: 'personal' },
  'github': { field: 'personal.github', category: 'personal' },
  'portfolio': { field: 'personal.portfolio', category: 'personal' },
  'website': { field: 'personal.website', category: 'personal' },
  'current company': { field: 'experience.0.company', category: 'experience' },
  'current title': { field: 'experience.0.title', category: 'experience' },
  'current role': { field: 'experience.0.title', category: 'experience' },
  'years of experience': { field: 'derived.yearsExperience', category: 'experience' },
  'total experience': { field: 'derived.yearsExperience', category: 'experience' },
  'notice period': { field: 'preferences.noticePeriodDays', category: 'compensation' },
  'availability': { field: 'preferences.availableFrom', category: 'compensation' },
  'expected salary': { field: 'compensation.minBase', category: 'compensation' },
  'salary expectation': { field: 'compensation.targetBase', category: 'compensation' },
  'desired salary': { field: 'compensation.targetBase', category: 'compensation' },
};

const USER_REQUIRED_PATTERNS = [
  'visa',
  'sponsor',
  'work authori',
  'immigration',
  'citizen',
  'green card',
  'permanent resident',
  'non.compete',
  'non compete',
  'non-disclosure',
  'non disclosure',
  'nda',
  'confidentiality',
  'criminal',
  'background check',
  'drug test',
  'security clearance',
  'felony',
  'convicted',
  'legal',
  'contract',
  'agreement',
  'waiver',
  'release',
  'indemnif',
  'liable',
  'relocation',
  'willing to relocate',
  'travel',
  'overtime',
  'shift',
  'on.call',
  'on-call',
  'weekend',
  'holiday',
  'reference',
  'referral',
  'how did you hear',
  'why do you want',
  'why this company',
  'why this role',
  'cover letter',
  'motivation',
  'passion',
  'diversity',
  'inclusion',
  'equity',
  'demographic',
  'gender',
  'race',
  'ethnicity',
  'veteran',
  'disability',
  'accommodation',
];

const UNSAFE_TO_GUESS_PATTERNS = [
  'legal',
  'authorization',
  'immigration',
  'visa',
  'sponsor',
  'citizen',
  'non.compete',
  'non compete',
  'non-disclosure',
  'confidentiality',
  'criminal',
  'felony',
  'convicted',
  'background check',
  'drug test',
  'security clearance',
  'salary history',
  'current compensation',
  'previous salary',
];

export class QuestionClassifier {
  classify(question: string, profile: MasterProfile): QuestionClassifierResult {
    const lowerQuestion = question.toLowerCase().trim();
    
    // Check for UNSAFE_TO_GUESS first (highest priority)
    for (const pattern of UNSAFE_TO_GUESS_PATTERNS) {
      if (lowerQuestion.includes(pattern)) {
        return {
          classification: 'UNSAFE_TO_GUESS',
          confidence: 0.95,
          suggestedAnswer: undefined,
          source: 'unsafe_pattern',
        };
      }
    }

    // Check for USER_REQUIRED
    for (const pattern of USER_REQUIRED_PATTERNS) {
      if (lowerQuestion.includes(pattern)) {
        return {
          classification: 'USER_REQUIRED',
          confidence: 0.9,
          suggestedAnswer: undefined,
          source: 'user_required_pattern',
        };
      }
    }

    // Check for KNOWN (direct profile mapping)
    for (const [pattern, mapping] of Object.entries(KNOWN_PATTERNS)) {
      if (lowerQuestion.includes(pattern)) {
        const value = this.getProfileValue(profile, mapping.field);
        return {
          classification: 'KNOWN',
          confidence: value ? 0.95 : 0.7,
          suggestedAnswer: value,
          source: 'profile',
        };
      }
    }

    // Check for DERIVABLE (can compute from profile)
    const derivableResult = this.tryDeriveAnswer(lowerQuestion, profile);
    if (derivableResult) {
      return derivableResult;
    }

    // Default to USER_REQUIRED for unknown questions
    logger.warn('Unknown question classification', { question });
    return {
      classification: 'USER_REQUIRED',
      confidence: 0.5,
      suggestedAnswer: undefined,
      source: 'default',
    };
  }

  private getProfileValue(profile: MasterProfile, path: string): string | undefined {
    const parts = path.split('.');
    let current: any = profile;
    
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      current = current[part];
    }
    
    return current?.toString();
  }

  private tryDeriveAnswer(question: string, profile: MasterProfile): QuestionClassifierResult | null {
    // Years of experience in specific technology
    const expMatch = question.match(/years?\s*(?:of\s*)?(?:experience|exp)\s*(?:in|with|using)?\s*([^?\n]{2,30})/i);
    if (expMatch) {
      const tech = expMatch[1].trim().toLowerCase();
      const years = this.calculateTechExperience(profile, tech);
      if (years > 0) {
        return {
          classification: 'DERIVABLE',
          confidence: 0.85,
          suggestedAnswer: `${years}`,
          source: 'derived_experience',
        };
      }
    }

    // Highest degree
    if (question.includes('highest degree') || question.includes('education level')) {
      const highest = profile.education.reduce((max, edu) => {
        const order = { 'phd': 5, 'doctorate': 5, 'master': 4, 'bachelor': 3, 'associate': 2, 'high school': 1 };
        const level = order[edu.degree.toLowerCase() as keyof typeof order] || 0;
        return level > (order[max.degree.toLowerCase() as keyof typeof order] || 0) ? edu : max;
      }, profile.education[0]);
      
      if (highest) {
        return {
          classification: 'DERIVABLE',
          confidence: 0.9,
          suggestedAnswer: `${highest.degree} in ${highest.field}`,
          source: 'derived_education',
        };
      }
    }

    // Current/most recent role
    if (question.includes('current role') || question.includes('current position') || question.includes('most recent')) {
      const current = profile.experience.find(e => e.current) || profile.experience[0];
      if (current) {
        return {
          classification: 'DERIVABLE',
          confidence: 0.9,
          suggestedAnswer: `${current.title} at ${current.company}`,
          source: 'derived_experience',
        };
      }
    }

    // Technical skills list
    if (question.includes('technologies') || question.includes('tech stack') || question.includes('tools') || question.includes('skills')) {
      const skills = profile.skills
        .filter(s => s.proficiency !== 'learning')
        .slice(0, 10)
        .map(s => `${s.name} (${s.proficiency})`)
        .join(', ');
      
      if (skills) {
        return {
          classification: 'DERIVABLE',
          confidence: 0.8,
          suggestedAnswer: skills,
          source: 'derived_skills',
        };
      }
    }

    // Certifications
    if (question.includes('certif')) {
      const certs = profile.certifications.map(c => c.name).join(', ');
      if (certs) {
        return {
          classification: 'DERIVABLE',
          confidence: 0.85,
          suggestedAnswer: certs,
          source: 'derived_certifications',
        };
      }
    }

    // Projects
    if (question.includes('project') && (question.includes('describe') || question.includes('example') || question.includes('detail'))) {
      const projects = profile.projects.slice(0, 3).map(p => `${p.name}: ${p.description.substring(0, 150)}`).join('; ');
      if (projects) {
        return {
          classification: 'DERIVABLE',
          confidence: 0.75,
          suggestedAnswer: projects,
          source: 'derived_projects',
        };
      }
    }

    // Authorization status
    if (question.includes('authorized to work') || question.includes('work authorization') || question.includes('eligible to work')) {
      const auth = profile.authorization.workAuthorizations.join(', ');
      return {
        classification: 'DERIVABLE',
        confidence: 0.9,
        suggestedAnswer: auth,
        source: 'derived_authorization',
      };
    }

    // Willing to relocate (if explicitly in preferences)
    if (question.includes('relocat')) {
      const remotePrefs = profile.preferences.remotePreference;
      if (remotePrefs.includes('fully-remote') || remotePrefs.includes('remote-with-travel')) {
        return {
          classification: 'DERIVABLE',
          confidence: 0.7,
          suggestedAnswer: 'Open to relocation for the right opportunity',
          source: 'derived_preferences',
        };
      }
    }

    return null;
  }

  private calculateTechExperience(profile: MasterProfile, technology: string): number {
    let maxYears = 0;
    
    for (const skill of profile.skills) {
      if (skill.name.toLowerCase().includes(technology) || technology.includes(skill.name.toLowerCase())) {
        maxYears = Math.max(maxYears, skill.yearsExperience);
      }
    }
    
    for (const exp of profile.experience) {
      const expText = `${exp.title} ${exp.description} ${exp.technologies.join(' ')}`.toLowerCase();
      if (expText.includes(technology)) {
        const years = exp.current 
          ? new Date().getFullYear() - exp.startDate.getFullYear()
          : exp.endDate!.getFullYear() - exp.startDate.getFullYear();
        maxYears = Math.max(maxYears, years);
      }
    }
    
    for (const proj of profile.projects) {
      const projText = `${proj.name} ${proj.description} ${proj.technologies.join(' ')}`.toLowerCase();
      if (projText.includes(technology)) {
        maxYears = Math.max(maxYears, 1); // At least 1 year for project experience
      }
    }
    
    return maxYears;
  }

  classifyBatch(questions: ApplicationQuestion[], profile: MasterProfile): Map<string, QuestionClassifierResult> {
    const results = new Map<string, QuestionClassifierResult>();
    
    for (const q of questions) {
      results.set(q.questionId, this.classify(q.question, profile));
    }
    
    return results;
  }
}
