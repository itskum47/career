/**
 * Job Description extraction and analysis types.
 */

export type SkillCategory =
  | 'cloud'
  | 'containerization'
  | 'ci-cd'
  | 'infrastructure-as-code'
  | 'monitoring'
  | 'scripting'
  | 'programming'
  | 'database'
  | 'networking'
  | 'security'
  | 'soft'
  | 'other';

export type RemotePolicy =
  | 'fully-remote'
  | 'hybrid'
  | 'on-site'
  | 'remote-with-travel'
  | 'unspecified';

export type ExtractionMethod =
  | 'api'
  | 'dom'
  | 'accessibility'
  | 'ats-adapter'
  | 'manual'
  | 'llm';

export interface SkillRequirement {
  name: string;
  category: SkillCategory;
  importance: 'required' | 'preferred' | 'nice-to-have';
  yearsExperience?: number;
  confidence: number;
}

export interface ExperienceRequirement {
  domain: string;
  minYears: number;
  preferredYears?: number;
  details?: string;
}

export interface EducationRequirement {
  degree: string;
  field?: string;
  required: boolean;
}

export interface SalaryRange {
  min?: number;
  max?: number;
  currency: string;
  period: 'yearly' | 'monthly' | 'hourly';
  negotiable: boolean;
}

export interface VisaRequirement {
  sponsorship: boolean;
  details?: string;
}

export interface ApplicationQuestion {
  question: string;
  type: 'text' | 'select' | 'multiselect' | 'boolean' | 'file' | 'number' | 'date';
  required: boolean;
  options?: string[];
  sourceField?: string;
}

export interface JobDescription {
  jobId: string;
  company: string;
  title: string;
  location: string;
  remote: boolean;
  remotePolicy?: RemotePolicy;
  seniority: string;
  employmentType: string;

  requiredSkills: SkillRequirement[];
  preferredSkills: SkillRequirement[];
  niceToHaveSkills: SkillRequirement[];

  responsibilities: string[];
  experienceRequirements: ExperienceRequirement[];
  educationRequirements: EducationRequirement[];
  certifications: string[];

  cloudPlatforms: string[];
  programmingLanguages: string[];
  devopsTools: string[];
  cicdTools: string[];
  monitoringTools: string[];
  databases: string[];
  securityRequirements: string[];

  keywords: string[];
  salary?: SalaryRange;
  visaRequirements?: VisaRequirement;
  applicationQuestions: ApplicationQuestion[];
  otherConstraints: string[];

  fullText: string;
  extractedAt: Date;
  confidence: number;
  sourceUrl: string;
  extractionMethod: ExtractionMethod;
}

export interface JDExtractionInput {
  html: string;
  url: string;
  accessibilityTree?: any;
  metadata?: Record<string, unknown>;
}

export interface JDExtractionResult {
  jobDescription: JobDescription;
  confidence: number;
  extractionMethod: string;
  warnings: string[];
}

export interface JDVerificationResult {
  verified: boolean;
  confidence: number;
  issues: string[];
  complete: boolean;
}

export interface JDAnalysisResult {
  requiredSkills: SkillRequirement[];
  preferredSkills: SkillRequirement[];
  niceToHaveSkills: SkillRequirement[];
  responsibilities: string[];
  experienceRequirements: ExperienceRequirement[];
  educationRequirements: EducationRequirement[];
  cloudPlatforms: string[];
  programmingLanguages: string[];
  devopsTools: string[];
  cicdTools: string[];
  monitoringTools: string[];
  databases: string[];
  securityRequirements: string[];
  keywords: string[];
  seniority: string;
  remotePolicy: string;
  employmentType: string;
  salary?: { min?: number; max?: number; currency: string; period: string; negotiable: boolean };
  visaRequirements?: { sponsorship: boolean; details?: string };
  applicationQuestions: Array<{ question: string; type: string; required: boolean; options?: string[] }>;
  otherConstraints: string[];
}

export interface DeduplicationResult {
  isDuplicate: boolean;
  existingJobId?: string;
  similarity: number;
  reason: string;
}
