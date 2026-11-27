/**
 * Database types and schema definitions.
 */

import type { JobId, ApplicationId, CandidateId, CompanyId, SessionId } from '../core/types.ts';
import type { DiscoveredJob } from '../discovery/types.ts';
import type { JobDescription } from '../jd/types.ts';
import type { Application, ApplicationEvent, ApplicationState } from '../application/types.ts';
import type { ResumeVersion, CoverLetter } from '../core/types.ts';
import type { MatchAnalysis } from '../match/types.ts';
import type { EmailEvent, EmailClassification } from '../core/types.ts';
import type { Company } from '../core/types.ts';

export interface DatabaseConfig {
  driver: 'sqlite' | 'postgres';
  path?: string;
  url?: string;
  poolMin: number;
  poolMax: number;
  migrateOnStart: boolean;
}

export interface JobRecord {
  id: JobId;
  company: string;
  title: string;
  location: string;
  remote: boolean;
  url: string;
  source: string;
  postedAt?: Date;
  description: string;
  salary?: string;
  employmentType?: string;
  seniority?: string;
  rawData?: Record<string, unknown>;
  discoveredAt: Date;
  updatedAt: Date;
}

export interface JobDescriptionRecord {
  id: string;
  jobId: JobId;
  company: string;
  title: string;
  location: string;
  remote: boolean;
  remotePolicy?: string;
  seniority: string;
  employmentType: string;
  requiredSkills: any;
  preferredSkills: any;
  niceToHaveSkills: any;
  responsibilities: any;
  experienceRequirements: any;
  educationRequirements: any;
  certifications: any;
  cloudPlatforms: any;
  programmingLanguages: any;
  devopsTools: any;
  cicdTools: any;
  monitoringTools: any;
  databases: any;
  securityRequirements: any;
  keywords: any;
  salary?: any;
  visaRequirements?: any;
  applicationQuestions: any;
  otherConstraints: any;
  fullText: string;
  extractedAt: Date;
  confidence: number;
  sourceUrl: string;
  extractionMethod: string;
  verified: boolean;
  verifiedAt?: Date;
}

export interface ApplicationRecord {
  id: ApplicationId;
  jobId: JobId;
  candidateId: CandidateId;
  companyId: CompanyId;
  state: ApplicationState;
  status: string;
  resumeId?: string;
  coverLetterId?: string;
  browserSessionId?: SessionId;
  confirmationId?: string;
  submittedAt?: Date;
  confirmedAt?: Date;
  error?: string;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
  nextAction?: string;
  nextActionAt?: Date;
}

export interface ApplicationEventRecord {
  id: string;
  applicationId: ApplicationId;
  type: string;
  fromState?: string;
  toState: string;
  agent?: string;
  message: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

export interface ResumeRecord {
  id: string;
  jobId: JobId;
  applicationId?: ApplicationId;
  version: number;
  format: string;
  filePath: string;
  atsScore?: any;
  generatedAt: Date;
  generatorVersion: string;
}

export interface CoverLetterRecord {
  id: string;
  jobId: JobId;
  applicationId?: ApplicationId;
  content: string;
  filePath?: string;
  generatedAt: Date;
  templateId?: string;
}

export interface EmailEventRecord {
  id: string;
  applicationId?: ApplicationId;
  from: string;
  to: string[];
  subject: string;
  body: string;
  receivedAt: Date;
  classification: EmailClassification;
  processed: boolean;
  linkedApplicationId?: ApplicationId;
}

export interface CompanyRecord {
  id: CompanyId;
  name: string;
  domain?: string;
  careerUrl?: string;
  atsPlatform?: string;
  size?: string;
  industry?: string;
  location?: string;
  notes?: string;
  blacklisted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface MatchAnalysisRecord {
  id: string;
  jobId: JobId;
  overallScore: number;
  requiredSkillCoverage: number;
  preferredSkillCoverage: number;
  experienceMatch: number;
  projectRelevance: number;
  cloudPlatformMatch: number;
  educationMatch: number;
  locationMatch: number;
  authorizationCompatibility: number;
  keywordCoverage: number;
  missingRequired: any;
  missingPreferred: any;
  explanation: string;
  recommendation: string;
  confidence: number;
  analyzedAt: Date;
}
