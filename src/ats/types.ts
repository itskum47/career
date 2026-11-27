/**
 * ATS Validation types.
 */

export interface ATSScore {
  overall: number;
  keywordCoverage: number;
  skillCoverage: number;
  experienceRelevance: number;
  sectionStructure: number;
  formatting: number;
  parsing: number;
  readability: number;
  jdAlignment: number;
  details: ATSScoreDetail[];
  passed: boolean;
  validatedAt: Date;
}

export interface ATSScoreDetail {
  criterion: string;
  score: number;
  maxScore: number;
  weight: number;
  notes?: string;
}

export interface ResumeSection {
  type: 'header' | 'summary' | 'skills' | 'experience' | 'projects' | 'education' | 'certifications' | 'achievements' | 'custom';
  title: string;
  content: string;
  order: number;
  emphasis?: 'high' | 'medium' | 'low';
}

export interface JobDescription {
  jobId: string;
  company: string;
  title: string;
  location: string;
  remote: boolean;
  remotePolicy?: string;
  seniority: string;
  employmentType: string;
  requiredSkills: { name: string; category: string; importance: string; yearsExperience?: number; confidence: number }[];
  preferredSkills: { name: string; category: string; importance: string; yearsExperience?: number; confidence: number }[];
  niceToHaveSkills: { name: string; category: string; importance: string; yearsExperience?: number; confidence: number }[];
  responsibilities: string[];
  experienceRequirements: { domain: string; minYears: number; preferredYears?: number; details?: string }[];
  educationRequirements: { degree: string; field?: string; required: boolean }[];
  certifications: string[];
  cloudPlatforms: string[];
  programmingLanguages: string[];
  devopsTools: string[];
  cicdTools: string[];
  monitoringTools: string[];
  databases: string[];
  securityRequirements: string[];
  keywords: string[];
  salary?: { min?: number; max?: number; currency: string; period: string; negotiable: boolean };
  visaRequirements?: { sponsorship: boolean; details?: string };
  applicationQuestions: { question: string; type: string; required: boolean; options?: string[] }[];
  otherConstraints: string[];
  fullText: string;
  extractedAt: Date;
  confidence: number;
  sourceUrl: string;
  extractionMethod: string;
}

export interface ATSValidationInput {
  resumeSections: ResumeSection[];
  jobDescription: JobDescription;
  format: 'pdf' | 'docx' | 'html' | 'json' | 'text';
  content: string;
}

export interface ATSValidationResult {
  score: ATSScore;
  passed: boolean;
  revisionNeeded: boolean;
  revisionSuggestions: string[];
}
