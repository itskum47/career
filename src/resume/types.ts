/**
 * Resume Generation types.
 */

export type ResumeSectionType =
  | 'header'
  | 'summary'
  | 'skills'
  | 'experience'
  | 'projects'
  | 'education'
  | 'certifications'
  | 'achievements'
  | 'custom';

export interface ResumeSection {
  type: ResumeSectionType;
  title: string;
  content: string;
  order: number;
  emphasis?: 'high' | 'medium' | 'low';
}

export interface ResumeVersion {
  resumeId: string;
  jobId: string;
  applicationId?: string;
  candidateId: string;
  version: number;
  format: 'pdf' | 'docx' | 'html' | 'json' | 'latex';
  filePath: string;
  atsScore?: ATSScore;
  generatedAt: Date;
  generatorVersion: string;
  /** Phase 9 — profile content hash this artifact was generated from. */
  profileVersion?: string;
}

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

export interface ResumeGenerationInput {
  profile: any; // MasterProfile
  jobDescription: any; // JobDescription
  matchAnalysis: any; // MatchAnalysis
  templateId?: string;
}

export interface ResumeGenerationResult {
  resume: ResumeVersion;
  sections: ResumeSection[];
  atsScore: ATSScore;
  warnings: string[];
}

export interface ResumeTemplate {
  id: string;
  name: string;
  sections: ResumeSectionType[];
  format: 'pdf' | 'docx' | 'html' | 'json' | 'latex';
}

export interface TailoringDecision {
  section: ResumeSectionType;
  action: 'emphasize' | 'deemphasize' | 'reorder' | 'rewrite' | 'add' | 'remove';
  reason: string;
  confidence: number;
}
