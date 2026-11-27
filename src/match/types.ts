/**
 * Candidate Matching types.
 */

export interface MatchAnalysis {
  jobId: string;
  overallScore: number; // 0..100
  requiredSkillCoverage: number;
  preferredSkillCoverage: number;
  experienceMatch: number;
  projectRelevance: number;
  cloudPlatformMatch: number;
  educationMatch: number;
  locationMatch: number;
  authorizationCompatibility: number;
  keywordCoverage: number;
  missingRequired: SkillGap[];
  missingPreferred: SkillGap[];
  explanation: string;
  recommendation: 'APPLY' | 'SKIP' | 'REVIEW';
  confidence: number;
  analyzedAt: Date;
}

export interface SkillGap {
  skill: string;
  category: string;
  importance: 'required' | 'preferred' | 'nice-to-have';
  candidateHas: boolean;
  candidateProficiency?: string;
  candidateYears?: number;
  requiredYears?: number;
}

export interface MatchingConfig {
  requiredWeight: number;
  preferredWeight: number;
  niceToHaveWeight: number;
  experienceWeight: number;
  projectWeight: number;
  cloudWeight: number;
  educationWeight: number;
  locationWeight: number;
  authorizationWeight: number;
  keywordWeight: number;
  threshold: number;
}

export interface SkillMatchDetail {
  skill: { name: string; category: string; importance: string; yearsExperience?: number; confidence: number };
  matched: boolean;
  candidateSkill?: { name: string; category: string; proficiency: string; yearsExperience: number; lastUsed: Date; evidence: string[] };
  gap?: SkillGap;
  score: number;
}

export interface ExperienceMatchDetail {
  requirement: { domain: string; minYears: number; preferredYears?: number; details?: string };
  matched: boolean;
  candidateExperience?: { id: string; company: string; title: string; location?: string; remote?: boolean; startDate: Date; endDate?: Date; current: boolean; description: string; achievements: string[]; technologies: string[] };
  score: number;
  yearsMatched: number;
}

export interface ProjectMatchDetail {
  requirement: string;
  matchedProjects: { id: string; name: string; description: string; role: string; technologies: string[]; startDate?: Date; endDate?: Date; url?: string; repository?: string; highlights: string[]; metrics?: Record<string, string | number> }[];
  score: number;
}
