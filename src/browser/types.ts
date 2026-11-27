/**
 * Browser Automation types.
 */

export interface BrowserConfig {
  profilePath: string;
  headless: boolean;
  slowMo: number;
  defaultTimeout: number;
  navigationTimeout: number;
  viewport: { width: number; height: number };
  userAgent?: string;
  locale: string;
  timezoneId: string;
}

export interface BrowserActionResult {
  success: boolean;
  error?: string;
  data?: unknown;
  screenshot?: string;
}

export interface NavigationResult extends BrowserActionResult {
  url: string;
  title: string;
  pageState?: PageState;
}

export interface FormFillResult extends BrowserActionResult {
  filledFields: number;
  failedFields: FormFieldError[];
}

export interface FormFieldError {
  field: FormField;
  error: string;
}

export interface FileUploadResult extends BrowserActionResult {
  filePath: string;
  fieldName: string;
}

/** One `input[type=file]` as scanned from the page (identity = index + id + name). */
export interface FileInputMeta {
  index: number;
  id: string;
  name: string;
  accept: string;
}

/**
 * Outcome of one attachment through the site's own upload lifecycle. `committed`
 * means the upload response succeeded AND the site rendered the attachment —
 * never just "files were set on the input".
 */
export interface AttachmentUploadResult {
  kind: 'resume' | 'cover_letter';
  inputId: string;
  inputIndex: number;
  filePath: string;
  expectedName: string;
  fileAttached: boolean;
  uploadObserved: boolean;
  uploadStatus: number | null;
  uploadHost: string | null;
  uploadPath: string | null;
  chipPresent: boolean;
  committed: boolean;
  /**
   * `committed` — upload response succeeded AND the site rendered the attachment.
   * `failed`    — positive failure evidence (rejected upload, or 2xx with no render).
   * `unknown`   — no separate upload request observed; the site most likely posts
   *               the files with the form, so nothing failed and nothing is asserted.
   */
  verdict: 'committed' | 'failed' | 'unknown';
  error?: string;
}

export interface SubmissionResult extends BrowserActionResult {
  confirmationId?: string;
  confirmationUrl?: string;
  submitted: boolean;
  uncertain: boolean;
  /**
   * Phase 6W/6X — post-click transport inventory (secret-free): one entry per
   * non-GET request/response observed after the click, with method, host, path,
   * status, resource type and elapsed ms. NEVER contains headers, cookies,
   * payloads, tokens or query strings.
   */
  transport?: SubmissionTransportEntry[];
}

/** One observed submission-transport event (safe to log/journal). */
export interface SubmissionTransportEntry {
  event: 'request' | 'response';
  method: string;
  host: string;
  path: string;
  status: number | null;
  resourceType: string | null;
  elapsedMs: number;
  /** Safe redirect target (host+path only) when the response was a redirect. */
  redirect?: string | null;
  isRedirect?: boolean;
}

export interface BrowserSessionStateSnapshot {
  sessionId: string;
  applicationId: string;
  url: string;
  cookies: BrowserCookie[];
  localStorage: Record<string, string>;
  screenshotPath: string;
  pageState: PageState;
  timestamp: Date;
}

export interface ATSSignature {
  name: string;
  selectors: string[];
  urlPatterns: string[];
  indicators: string[];
}

// Re-export from core types
export interface BrowserSession {
  sessionId: string;
  applicationId: string;
  jobId: string;
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
