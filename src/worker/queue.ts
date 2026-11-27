/**
 * In-memory job queue with priority support, retry logic, and dead-letter handling.
 * Alternative to BullMQ for environments without Redis.
 */

import type {
  QueueJob,
  JobType,
  JobPriority,
  JobStatus,
  WorkerConfig,
  WorkerMetrics,
  WorkerEvent,
  JobHandler,
  WorkerOptions,
} from './types.ts';
import { randomUUID } from 'crypto';

function generateId(): string {
  return `job-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}
import { logger } from '../core/logger.ts';

const DEFAULT_CONFIG: WorkerConfig = {
  concurrency: 5,
  maxRetries: 3,
  retryDelayMs: 5000,
  retryBackoffMultiplier: 2,
  maxRetryDelayMs: 300000, // 5 minutes
  stalledIntervalMs: 30000,
  jobTimeoutMs: 300000, // 5 minutes
  deadLetterMaxSize: 1000,
};

export class MemoryQueue {
  private jobs: Map<string, QueueJob> = new Map();
  private waiting: Map<JobPriority, QueueJob[]> = new Map([
    ['critical', []],
    ['high', []],
    ['normal', []],
    ['low', []],
  ]);
  private active: Map<string, QueueJob> = new Map();
  private completed: Map<string, QueueJob> = new Map();
  private failed: Map<string, QueueJob> = new Map();
  private deadLetter: QueueJob[] = [];
  private delayed: Map<string, NodeJS.Timeout> = new Map();
  private stalledCheckInterval?: NodeJS.Timeout;
  private config: WorkerConfig;
  private eventListeners: Set<(event: WorkerEvent) => void> = new Set();
  private isProcessing = false;
  private processingPromise?: Promise<void>;
  private metrics: WorkerMetrics = {
    jobsProcessed: 0,
    jobsSucceeded: 0,
    jobsFailed: 0,
    jobsRetried: 0,
    jobsInDeadLetter: 0,
    averageProcessingTimeMs: 0,
    currentActiveJobs: 0,
    queueLength: 0,
  };
  private handlers: Map<JobType, JobHandler> = new Map();
  private workerName: string;
  private errorHandler?: (error: Error, job?: QueueJob) => void;

  constructor(options: WorkerOptions) {
    this.workerName = options.name;
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    this.handlers = options.handlers;
    this.errorHandler = options.onError;
    if (options.onEvent) {
      this.eventListeners.add(options.onEvent);
    }
  }

  addEventListener(listener: (event: WorkerEvent) => void): void {
    this.eventListeners.add(listener);
  }

  removeEventListener(listener: (event: WorkerEvent) => void): void {
    this.eventListeners.delete(listener);
  }

  private emit(event: WorkerEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        logger.error('Event listener error', { error: String(error) });
      }
    }
  }

  async add<T>(type: JobType, payload: T, options: Partial<Pick<QueueJob, 'priority' | 'maxAttempts' | 'delayUntil' | 'parentJobId' | 'metadata'>> = {}): Promise<string> {
    const id = generateId();
    const now = new Date();

    const job: QueueJob<T> = {
      id,
      type,
      payload,
      priority: options.priority || 'normal',
      status: 'waiting',
      attempts: 0,
      maxAttempts: options.maxAttempts || this.config.maxRetries,
      createdAt: now,
      updatedAt: now,
      delayUntil: options.delayUntil,
      parentJobId: options.parentJobId,
      metadata: options.metadata,
    };

    if (options.delayUntil && options.delayUntil > now) {
      job.status = 'delayed';
      const delayMs = options.delayUntil.getTime() - now.getTime();
      const timeout = setTimeout(() => {
        this.releaseDelayedJob(id);
      }, delayMs);
      this.delayed.set(id, timeout);
    } else {
      this.enqueueWaiting(job);
    }

    this.jobs.set(id, job);
    this.updateMetrics();

    logger.debug('Job added to queue', { jobId: id, type, priority: job.priority });
    return id;
  }

  private enqueueWaiting(job: QueueJob): void {
    const queue = this.waiting.get(job.priority) || [];
    queue.push(job);
    this.waiting.set(job.priority, queue);
    job.status = 'waiting';
    job.updatedAt = new Date();
  }

  private releaseDelayedJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'delayed') return;

    this.delayed.delete(jobId);
    this.enqueueWaiting(job);
    this.updateMetrics();
  }

  private getNextJob(): QueueJob | null {
    for (const priority of ['critical', 'high', 'normal', 'low'] as JobPriority[]) {
      const queue = this.waiting.get(priority);
      if (queue && queue.length > 0) {
        return queue.shift()!;
      }
    }
    return null;
  }

  async start(): Promise<void> {
    if (this.isProcessing) return;

    this.isProcessing = true;
    logger.info('Worker started', { name: this.workerName, concurrency: this.config.concurrency });

    // Start stalled job checker
    this.stalledCheckInterval = setInterval(() => this.checkStalledJobs(), this.config.stalledIntervalMs);

    // Start processing loop
    this.processingPromise = this.processLoop();

    await this.processingPromise;
  }

  async stop(graceful = true): Promise<void> {
    if (!this.isProcessing) return;

    this.isProcessing = false;
    logger.info('Stopping worker', { name: this.workerName, graceful });

    if (this.stalledCheckInterval) {
      clearInterval(this.stalledCheckInterval);
    }

    // Clear delayed timeouts
    for (const timeout of this.delayed.values()) {
      clearTimeout(timeout);
    }
    this.delayed.clear();

    if (graceful) {
      // Wait for active jobs to complete (with timeout)
      const startWait = Date.now();
      while (this.active.size > 0 && Date.now() - startWait < 30000) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // Force stop remaining active jobs
    for (const [jobId, job] of this.active) {
      job.status = 'waiting';
      job.updatedAt = new Date();
      this.enqueueWaiting(job);
    }
    this.active.clear();
  }

  private async processLoop(): Promise<void> {
    const runningJobs: Promise<void>[] = [];

    while (this.isProcessing) {
      // Start new jobs up to concurrency limit
      while (runningJobs.length < this.config.concurrency) {
        const job = this.getNextJob();
        if (!job) break;

        const handler = this.handlers.get(job.type);
        if (!handler) {
          logger.warn('No handler for job type', { jobId: job.id, type: job.type });
          await this.failJob(job, new Error(`No handler for job type: ${job.type}`));
          continue;
        }

        let tracked: Promise<void> = Promise.resolve();
        tracked = this.processJob(job, handler)
          .catch(err => {
            logger.error('Unhandled job processing error', {
              jobId: job.id,
              error: err instanceof Error ? err.message : String(err),
            });
          })
          .finally(() => {
            // Remove the settled promise: frees the concurrency slot and prevents
            // the loop from racing an already-resolved promise (busy-spin).
            const idx = runningJobs.indexOf(tracked);
            if (idx !== -1) runningJobs.splice(idx, 1);
          });
        runningJobs.push(tracked);
      }

      if (runningJobs.length === 0) {
        // No jobs to process, wait a bit
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }

      // Wait for at least one job to complete (settled promises are removed via .finally above)
      await Promise.race(runningJobs);
    }
  }

  private async processJob<T>(job: QueueJob<T>, handler: JobHandler<T>): Promise<void> {
    const startTime = Date.now();

    // Move from waiting to active
    job.status = 'active';
    job.startedAt = new Date();
    job.updatedAt = new Date();
    job.attempts++;
    this.active.set(job.id, job);
    this.updateMetrics();

    this.emit({
      type: 'job:started',
      jobId: job.id,
      jobType: job.type,
      timestamp: new Date(),
    });

    // Set job timeout
    const timeoutId = setTimeout(() => {
      this.handleJobTimeout(job.id);
    }, this.config.jobTimeoutMs);

    try {
      const result = await handler(job);

      clearTimeout(timeoutId);

      job.status = 'completed';
      job.completedAt = new Date();
      job.updatedAt = new Date();
      job.result = result;

      this.active.delete(job.id);
      this.completed.set(job.id, job);

      this.updateMetrics();
      this.metrics.jobsProcessed++;
      this.metrics.jobsSucceeded++;
      this.updateAverageProcessingTime(Date.now() - startTime);

      this.emit({
        type: 'job:completed',
        jobId: job.id,
        jobType: job.type,
        timestamp: new Date(),
        data: { result },
      });

      const durationMs = Date.now() - startTime;
      logger.info('Job completed', { jobId: job.id, type: job.type, durationMs });
    } catch (error) {
      clearTimeout(timeoutId);

      const err = error instanceof Error ? error : new Error(String(error));
      await this.handleJobFailure(job, err);
    }
  }

  private async handleJobFailure(job: QueueJob, error: Error): Promise<void> {
    job.error = error.message;
    job.updatedAt = new Date();

    if (job.attempts >= job.maxAttempts) {
      await this.failJob(job, error);
    } else {
      await this.retryJob(job, error);
    }
  }

  private async failJob(job: QueueJob, error: Error): Promise<void> {
    job.status = 'failed';
    job.failedAt = new Date();
    job.error = error.message;
    job.updatedAt = new Date();

    this.active.delete(job.id);
    this.failed.set(job.id, job);

    // Add to dead letter if not already there
    if (!this.deadLetter.some(j => j.id === job.id)) {
      this.deadLetter.push(job);
      if (this.deadLetter.length > this.config.deadLetterMaxSize) {
        this.deadLetter.shift(); // Remove oldest
      }
      this.metrics.jobsInDeadLetter = this.deadLetter.length;
    }

    this.updateMetrics();
    this.metrics.jobsProcessed++;
    this.metrics.jobsFailed++;

    this.emit({
      type: 'job:failed',
      jobId: job.id,
      jobType: job.type,
      timestamp: new Date(),
      error: error.message,
    });

    if (this.errorHandler) {
      this.errorHandler(error, job);
    }

    logger.error('Job failed permanently', { jobId: job.id, type: job.type, error: error.message, attempts: job.attempts });
  }

  private async retryJob(job: QueueJob, error: Error): Promise<void> {
    // Must be 'delayed': releaseDelayedJob() only re-enqueues jobs in that state
    job.status = 'delayed';
    job.updatedAt = new Date();

    // Calculate retry delay with exponential backoff
    const baseDelay = this.config.retryDelayMs * Math.pow(this.config.retryBackoffMultiplier, job.attempts - 1);
    const delay = Math.min(baseDelay, this.config.maxRetryDelayMs);

    job.delayUntil = new Date(Date.now() + delay);
    this.active.delete(job.id);

    this.updateMetrics();
    this.metrics.jobsRetried++;

    this.emit({
      type: 'job:retried',
      jobId: job.id,
      jobType: job.type,
      timestamp: new Date(),
      data: { attempt: job.attempts, delayMs: delay },
      error: error.message,
    });

    logger.info('Job scheduled for retry', { jobId: job.id, attempt: job.attempts, delayMs: delay });

    const timeout = setTimeout(() => {
      this.releaseDelayedJob(job.id);
    }, delay);
    this.delayed.set(job.id, timeout);
  }

  private handleJobTimeout(jobId: string): void {
    const job = this.active.get(jobId);
    if (!job) return;

    logger.warn('Job timed out', { jobId, type: job.type });
    this.handleJobFailure(job, new Error(`Job timed out after ${this.config.jobTimeoutMs}ms`));
  }

  private checkStalledJobs(): void {
    const now = Date.now();
    const stalledThreshold = this.config.jobTimeoutMs * 2;

    for (const [jobId, job] of this.active) {
      if (job.startedAt && now - job.startedAt.getTime() > stalledThreshold) {
        logger.warn('Stalled job detected', { jobId, type: job.type });

        this.emit({
          type: 'job:stalled',
          jobId,
          jobType: job.type,
          timestamp: new Date(),
        });

        this.handleJobFailure(job, new Error('Job stalled - exceeded max runtime'));
      }
    }
  }

  private updateAverageProcessingTime(durationMs: number): void {
    const total = this.metrics.jobsSucceeded + this.metrics.jobsFailed;
    if (total === 1) {
      this.metrics.averageProcessingTimeMs = durationMs;
    } else {
      this.metrics.averageProcessingTimeMs =
        (this.metrics.averageProcessingTimeMs * (total - 1) + durationMs) / total;
    }
  }

  private updateMetrics(): void {
    this.metrics.currentActiveJobs = this.active.size;
    this.metrics.queueLength =
      this.waiting.get('critical')!.length +
      this.waiting.get('high')!.length +
      this.waiting.get('normal')!.length +
      this.waiting.get('low')!.length +
      this.delayed.size;
  }

  getJob(jobId: string): QueueJob | undefined {
    return this.jobs.get(jobId);
  }

  getJobsByStatus(status: JobStatus): QueueJob[] {
    return Array.from(this.jobs.values()).filter(j => j.status === status);
  }

  getMetrics(): WorkerMetrics {
    return { ...this.metrics };
  }

  async getQueueStats(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    deadLetter: number;
  }> {
    return {
      waiting: this.metrics.queueLength,
      active: this.active.size,
      completed: this.completed.size,
      failed: this.failed.size,
      delayed: this.delayed.size,
      deadLetter: this.deadLetter.length,
    };
  }

  async retryFailedJob(jobId: string): Promise<boolean> {
    const job = this.failed.get(jobId) || this.deadLetter.find(j => j.id === jobId);
    if (!job) return false;

    job.attempts = 0;
    job.error = undefined;
    job.failedAt = undefined;
    job.status = 'waiting';
    job.updatedAt = new Date();

    this.failed.delete(jobId);
    this.deadLetter = this.deadLetter.filter(j => j.id !== jobId);
    this.enqueueWaiting(job);
    this.updateMetrics();

    return true;
  }

  async pauseJob(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'waiting') return false;

    job.status = 'paused';
    job.updatedAt = new Date();

    // Remove from waiting queue
    for (const queue of this.waiting.values()) {
      const idx = queue.findIndex(j => j.id === jobId);
      if (idx !== -1) {
        queue.splice(idx, 1);
        break;
      }
    }

    this.updateMetrics();
    return true;
  }

  async resumeJob(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'paused') return false;

    job.status = 'waiting';
    job.updatedAt = new Date();
    this.enqueueWaiting(job);
    this.updateMetrics();

    return true;
  }

  async removeJob(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    // Remove from wherever it is
    if (job.status === 'waiting' || job.status === 'paused' || job.status === 'delayed') {
      for (const queue of this.waiting.values()) {
        const idx = queue.findIndex(j => j.id === jobId);
        if (idx !== -1) {
          queue.splice(idx, 1);
          break;
        }
      }
      if (this.delayed.has(jobId)) {
        clearTimeout(this.delayed.get(jobId)!);
        this.delayed.delete(jobId);
      }
    } else if (job.status === 'active') {
      this.active.delete(jobId);
    } else if (job.status === 'completed') {
      this.completed.delete(jobId);
    } else if (job.status === 'failed') {
      this.failed.delete(jobId);
      this.deadLetter = this.deadLetter.filter(j => j.id !== jobId);
    }

    this.jobs.delete(jobId);
    this.updateMetrics();

    return true;
  }

  async clearCompleted(olderThanMs = 86400000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    let count = 0;

    for (const [id, job] of this.completed) {
      if (job.completedAt && job.completedAt < cutoff) {
        this.completed.delete(id);
        this.jobs.delete(id);
        count++;
      }
    }

    this.updateMetrics();
    return count;
  }

  isHealthy(): boolean {
    return this.isProcessing && this.active.size <= this.config.concurrency;
  }
}

export function createWorkerQueue(options: WorkerOptions): MemoryQueue {
  return new MemoryQueue(options);
}