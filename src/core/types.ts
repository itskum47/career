/**
 * Core type definitions for the job-agent system.
 * All agents share these types for structured communication.
 */

// ============================================================================
// Primitive branded types
// ============================================================================
export type Brand<T, B> = T & { readonly __brand: unique symbol };
export type JobId = Brand<string, 'JobId'>;
export type ApplicationId = Brand<string, 'ApplicationId'>;
export type CandidateId = Brand<string, 'CandidateId'>;
export type CompanyId = Brand<string, 'CompanyId'>;
export type SessionId = Brand<string, 'SessionId'>;

export function jobId(s: string): JobId { return s as JobId; }
export function applicationId(s: string): ApplicationId { return s as ApplicationId; }
export function candidateId(s: string): CandidateId { return s as CandidateId; }
export function companyId(s: string): CompanyId { return s as CompanyId; }
export function sessionId(s: string): SessionId { return s as SessionId; }

// ============================================================================
// Agent Communication
// ============================================================================
export interface AgentResult<T = unknown> {
  agent: string;
  jobId?: JobId;
  applicationId?: ApplicationId;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'BLOCKED' | 'ESCALATED';
  result?: T;
  confidence: number; // 0..1
  errors: AgentError[];
  durationMs: number;
  metadata?: Record<string, unknown>;
}

export interface AgentError {
  code: string;
  message: string;
  recoverable: boolean;
  context?: Record<string, unknown>;
}

export interface AgentEnvelope<T = unknown> {
  type: 'agent_result' | 'agent_progress' | 'agent_escalation';
  payload: T;
  timestamp: string;
  correlationId: string;
}

// ============================================================================
// Job Discovery
// ============================================================================
export interface DiscoveredJob {
  jobId: JobId;
  company: string;
  title: string;
  location: string;
  remote: boolean;
  remotePolicy?: RemotePolicy;
  url: string;
  source: JobSource;
  postedAt?: Date;
  description: string;
  salary?: string;
  employmentType?: EmploymentType;
  seniority?: Seniority;
  rawData?: Record<string, unknown>;
  // Phase 6R — provenance/route tracking (002 migration columns).
  // "Where was this found?" vs "Where is it applied?"
  sourceJobId?: string;
  discoveredFrom?: string;
  canonicalSource?: string;
  canonicalJobUrl?: string;
  applicationUrl?: string;
  applicationRoute?: string;
  atsType?: string;
  jdHash?: string;
  jdComplete?: boolean;
  canonicalKey?: string;
  dedupeConfidence?: number;
  allowedCountries?: string[];
  priorityScore?: number;
  priorityRank?: number;
}

/**
 * Source ids are validated at runtime against the discovery catalog
 * (src/discovery/catalog.ts) — the catalog is the single source of truth,
 * so this stays `string` instead of a hand-maintained literal union that
 * drifts whenever a legitimate source is added.
 */
export type JobSource = string;

export type EmploymentType =
  | 'full-time'
  | 'part-time'
  | 'contract'
  | 'internship'
  | 'freelance';

export type Seniority =
  | 'intern'
  | 'junior'
  | 'mid'
  | 'senior'
  | 'lead'
  | 'principal'
  | 'staff'
  | 'director'
  | 'vp'
  | 'c-level';

// ============================================================================
// Job Description
// ============================================================================
export interface JobDescription {
  jobId: JobId;
  company: string;
  title: string;
  location: string;
  remote: boolean;
  remotePolicy?: RemotePolicy;
  seniority: Seniority;
  employmentType: EmploymentType;

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

export type RemotePolicy =
  | 'fully-remote'
  | 'hybrid'
  | 'on-site'
  | 'remote-with-travel'
  | 'unspecified';

export interface SkillRequirement {
  name: string;
  category: SkillCategory;
  importance: 'required' | 'preferred' | 'nice-to-have';
  yearsExperience?: number;
  confidence: number;
}

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

export type ExtractionMethod =
  | 'api'
  | 'dom'
  | 'accessibility'
  | 'ats-adapter'
  | 'manual'
  | 'llm';

// ============================================================================
// Candidate Profile
// ============================================================================
/**
 * Phase 9 — provenance and approval metadata carried by the profile itself.
 *
 * `provenance` records where each block came from and how far it has been
 * verified. `approval` is deliberately operator-controlled: the agent refuses
 * real submissions until an approval record matches the ACTIVE profile version
 * (a sha256 content hash), so editing the profile re-locks submissions.
 */
export interface ProfileProvenance {
  source: string;
  sourceLabel?: string;
  sourcePath?: string;
  sourceSha256?: string;
  sourceTextExtract?: string;
  rebuiltAt?: string;
  rebuiltFrom?: string;
  verificationStatus?: string;
  datePrecision?: string;
  datePrecisionUnstated?: string;
  notes?: string[];
  [key: string]: unknown;
}

export interface ProfileApprovalRecord {
  approved: boolean;
  approvedAt?: string | null;
  approvedBy?: string | null;
  /** Must equal the sha256 profile version that is actually active. */
  profileVersion?: string | null;
  note?: string;
}

export interface MasterProfile {
  candidateId: CandidateId;
  personal: PersonalInfo;
  education: EducationEntry[];
  experience: ExperienceEntry[];
  projects: ProjectEntry[];
  skills: SkillEntry[];
  certifications: CertificationEntry[];
  achievements: AchievementEntry[];
  preferences: CandidatePreferences;
  authorization: AuthorizationInfo;
  compensation: CompensationExpectations;
  questionAnswers: QuestionAnswerEntry[];
  version: number;
  updatedAt: Date;
  provenance?: ProfileProvenance;
  approval?: ProfileApprovalRecord;
  /** Phase 9 — sha256 of the profile file, stamped by the loader at load time. */
  profileVersion?: string;
  /** Facts the CV does not settle — surfaced to the operator, never invented. */
  clarificationsRequired?: string[];
  warnings?: string[];
  /**
   * Phase 9 — dotted paths of values that appear in the source document but are
   * NOT verified (e.g. a LinkedIn URL). Generators omit these rather than
   * printing them.
   */
  unverifiedFields?: string[];
  /**
   * Phase 11 — questions the candidate has been asked but not yet answered,
   * parked so the workflow continues with everything else instead of stopping
   * or nagging. A deferred question is NOT resolved and is NOT forgotten: it
   * stays listed until it is answered or explicitly withdrawn.
   */
  awaitingConfirmation?: Array<{
    questionId: string;
    field: string;
    deferredAt: string;
    note: string;
  }>;
  /**
   * Phase 11 — local documents that disagree with the profile's primary source.
   * Recorded so a conflict is surfaced, never silently adopted and never
   * silently discarded. Each entry says what disagrees and how it was handled.
   */
  conflictingEvidence?: Array<{
    document: string;
    locator: string;
    sha256?: string;
    trust: 'credential_record' | 'candidate_asserted' | 'catalog' | 'unattributable';
    disagreements: string[];
    handling: string;
    recordedAt: string;
  }>;
}

export interface PersonalInfo {
  fullName: string;
  email: string;
  phone: string;
  location: string;
  linkedin?: string;
  github?: string;
  portfolio?: string;
  summary: string;
  pronouns?: string;
  website?: string;
  /** Phase 9: field-by-field source of truth (e.g. which CV line it came from). */
  fieldProvenance?: Record<string, string>;
}

export interface EducationEntry {
  id: string;
  degree: string;
  field: string;
  institution: string;
  location?: string;
  /** Null when the source document does not state the date — never guessed. */
  startDate: Date | null;
  endDate?: Date | null;
  gpa?: string;
  honors?: string[];
  relevantCoursework?: string[];
  fieldProvenance?: Record<string, string>;
}

export interface ExperienceEntry {
  id: string;
  company: string;
  title: string;
  location?: string;
  remote?: boolean;
  startDate: Date;
  endDate?: Date | null;
  current: boolean;
  description: string;
  achievements: string[];
  technologies: string[];
  teamSize?: number;
  roleScope?: string;
  fieldProvenance?: Record<string, string>;
}

export interface ProjectEntry {
  id: string;
  name: string;
  description: string;
  role: string;
  technologies: string[];
  startDate?: Date | null;
  endDate?: Date | null;
  url?: string;
  repository?: string;
  highlights: string[];
  metrics?: Record<string, string | number>;
  fieldProvenance?: Record<string, string>;
}

export interface SkillEntry {
  name: string;
  category: SkillCategory;
  proficiency: ProficiencyLevel;
  yearsExperience: number;
  lastUsed: Date;
  evidence: string[]; // references to experience/project IDs
  certifications?: string[];
}

export type ProficiencyLevel =
  | 'expert'
  | 'advanced'
  | 'intermediate'
  | 'beginner'
  | 'learning';

/**
 * Phase 9 — a certification may be a real, verifiable credential OR only a
 * generic category label lifted from the CV ("AWS Certification"). `verified`
 * and `clarificationRequired` keep that distinction explicit: an unverified or
 * generic entry must never be rendered as an earned credential.
 */
export interface CertificationEntry {
  id: string;
  name: string;
  issuer: string;
  /** Null when the source document states no issue date — never guessed. */
  issueDate: Date | null;
  expiryDate?: Date;
  credentialId?: string;
  credentialUrl?: string;
  verified?: boolean;
  clarificationRequired?: boolean;
  provenance?: string;
  note?: string;
}

export interface AchievementEntry {
  id: string;
  title: string;
  description: string;
  date: Date;
  category: 'award' | 'publication' | 'speaking' | 'patent' | 'project' | 'other';
  url?: string;
  impact?: string;
}

export interface CandidatePreferences {
  targetRoles: string[];
  targetSeniority: Seniority[];
  targetLocations: string[];
  remotePreference: RemotePolicy[];
  excludeLocations?: string[];
  excludeCompanies?: string[];
  excludeKeywords?: string[];
  minSalary?: number;
  currency: string;
  noticePeriodDays: number;
  availableFrom?: Date;
  workAuthorization: WorkAuthorization[];
  visaStatus?: VisaStatus;
  fieldProvenance?: Record<string, string>;
}

export type WorkAuthorization =
  | 'citizen'
  | 'permanent-resident'
  | 'work-visa'
  | 'student-visa'
  | 'requires-sponsorship'
  | 'not-authorized';

export type VisaStatus =
  | 'none'
  | 'h1b'
  | 'l1'
  | 'o1'
  | 'tn'
  | 'e3'
  | 'f1-opt'
  | 'f1-cpt'
  | 'j1'
  | 'other';

export interface AuthorizationInfo {
  countries: string[];
  workAuthorizations: WorkAuthorization[];
  requiresSponsorship: boolean;
  visaDetails?: string;
  fieldProvenance?: Record<string, string>;
}

export interface CompensationExpectations {
  minBase: number;
  targetBase: number;
  maxBase?: number;
  currency: string;
  equityExpectation?: string;
  benefitsPriorities: string[];
  fieldProvenance?: Record<string, string>;
}

export interface QuestionAnswerEntry {
  questionHash: string;
  question: string;
  answer: string;
  category: QuestionCategory;
  source: AnswerSource;
  answeredAt: Date;
  expiresAt?: Date;
  confidence: number;
  usedCount: number;
}

export type QuestionCategory =
  | 'personal'
  | 'experience'
  | 'skills'
  | 'education'
  | 'authorization'
  | 'compensation'
  | 'legal'
  | 'behavioral'
  | 'technical'
  | 'other';

export type AnswerSource =
  | 'profile'
  | 'derived'
  | 'user-provided'
  | 'default'
  | 'cached';

// ============================================================================
// Candidate Matching
// ============================================================================
export interface MatchAnalysis {
  matchId: string;
  jobId: JobId;
  candidateId: CandidateId;
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
  category: SkillCategory;
  importance: 'required' | 'preferred' | 'nice-to-have';
  candidateHas: boolean;
  candidateProficiency?: ProficiencyLevel;
  candidateYears?: number;
  requiredYears?: number;
}

// ============================================================================
// Resume / CV
// ============================================================================
export interface ResumeVersion {
  resumeId: string;
  jobId: JobId;
  applicationId?: ApplicationId;
  candidateId: CandidateId;
  version: number;
  format: 'pdf' | 'docx' | 'html' | 'json' | 'latex';
  filePath: string;
  atsScore?: ATSScore;
  generatedAt: Date;
  generatorVersion: string;
  /**
   * Phase 9 — the profile content hash this artifact was generated from. An
   * artifact whose profileVersion differs from the active profile is stale and
   * must not be uploaded.
   */
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

export interface ResumeSection {
  type: ResumeSectionType;
  title: string;
  content: string;
  order: number;
  emphasis?: 'high' | 'medium' | 'low';
}

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

// ============================================================================
// Cover Letter
// ============================================================================
export interface CoverLetter {
  coverLetterId: string;
  jobId: JobId;
  applicationId?: ApplicationId;
  candidateId: CandidateId;
  content: string;
  filePath?: string;
  generatedAt: Date;
  templateId?: string;
  /** Phase 9 — profile content hash this letter was generated from. */
  profileVersion?: string;
}

// ============================================================================
// Browser Automation
// ============================================================================
export interface BrowserSession {
  sessionId: SessionId;
  applicationId: ApplicationId;
  jobId: JobId;
  url: string;
  state: BrowserSessionState;
  cookies: BrowserCookie[];
  localStorage: Record<string, string>;
  screenshotPaths: string[];
  createdAt: Date;
  updatedAt: Date;
  pageState?: PageState;
}

export type BrowserSessionState =
  | 'navigating'
  | 'loading'
  | 'analyzing'
  | 'filling'
  | 'paused'
  | 'submitting'
  | 'completed'
  | 'failed'
  | 'blocked';

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict' | 'lax' | 'none';
}

export interface PageState {
  url: string;
  title: string;
  html: string;
  accessibilityTree: AccessibilityNode[];
  forms: FormField[];
  buttons: ButtonElement[];
  links: LinkElement[];
  capturedAt: Date;
}

export interface AccessibilityNode {
  role: string;
  name?: string;
  description?: string;
  value?: string;
  states: string[];
  children: AccessibilityNode[];
  uid: string;
  boundingBox?: BoundingBox;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FormField {
  uid: string;
  label: string;
  type: FormFieldType;
  name?: string;
  id?: string;
  placeholder?: string;
  required: boolean;
  options?: string[];
  value?: string;
  confidence: number;
  source: FieldSource;
  mappedProfileField?: string;
  validationErrors?: string[];
}

export type FormFieldType =
  | 'text'
  | 'email'
  | 'tel'
  | 'url'
  | 'textarea'
  | 'select'
  | 'multiselect'
  | 'checkbox'
  | 'radio'
  | 'file'
  | 'date'
  | 'number'
  | 'hidden'
  | 'submit'
  | 'button'
  | 'password'
  | 'search';

export type FieldSource =
  | 'label'
  | 'aria-label'
  | 'placeholder'
  | 'nearby-text'
  | 'dom-relationship'
  | 'semantic'
  | 'llm-inferred';

export interface ButtonElement {
  uid: string;
  text: string;
  type: 'submit' | 'button' | 'link' | 'next' | 'back' | 'continue' | 'upload' | 'other';
  enabled: boolean;
  primary: boolean;
}

export interface LinkElement {
  uid: string;
  text: string;
  href: string;
  external: boolean;
}

// ============================================================================
// Application Engine
// ============================================================================
export interface Application {
  applicationId: ApplicationId;
  jobId: JobId;
  candidateId: CandidateId;
  companyId: CompanyId;
  state: ApplicationState;
  status: ApplicationStatus;
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
  // Phase 6R — discovery/route provenance (columns added in 002 migration).
  discoveredFrom?: string;
  canonicalSource?: string;
  applicationRoute?: string;
  atsType?: string;
  applicationUrl?: string;
  sourceJobId?: string;
  canonicalKey?: string;
  loginInterrupted?: boolean;
  captchaInterrupted?: boolean;
}

export type ApplicationState =
  | 'DISCOVERED'
  | 'VERIFIED'
  | 'ANALYZED'
  | 'MATCHED'
  | 'SKIPPED'
  | 'RESUME_GENERATED'
  | 'RESUME_VALIDATED'
  | 'READY_TO_APPLY'
  | 'BROWSER_STARTED'
  | 'FORM_ANALYZING'
  | 'FORM_FILLING'
  | 'PAUSED_FOR_USER'
  | 'READY_TO_SUBMIT'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'REJECTED'
  | 'INTERVIEW'
  | 'ASSESSMENT'
  | 'OFFER'
  | 'WITHDRAWN'
  | 'BLOCKED'
  | 'SUBMISSION_UNCERTAIN'
  | 'ERROR';

export type ApplicationStatus =
  | 'pending'
  | 'in_progress'
  | 'submitted'
  | 'confirmed'
  | 'rejected'
  | 'interviewing'
  | 'assessment'
  | 'offer'
  | 'withdrawn'
  | 'paused'
  | 'blocked'
  | 'error'
  | 'skipped';

export interface ApplicationEvent {
  eventId: string;
  applicationId: ApplicationId;
  type: ApplicationEventType;
  fromState?: ApplicationState;
  toState: ApplicationState;
  agent?: string;
  message: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

export type ApplicationEventType =
  | 'state_transition'
  | 'agent_started'
  | 'agent_completed'
  | 'agent_failed'
  | 'human_escalation'
  | 'user_answer_received'
  | 'form_field_filled'
  | 'field_fill_failed'
  | 'document_uploaded'
  | 'submission_attempted'
  | 'submission_confirmed'
  | 'submission_failed'
  | 'email_received'
  | 'status_changed'
  | 'retry'
  | 'recovery';

export interface ApplicationQuestion {
  questionId: string;
  applicationId: ApplicationId;
  question: string;
  type: ApplicationQuestionType;
  required: boolean;
  options?: string[];
  category: QuestionCategory;
  classification: QuestionClassification;
  answer?: QuestionAnswer;
  askedAt: Date;
  answeredAt?: Date;
}

export type ApplicationQuestionType =
  | 'text'
  | 'select'
  | 'multiselect'
  | 'boolean'
  | 'file'
  | 'number'
  | 'date';

export type QuestionClassification =
  | 'KNOWN'
  | 'DERIVABLE'
  | 'USER_REQUIRED'
  | 'UNSAFE_TO_GUESS';

export interface QuestionAnswer {
  value: string;
  source: AnswerSource;
  confidence: number;
  providedBy?: 'user' | 'agent' | 'cached';
}

// ============================================================================
// Email Monitoring
// ============================================================================
export interface EmailEvent {
  eventId: string;
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

export type EmailClassification =
  | 'APPLICATION_RECEIVED'
  | 'REJECTION'
  | 'INTERVIEW'
  | 'ASSESSMENT'
  | 'HR_INTERVIEW'
  | 'TECHNICAL_INTERVIEW'
  | 'OFFER'
  | 'DOCUMENT_REQUEST'
  | 'WITHDRAWAL'
  | 'OTHER';

// ============================================================================
// Company
// ============================================================================
export interface Company {
  companyId: CompanyId;
  name: string;
  domain?: string;
  careerUrl?: string;
  atsPlatform?: ATSPlatform;
  size?: string;
  industry?: string;
  location?: string;
  notes?: string;
  blacklisted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type ATSPlatform =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'workday'
  | 'icims'
  | 'smartrecruiters'
  | 'bamboohr'
  | 'taleo'
  | 'custom'
  | 'unknown';

// ============================================================================
// Limits / Configuration
// ============================================================================
export interface SystemLimits {
  maxJobsDiscovered: number;
  maxApplicationsPerDay: number;
  maxBrowserConcurrency: number;
  maxResumeRevisions: number;
  matchThreshold: number;
  atsThreshold: number;
  autoSubmit: boolean;
  scheduleDaily: boolean;
  scheduleTime: string;
}