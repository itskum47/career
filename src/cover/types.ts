/**
 * Cover Letter Generation types.
 */

import type { CoverLetter } from '../core/types.ts';
import type { JobDescription } from '../jd/types.ts';
import type { MatchAnalysis } from '../match/types.ts';
import type { MasterProfile } from '../core/types.ts';

export interface CoverLetterInput {
  profile: MasterProfile;
  jobDescription: JobDescription;
  matchAnalysis: MatchAnalysis;
  tone?: 'professional' | 'enthusiastic' | 'concise' | 'storytelling';
  templateId?: string;
}

export interface CoverLetterResult {
  coverLetter: CoverLetter;
  content: string;
  warnings: string[];
}

export interface CoverLetterTemplate {
  id: string;
  name: string;
  structure: string[]; // section names in order
  tone: string;
}

export type { CoverLetter };
