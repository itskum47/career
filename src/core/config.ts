/**
 * Configuration loader with environment variable support.
 * Single source of truth for all settings.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { SystemLimits } from './types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface AppConfig {
  llm: LLMConfig;
  database: DatabaseConfig;
  redis: RedisConfig;
  browser: BrowserConfig;
  application: ApplicationConfig;
  scheduling: SchedulingConfig;
  observability: ObservabilityConfig;
  desktop: DesktopConfig;
  testing: TestingConfig;
  limits: SystemLimits;
  cache: CacheConfig;
}

export interface LLMConfig {
  provider: 'anthropic' | 'openai' | 'custom' | 'mock';
  apiKey: string;
  baseUrl?: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  maxRetries: number;
}

export interface DatabaseConfig {
  driver: 'sqlite' | 'postgres';
  path?: string;
  url?: string;
  poolMin: number;
  poolMax: number;
  migrateOnStart: boolean;
}

export interface RedisConfig {
  url: string;
  enabled: boolean;
  keyPrefix: string;
}

export interface BrowserConfig {
  profilePath: string;
  headless: boolean;
  slowMo: number;
  backend: 'playwright' | 'obscura';
  obscuraBin: string;
  obscuraPort: number;
  obscuraStealth: boolean;
  defaultTimeout: number;
  navigationTimeout: number;
  userAgent?: string;
  viewport: { width: number; height: number };
  locale: string;
  timezoneId: string;
}

export interface ApplicationConfig {
  autoSubmit: boolean;
  maxConcurrentApplications: number;
  /** Phase 8: require an explicit per-application approval before any Submit click. */
  requireApproval: boolean;
  /** Phase 8: the single job id the operator approved (approval is per application). */
  approvedJobId?: string;
  /** Phase 8: attestation/sensitive blockers found while screening the form. */
  approvalBlockers: string[];
  /** Phase 8: keep the (visible) browser open while the operator approves. */
  awaitOperatorApprovalMs: number;
  /** Phase 8: the single uncertain job whose retry the operator may authorise. */
  allowUncertainRetryJobId?: string;
  resumeRevisionLimit: number;
  matchThreshold: number;
  atsThreshold: number;
  pauseOnUncertain: boolean;
  verifySubmission: boolean;
  submissionTimeoutMs: number;
  defaultApplicationUrl: string;
  /**
   * How long an application waits for human escalation answers (6Q).
   * 0 (default) = legacy behavior: return immediately with empty answers.
   * >0 = poll the escalation store until every REQUIRED question is answered
   * or the timeout elapses (then pause for the user instead of submitting).
   */
  escalationWaitMs: number;
}

export interface SchedulingConfig {
  daily: boolean;
  time: string; // HH:mm
  timezone: string;
  discoveryWorkers: number;
  analysisWorkers: number;
  generationWorkers: number;
  browserWorkers: number;
}

export interface ObservabilityConfig {
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logDir: string;
  structuredLogs: boolean;
  metricsEnabled: boolean;
  metricsPort: number;
}

export interface DesktopConfig {
  basePath: string;
  cvOutputDir: string;
  excelPath: string;
}

export interface TestingConfig {
  mockLLM: boolean;
  fakeATSPort: number;
  testDataDir: string;
  verboseDatabase: boolean;
}

export interface CacheConfig {
  llmEnabled: boolean;
  llmTtlSeconds: number;
  jdEnabled: boolean;
  matchEnabled: boolean;
  artifactEnabled: boolean;
  excelSyncDebounceMs: number;
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) {
    return path.join(process.env.HOME || '', p.slice(2));
  }
  return p;
}

function parseIntEnv(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

function parseBoolEnv(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (!v) return fallback;
  return v === '1' || v.toLowerCase() === 'true';
}

function parseStringEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function loadDotEnv(): void {
  const envPath = path.resolve(__dirname, '../../.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
        process.env[key] = value;
      }
    }
  }
}

loadDotEnv();

export const config: AppConfig = {
  llm: {
    provider: parseStringEnv('LLM_PROVIDER', 'anthropic') as LLMConfig['provider'],
    apiKey: parseStringEnv('ANTHROPIC_API_KEY', '') || parseStringEnv('OPENAI_API_KEY', '') || parseStringEnv('LLM_API_KEY', ''),
    baseUrl: parseStringEnv('ANTHROPIC_BASE_URL', '') || parseStringEnv('OPENAI_BASE_URL', '') || parseStringEnv('LLM_BASE_URL', '') || undefined,
    model: parseStringEnv('ANTHROPIC_MODEL', '') || parseStringEnv('OPENAI_MODEL', '') || parseStringEnv('LLM_MODEL', 'claude-sonnet-5'),
    temperature: 0.2,
    maxTokens: 4096,
    timeoutMs: 60000,
    maxRetries: 3,
  },
  database: {
    driver: (parseStringEnv('DB_DRIVER', 'sqlite') as DatabaseConfig['driver']),
    path: parseStringEnv('DB_PATH', './data/job-agent.db'),
    url: parseStringEnv('DATABASE_URL', '') || undefined,
    poolMin: parseIntEnv('DB_POOL_MIN', 2),
    poolMax: parseIntEnv('DB_POOL_MAX', 10),
    migrateOnStart: true,
  },
  redis: {
    url: parseStringEnv('REDIS_URL', 'redis://127.0.0.1:6379'),
    enabled: parseBoolEnv('USE_REDIS', false),
    keyPrefix: 'job-agent:',
  },
  browser: {
    profilePath: expandHome(parseStringEnv('BROWSER_PROFILE_PATH', '~/.job-agent/browser-profile')),
    backend: (parseStringEnv('BROWSER_BACKEND', 'playwright') as 'playwright' | 'obscura'),
    obscuraBin: parseStringEnv('OBSCURA_BIN', 'obscura'),
    obscuraPort: parseIntEnv('OBSCURA_PORT', 9222),
    obscuraStealth: parseBoolEnv('OBSCURA_STEALTH', false),
    headless: parseBoolEnv('BROWSER_HEADLESS', true),
    // Phase 5E measured: the 50ms-per-action Playwright slowMo debug delay
    // consumed ~616ms/job (73% of application.total; fill.action 57.7ms ->
    // 2.8ms, upload 142 -> 17ms) with nothing to watch in headless mode —
    // and BROWSER_HEADLESS defaults to true, so production paid it too.
    // Default is therefore 0 when headless, 50 when a visible browser is
    // opened (demos stay watchable). Explicit BROWSER_SLOW_MO always wins.
    slowMo: parseIntEnv('BROWSER_SLOW_MO', parseBoolEnv('BROWSER_HEADLESS', true) ? 0 : 50),
    defaultTimeout: parseIntEnv('DEFAULT_ELEMENT_TIMEOUT_MS', 2000),
    navigationTimeout: parseIntEnv('DEFAULT_NAVIGATION_TIMEOUT_MS', 15000),
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    timezoneId: 'Asia/Kolkata',
  },
  application: {
    autoSubmit: parseBoolEnv('AUTO_SUBMIT', false),
    maxConcurrentApplications: parseIntEnv('JOB_CONCURRENCY', 2),
  requireApproval: parseBoolEnv('REQUIRE_APPROVAL', false),
  approvedJobId: process.env.APPROVED_JOB_ID || undefined,
  approvalBlockers: (process.env.APPROVAL_BLOCKERS || '').split('|').map(s => s.trim()).filter(Boolean),
  awaitOperatorApprovalMs: parseIntEnv('AWAIT_OPERATOR_APPROVAL_MS', 0),
  allowUncertainRetryJobId: process.env.ALLOW_UNCERTAIN_RETRY_JOB_ID || undefined,
    resumeRevisionLimit: parseIntEnv('MAX_RESUME_REVISIONS', 3),
    matchThreshold: parseIntEnv('MATCH_THRESHOLD', 60),
    atsThreshold: parseIntEnv('ATS_THRESHOLD', 70),
    pauseOnUncertain: true,
    verifySubmission: true,
    submissionTimeoutMs: 30000,
    defaultApplicationUrl: parseStringEnv('DEFAULT_APPLICATION_URL', ''),
    escalationWaitMs: parseIntEnv('ESCALATION_WAIT_MS', 0),
  },
  scheduling: {
    daily: parseBoolEnv('SCHEDULE_DAILY', true),
    time: parseStringEnv('SCHEDULE_TIME', '09:00'),
    timezone: 'Asia/Kolkata',
    discoveryWorkers: 5,
    analysisWorkers: 5,
    generationWorkers: 3,
    browserWorkers: 2,
  },
  observability: {
    logLevel: (parseStringEnv('LOG_LEVEL', 'info') as ObservabilityConfig['logLevel']),
    logDir: expandHome(parseStringEnv('LOG_DIR', './logs')),
    structuredLogs: true,
    metricsEnabled: false,
    metricsPort: 9090,
  },
  desktop: {
    basePath: expandHome(parseStringEnv('DESKTOP_PATH', '~/Desktop')),
    cvOutputDir: expandHome(parseStringEnv('CV_OUTPUT_DIR', '~/Desktop/cv')),
    excelPath: expandHome(parseStringEnv('EXCEL_PATH', '~/Desktop/job-applications.xlsx')),
  },
  testing: {
    mockLLM: parseBoolEnv('MOCK_LLM', false),
    fakeATSPort: 31415,
    testDataDir: './tests/fixtures',
    verboseDatabase: parseBoolEnv('VERBOSE_DATABASE', false),
  },
  limits: {
    maxJobsDiscovered: parseIntEnv('MAX_JOBS_DISCOVERED', 200),
    maxApplicationsPerDay: parseIntEnv('MAX_APPLICATIONS_PER_DAY', 25),
    maxBrowserConcurrency: parseIntEnv('MAX_BROWSER_CONCURRENCY', 2),
    maxResumeRevisions: parseIntEnv('MAX_RESUME_REVISIONS', 3),
    matchThreshold: parseIntEnv('MATCH_THRESHOLD', 60),
    atsThreshold: parseIntEnv('ATS_THRESHOLD', 70),
    autoSubmit: parseBoolEnv('AUTO_SUBMIT', false),
    scheduleDaily: parseBoolEnv('SCHEDULE_DAILY', true),
    scheduleTime: parseStringEnv('SCHEDULE_TIME', '09:00'),
  },
  cache: {
    llmEnabled: parseBoolEnv('LLM_CACHE_ENABLED', true),
    llmTtlSeconds: parseIntEnv('LLM_CACHE_TTL_SECONDS', 86400),
    jdEnabled: parseBoolEnv('JD_CACHE_ENABLED', true),
    matchEnabled: parseBoolEnv('MATCH_CACHE_ENABLED', true),
    artifactEnabled: parseBoolEnv('ARTIFACT_CACHE_ENABLED', true),
    excelSyncDebounceMs: parseIntEnv('EXCEL_SYNC_DEBOUNCE_MS', 2000),
  },
};

export function validateConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.llm.apiKey && config.llm.provider !== 'custom') {
    errors.push('LLM API key is required (ANTHROPIC_API_KEY, OPENAI_API_KEY, or LLM_API_KEY)');
  }

  if (config.database.driver === 'postgres' && !config.database.url) {
    errors.push('DATABASE_URL is required when using postgres driver');
  }

  if (config.database.driver === 'sqlite' && !config.database.path) {
    errors.push('DB_PATH is required when using sqlite driver');
  }

  if (config.application.autoSubmit && !config.application.verifySubmission) {
    errors.push('verifySubmission must be true when autoSubmit is true');
  }

  return { valid: errors.length === 0, errors };
}

export function getConfig(): AppConfig {
  return config;
}