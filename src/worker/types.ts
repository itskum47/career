/**
 * Worker queue types and interfaces.
 */

export type JobType =
  | 'discover'
  | 'extract'
  | 'verify'
  | 'deduplicate'
  | 'match'
  | 'generate-resume'
  | 'generate-cover-letter'
  | 'validate-ats'
  | 'apply'
  | 'human-escalation'
  | 'sync-excel'
  | 'sync-db';

export type JobPriority = 'low' | 'normal' | 'high' | 'critical';

export type JobStatus =
  | 'waiting'
  | 'active'
  | 'completed'
  | 'failed'
  | 'delayed'
  | 'paused';

export interface QueueJob<T = unknown> {
  id: string;
  type: JobType;
  payload: T;
  priority: JobPriority;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  error?: string;
  result?: unknown;
  retryDelay?: number;
  delayUntil?: Date;
  parentJobId?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkerConfig {
  concurrency: number;
  maxRetries: number;
  retryDelayMs: number;
  retryBackoffMultiplier: number;
  maxRetryDelayMs: number;
  stalledIntervalMs: number;
  jobTimeoutMs: number;
  deadLetterMaxSize: number;
}

export interface WorkerMetrics {
  jobsProcessed: number;
  jobsSucceeded: number;
  jobsFailed: number;
  jobsRetried: number;
  jobsInDeadLetter: number;
  averageProcessingTimeMs: number;
  currentActiveJobs: number;
  queueLength: number;
}

export interface WorkerEvent {
  type: 'job:started' | 'job:completed' | 'job:failed' | 'job:retried' | 'job:stalled' | 'queue:drained';
  jobId: string;
  jobType: JobType;
  timestamp: Date;
  data?: Record<string, unknown>;
  error?: string;
}

export interface JobHandler<T = unknown, R = unknown> {
  (job: QueueJob<T>): Promise<R>;
}

export interface WorkerOptions {
  name: string;
  config?: Partial<WorkerConfig>;
  handlers: Map<JobType, JobHandler>;
  onEvent?: (event: WorkerEvent) => void;
  onError?: (error: Error, job?: QueueJob) => void;
}