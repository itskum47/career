/**
 * Candidate Matching Engine - matches job requirements against master profile.
 */

import type { MatchAnalysis, SkillGap, SkillRequirement, SkillCategory, Seniority, JobId } from '../core/types.ts';
import type { JobDescription } from '../jd/types.ts';
import type { MasterProfile, SkillEntry, ExperienceEntry, ProjectEntry } from '../core/types.ts';
import type { MatchingConfig, SkillMatchDetail, ExperienceMatchDetail } from './types.ts';
import { logger } from '../core/logger.ts';
import { trackStage } from '../performance/hooks.ts';
import { STAGES } from '../performance/stages.ts';

const DEFAULT_CONFIG: MatchingConfig = {
  requiredWeight: 0.35,
  preferredWeight: 0.20,
  niceToHaveWeight: 0.10,
  experienceWeight: 0.15,
  projectWeight: 0.10,
  cloudWeight: 0.05,
  educationWeight: 0.02,
  locationWeight: 0.01,
  authorizationWeight: 0.01,
  keywordWeight: 0.01,
  threshold: 60,
};

const SENIORITY_ORDER: Seniority[] = ['intern', 'junior', 'mid', 'senior', 'lead', 'principal', 'staff', 'director', 'vp', 'c-level'];

// Canonical skill names shared with the JD extractor so that a requirement
// for "ci/cd" is satisfied by any candidate skill in that family
// ("github actions", "jenkins", "gitlab ci", ...).
const SKILL_CANONICAL: Record<string, string> = {
  'ci/cd': 'ci-cd', 'ci cd': 'ci-cd', 'continuous integration': 'ci-cd',
  'continuous deployment': 'ci-cd', 'github actions': 'ci-cd', 'gitlab ci': 'ci-cd',
  'jenkins': 'ci-cd', 'circleci': 'ci-cd', 'bamboo': 'ci-cd',
  'istio': 'service-mesh', 'linkerd': 'service-mesh',
  'aws': 'aws', 'amazon web services': 'aws',
  'azure': 'azure', 'microsoft azure': 'azure',
  'gcp': 'gcp', 'google cloud': 'gcp', 'google cloud platform': 'gcp',
  'kubernetes': 'kubernetes', 'k8s': 'kubernetes', 'kube': 'kubernetes',
  'prometheus': 'prometheus', 'grafana': 'grafana', 'datadog': 'datadog',
  'docker': 'docker', 'terraform': 'terraform', 'ansible': 'ansible',
  'go': 'go', 'golang': 'go', 'python': 'python',
  'security': 'security', 'monitoring': 'monitoring', 'logging': 'logging',
};

function canonicalSkill(name: string): string {
  return SKILL_CANONICAL[name.toLowerCase().trim()] || name.toLowerCase().trim();
}

export class CandidateMatcher {
  private config: MatchingConfig;

  constructor(config: Partial<MatchingConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  match(jd: JobDescription, profile: MasterProfile): MatchAnalysis {
    const t = trackStage(STAGES.MATCH_SCORING, { jobId: jd.jobId });
    const skillMatch = this.matchSkills(jd, profile);
    const experienceMatch = this.matchExperience(jd, profile);
    const projectMatch = this.matchProjects(jd, profile);
    const cloudMatch = this.matchCloudPlatforms(jd, profile);
    const educationMatch = this.matchEducation(jd, profile);
    const locationMatch = this.matchLocation(jd, profile);
    const authorizationMatch = this.matchAuthorization(jd, profile);
    const keywordMatch = this.matchKeywords(jd, profile);

    const overallScore = Math.round(
      skillMatch.requiredScore * this.config.requiredWeight +
      skillMatch.preferredScore * this.config.preferredWeight +
      skillMatch.niceToHaveScore * this.config.niceToHaveWeight +
      experienceMatch * this.config.experienceWeight +
      projectMatch * this.config.projectWeight +
      cloudMatch * this.config.cloudWeight +
      educationMatch * this.config.educationWeight +
      locationMatch * this.config.locationWeight +
      authorizationMatch * this.config.authorizationWeight +
      keywordMatch * this.config.keywordWeight
    ) * 100;

    const missingRequired = skillMatch.missingRequired;
    const missingPreferred = skillMatch.missingPreferred;

    const recommendation = this.getRecommendation(overallScore, missingRequired.length);

    const explanation = this.generateExplanation(
      jd, profile, skillMatch, experienceMatch, projectMatch, 
      missingRequired, missingPreferred
    );

    const analysis: MatchAnalysis = {
      matchId: `MATCH-${jd.jobId}-${profile.candidateId}-${Date.now()}`,
      jobId: jd.jobId as JobId,
      candidateId: profile.candidateId,
      overallScore,
      requiredSkillCoverage: Math.round(skillMatch.requiredScore * 100),
      preferredSkillCoverage: Math.round(skillMatch.preferredScore * 100),
      experienceMatch: Math.round(experienceMatch * 100),
      projectRelevance: Math.round(projectMatch * 100),
      cloudPlatformMatch: Math.round(cloudMatch * 100),
      educationMatch: Math.round(educationMatch * 100),
      locationMatch: Math.round(locationMatch * 100),
      authorizationCompatibility: Math.round(authorizationMatch * 100),
      keywordCoverage: Math.round(keywordMatch * 100),
      missingRequired,
      missingPreferred,
      explanation,
      recommendation,
      confidence: this.calculateConfidence(jd, profile, skillMatch),
      analyzedAt: new Date(),
    };

    logger.info('Candidate matching completed', {
      jobId: jd.jobId,
      overallScore,
      recommendation,
      missingRequired: missingRequired.length,
    });

    if (typeof t !== 'undefined') t.end(true);

    return analysis;
  }

  private matchSkills(jd: JobDescription, profile: MasterProfile): {
    requiredScore: number;
    preferredScore: number;
    niceToHaveScore: number;
    missingRequired: SkillGap[];
    missingPreferred: SkillGap[];
    details: SkillMatchDetail[];
  } {
    const details: SkillMatchDetail[] = [];
    const missingRequired: SkillGap[] = [];
    const missingPreferred: SkillGap[] = [];

    // Match required skills
    let requiredMatched = 0;
    for (const reqSkill of jd.requiredSkills) {
      const candidateSkill = this.findCandidateSkill(profile, reqSkill);
      const matched = candidateSkill !== null;
      const score = matched ? this.calculateSkillScore(reqSkill, candidateSkill!) : 0;
      
      details.push({
        skill: reqSkill,
        matched,
        candidateSkill: candidateSkill || undefined,
        gap: !matched ? this.createSkillGap(reqSkill, candidateSkill) : undefined,
        score,
      });

      if (matched) requiredMatched++;
      else missingRequired.push(this.createSkillGap(reqSkill, candidateSkill));
    }

    // Match preferred skills
    let preferredMatched = 0;
    for (const prefSkill of jd.preferredSkills) {
      const candidateSkill = this.findCandidateSkill(profile, prefSkill);
      const matched = candidateSkill !== null;
      const score = matched ? this.calculateSkillScore(prefSkill, candidateSkill!) : 0;
      
      details.push({
        skill: prefSkill,
        matched,
        candidateSkill: candidateSkill || undefined,
        gap: !matched ? this.createSkillGap(prefSkill, candidateSkill) : undefined,
        score,
      });

      if (matched) preferredMatched++;
      else missingPreferred.push(this.createSkillGap(prefSkill, candidateSkill));
    }

    // Nice to have (no penalty for missing)
    let niceToHaveMatched = 0;
    for (const niceSkill of jd.niceToHaveSkills) {
      const candidateSkill = this.findCandidateSkill(profile, niceSkill);
      const matched = candidateSkill !== null;
      if (matched) niceToHaveMatched++;
    }

    const requiredScore = jd.requiredSkills.length > 0 ? requiredMatched / jd.requiredSkills.length : 1;
    const preferredScore = jd.preferredSkills.length > 0 ? preferredMatched / jd.preferredSkills.length : 1;
    const niceToHaveScore = jd.niceToHaveSkills.length > 0 ? niceToHaveMatched / jd.niceToHaveSkills.length : 1;

    return { requiredScore, preferredScore, niceToHaveScore, missingRequired, missingPreferred, details };
  }

  private findCandidateSkill(profile: MasterProfile, reqSkill: SkillRequirement): SkillEntry | null {
    const normalizedReq = reqSkill.name.toLowerCase().trim();
    const canonicalReq = canonicalSkill(normalizedReq);

    for (const skill of profile.skills) {
      const normalizedCandidate = skill.name.toLowerCase().trim();
      const canonicalCandidate = canonicalSkill(normalizedCandidate);

      // Canonical match (e.g. "ci/cd" requirement satisfied by "github actions")
      if (canonicalReq === canonicalCandidate) return skill;

      // Exact match
      if (normalizedCandidate === normalizedReq) return skill;

      // Partial match (e.g., "kubernetes" matches "k8s")
      if (this.skillsAreEquivalent(normalizedReq, normalizedCandidate)) return skill;

      // Category + keyword match
      if (skill.category === reqSkill.category &&
          (normalizedCandidate.includes(normalizedReq) || normalizedReq.includes(normalizedCandidate))) {
        return skill;
      }
    }

    return null;
  }

  private skillsAreEquivalent(s1: string, s2: string): boolean {
    const equivalencies: Record<string, string[]> = {
      'kubernetes': ['k8s', 'kube'],
      'amazon web services': ['aws'],
      'google cloud platform': ['gcp', 'google cloud'],
      'continuous integration': ['ci', 'ci/cd'],
      'continuous deployment': ['cd', 'ci/cd'],
      'infrastructure as code': ['iac', 'terraform'],
      'machine learning': ['ml', 'ai'],
      'artificial intelligence': ['ai', 'ml'],
      'postgresql': ['postgres', 'psql'],
      'javascript': ['js', 'ts', 'typescript'],
      'golang': ['go'],
    };

    for (const [canonical, aliases] of Object.entries(equivalencies)) {
      const all = [canonical, ...aliases];
      if (all.includes(s1) && all.includes(s2)) return true;
    }
    
    return false;
  }

  private calculateSkillScore(reqSkill: SkillRequirement, candidateSkill: SkillEntry): number {
    let score = 1.0;
    
    // Proficiency bonus/penalty
    const proficiencyValues: Record<string, number> = {
      'expert': 1.0,
      'advanced': 0.9,
      'intermediate': 0.7,
      'beginner': 0.5,
      'learning': 0.3,
    };
    score *= proficiencyValues[candidateSkill.proficiency] || 0.5;
    
    // Years experience
    if (reqSkill.yearsExperience && candidateSkill.yearsExperience) {
      const ratio = candidateSkill.yearsExperience / reqSkill.yearsExperience;
      score *= Math.min(1.2, Math.max(0.5, ratio));
    }
    
    return Math.min(1, score);
  }

  private createSkillGap(reqSkill: SkillRequirement, candidateSkill: SkillEntry | null): SkillGap {
    return {
      skill: reqSkill.name,
      category: reqSkill.category,
      importance: reqSkill.importance,
      candidateHas: false,
      candidateProficiency: candidateSkill?.proficiency,
      candidateYears: candidateSkill?.yearsExperience,
      requiredYears: reqSkill.yearsExperience,
    };
  }

  private matchExperience(jd: JobDescription, profile: MasterProfile): number {
    if (jd.experienceRequirements.length === 0) return 1;

    let totalScore = 0;
    for (const req of jd.experienceRequirements) {
      let bestMatch = 0;
      
      for (const exp of profile.experience) {
        const domainMatch = this.stringSimilarity(req.domain.toLowerCase(), exp.title.toLowerCase()) +
                           this.stringSimilarity(req.domain.toLowerCase(), exp.description.toLowerCase()) * 0.5;
        
        if (domainMatch > 0.3) {
          const yearsMatched = Math.min(exp.current ? 
            (new Date().getFullYear() - exp.startDate.getFullYear()) : 
            (exp.endDate!.getFullYear() - exp.startDate.getFullYear()),
            req.minYears
          );
          const yearsScore = req.minYears > 0 ? Math.min(1, yearsMatched / req.minYears) : 1;
          const score = (domainMatch * 0.6) + (yearsScore * 0.4);
          bestMatch = Math.max(bestMatch, score);
        }
      }
      
      totalScore += bestMatch;
    }

    return jd.experienceRequirements.length > 0 ? totalScore / jd.experienceRequirements.length : 1;
  }

  private matchProjects(jd: JobDescription, profile: MasterProfile): number {
    if (profile.projects.length === 0) return 0;
    
    const relevantKeywords = [
      ...jd.cloudPlatforms,
      ...jd.programmingLanguages,
      ...jd.devopsTools,
      ...jd.cicdTools,
      ...jd.databases,
    ].map(k => k.toLowerCase());

    if (relevantKeywords.length === 0) return 0.5;

    let totalRelevance = 0;
    for (const project of profile.projects) {
      const projectText = `${project.name} ${project.description} ${project.technologies.join(' ')}`.toLowerCase();
      const matches = relevantKeywords.filter(k => projectText.includes(k)).length;
      totalRelevance += Math.min(1, matches / Math.max(3, relevantKeywords.length * 0.3));
    }

    return totalRelevance / profile.projects.length;
  }

  private matchCloudPlatforms(jd: JobDescription, profile: MasterProfile): number {
    if (jd.cloudPlatforms.length === 0) return 1;
    
    const candidateClouds = profile.skills
      .filter(s => s.category === 'cloud')
      .map(s => s.name.toLowerCase());
    
    const matches = jd.cloudPlatforms.filter(p => 
      candidateClouds.some(c => this.skillsAreEquivalent(p.toLowerCase(), c))
    ).length;

    return matches / jd.cloudPlatforms.length;
  }

  private matchEducation(jd: JobDescription, profile: MasterProfile): number {
    if (jd.educationRequirements.length === 0) return 1;
    
    let matched = 0;
    for (const req of jd.educationRequirements) {
      for (const edu of profile.education) {
        if (this.stringSimilarity(req.degree.toLowerCase(), edu.degree.toLowerCase()) > 0.7) {
          if (!req.field || this.stringSimilarity(req.field.toLowerCase(), edu.field.toLowerCase()) > 0.5) {
            matched++;
            break;
          }
        }
      }
    }

    return matched / jd.educationRequirements.length;
  }

  private matchLocation(jd: JobDescription, profile: MasterProfile): number {
    if (jd.remotePolicy === 'fully-remote') return 1;
    
    const candidateLocations = profile.preferences.targetLocations.map(l => l.toLowerCase());
    const jobLocation = jd.location.toLowerCase();
    
    if (candidateLocations.some(l => jobLocation.includes(l) || l.includes(jobLocation))) {
      return 1;
    }
    
    // Check remote preference
    if (profile.preferences.remotePreference.includes('fully-remote') || 
        profile.preferences.remotePreference.includes('hybrid')) {
      return 0.8;
    }
    
    return 0.3;
  }

  private matchAuthorization(jd: JobDescription, profile: MasterProfile): number {
    if (!jd.visaRequirements?.sponsorship) return 1;
    
    const requiresSponsorship = profile.authorization.requiresSponsorship;
    const hasValidAuth = profile.authorization.workAuthorizations.some(w => 
      ['citizen', 'permanent-resident', 'work-visa'].includes(w)
    );
    
    if (requiresSponsorship && !hasValidAuth) return 0;
    if (requiresSponsorship && hasValidAuth) return 0.7;
    return 1;
  }

  private matchKeywords(jd: JobDescription, profile: MasterProfile): number {
    if (jd.keywords.length === 0) return 1;
    
    const profileText = [
      profile.personal.summary,
      ...profile.experience.map(e => e.description),
      ...profile.projects.map(p => p.description),
      ...profile.skills.map(s => s.name),
    ].join(' ').toLowerCase();

    const matches = jd.keywords.filter(k => profileText.includes(k.toLowerCase())).length;
    return matches / jd.keywords.length;
  }

  private getRecommendation(score: number, missingRequiredCount: number): 'APPLY' | 'SKIP' | 'REVIEW' {
    // Missing required skills are the hard blocker, but only when the
    // candidate is genuinely unqualified for the role. A candidate who
    // already scores 100 (full coverage) and has only a couple of gaps
    // (e.g. a specific monitoring tool they can pick up) should APPLY.
    if (missingRequiredCount > 2 && score < this.config.threshold) return 'SKIP';
    if (score >= this.config.threshold) return 'APPLY';
    if (score >= this.config.threshold - 15) return 'REVIEW';
    return 'SKIP';
  }

  private generateExplanation(
    jd: JobDescription, 
    profile: MasterProfile,
    skillMatch: any,
    experienceMatch: number,
    projectMatch: number,
    missingRequired: SkillGap[],
    missingPreferred: SkillGap[]
  ): string {
    const parts: string[] = [];
    
    parts.push(`Overall match based on ${jd.requiredSkills.length} required skills, ${jd.preferredSkills.length} preferred skills.`);
    
    if (missingRequired.length > 0) {
      parts.push(`Missing required: ${missingRequired.map(g => g.skill).join(', ')}.`);
    }
    
    if (missingPreferred.length > 0) {
      parts.push(`Missing preferred: ${missingPreferred.map(g => g.skill).join(', ')}.`);
    }
    
    parts.push(`Experience match: ${Math.round(experienceMatch * 100)}%.`);
    parts.push(`Project relevance: ${Math.round(projectMatch * 100)}%.`);
    
    return parts.join(' ');
  }

  private calculateConfidence(jd: JobDescription, profile: MasterProfile, skillMatch: any): number {
    let confidence = 0.5;
    
    // More skills = more confidence
    const totalJDSkills = jd.requiredSkills.length + jd.preferredSkills.length;
    if (totalJDSkills > 10) confidence += 0.2;
    else if (totalJDSkills > 5) confidence += 0.1;
    
    // Profile completeness
    if (profile.skills.length > 20) confidence += 0.15;
    if (profile.experience.length > 3) confidence += 0.1;
    if (profile.projects.length > 3) confidence += 0.1;
    
    // JD quality
    if (jd.confidence > 0.8) confidence += 0.15;
    
    return Math.max(0, Math.min(1, confidence));
  }

  private stringSimilarity(s1: string, s2: string): number {
    if (s1 === s2) return 1;
    if (!s1 || !s2) return 0;
    
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    
    // Simple substring check
    if (longer.includes(shorter)) return 0.8;
    
    // Jaccard similarity on words
    const words1 = new Set(s1.split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(s2.split(/\s+/).filter(w => w.length > 2));
    const intersection = new Set([...words1].filter(w => words2.has(w)));
    const union = new Set([...words1, ...words2]);
    
    return union.size > 0 ? intersection.size / union.size : 0;
  }
}
