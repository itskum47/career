/**
 * Worker Manager - coordinates multiple job queues and provides high-level job scheduling.
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
} from './types.ts';
import { MemoryQueue, createWorkerQueue } from './queue.ts';
import { logger } from '../core/logger.ts';
import { config } from '../core/config.ts';

export interface WorkerManagerOptions {
  defaultConfig?: Partial<WorkerConfig>;
  globalEventHandler?: (event: WorkerEvent) => void;
  globalErrorHandler?: (error: Error, job?: QueueJob) => void;
}

export class WorkerManager {
  private queues: Map<JobType, MemoryQueue> = new Map();
  private defaultConfig: WorkerConfig;
  private globalEventHandler?: (event: WorkerEvent) => void;
  private globalErrorHandler?: (error: Error, job?: QueueJob) => void;
  private isStarted = false;

  constructor(options: WorkerManagerOptions = {}) {
    this.defaultConfig = {
      concurrency: config.application?.maxConcurrentApplications || config.scheduling?.browserWorkers || 2,
      maxRetries: 3,
      retryDelayMs: 5000,
      retryBackoffMultiplier: 2,
      maxRetryDelayMs: 300000,
      stalledIntervalMs: 30000,
      jobTimeoutMs: 300000,
      deadLetterMaxSize: 1000,
      ...options.defaultConfig,
    };
    this.globalEventHandler = options.globalEventHandler;
    this.globalErrorHandler = options.globalErrorHandler;
  }

  registerQueue(type: JobType, handlers: Map<JobType, JobHandler>, config?: Partial<WorkerConfig>): MemoryQueue {
    if (this.queues.has(type)) {
      throw new Error(`Queue for job type ${type} already registered`);
    }

    const queue = createWorkerQueue({
      name: `worker-${type}`,
      config: { ...this.defaultConfig, ...config },
      handlers,
      onEvent: (event) => {
        if (this.globalEventHandler) this.globalEventHandler(event);
      },
      onError: (error, job) => {
        if (this.globalErrorHandler) this.globalErrorHandler(error, job);
      },
    });

    this.queues.set(type, queue);
    logger.info('Queue registered', { type });
    return queue;
  }

  getQueue(type: JobType): MemoryQueue | undefined {
    return this.queues.get(type);
  }

  async addJob<T>(
    type: JobType,
    payload: T,
    options: Partial<Pick<QueueJob, 'priority' | 'maxAttempts' | 'delayUntil' | 'parentJobId' | 'metadata'>> = {}
  ): Promise<string> {
    const queue = this.queues.get(type);
    if (!queue) {
      throw new Error(`Queue for job type ${type} not registered`);
    }
    return queue.add(type, payload, options);
  }

  async startAll(): Promise<void> {
    if (this.isStarted) return;

    this.isStarted = true;
    logger.info('Starting all worker queues');

    const startPromises = Array.from(this.queues.values()).map(queue => queue.start());
    await Promise.all(startPromises);

    logger.info('All worker queues started');
  }

  async stopAll(graceful = true): Promise<void> {
    if (!this.isStarted) return;

    logger.info('Stopping all worker queues', { graceful });

    const stopPromises = Array.from(this.queues.values()).map(queue => queue.stop(graceful));
    await Promise.all(stopPromises);

    this.isStarted = false;
    logger.info('All worker queues stopped');
  }

  getJob(jobId: string): QueueJob | undefined {
    for (const queue of this.queues.values()) {
      const job = queue.getJob(jobId);
      if (job) return job;
    }
    return undefined;
  }

  getJobsByStatus(status: JobStatus): QueueJob[] {
    const jobs: QueueJob[] = [];
    for (const queue of this.queues.values()) {
      jobs.push(...queue.getJobsByStatus(status));
    }
    return jobs;
  }

  getAllMetrics(): Record<string, WorkerMetrics> {
    const metrics: Record<string, WorkerMetrics> = {};
    for (const [type, queue] of this.queues) {
      metrics[type] = queue.getMetrics();
    }
    return metrics;
  }

  async getAllQueueStats(): Promise<Record<string, {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    deadLetter: number;
  }>> {
    const stats: Record<string, any> = {};
    for (const [type, queue] of this.queues) {
      stats[type] = await queue.getQueueStats();
    }
    return stats;
  }

  async retryFailedJob(jobId: string): Promise<boolean> {
    for (const queue of this.queues.values()) {
      const result = await queue.retryFailedJob(jobId);
      if (result) return true;
    }
    return false;
  }

  async pauseJob(jobId: string): Promise<boolean> {
    for (const queue of this.queues.values()) {
      const result = await queue.pauseJob(jobId);
      if (result) return true;
    }
    return false;
  }

  async resumeJob(jobId: string): Promise<boolean> {
    for (const queue of this.queues.values()) {
      const result = await queue.resumeJob(jobId);
      if (result) return true;
    }
    return false;
  }

  async removeJob(jobId: string): Promise<boolean> {
    for (const queue of this.queues.values()) {
      const result = await queue.removeJob(jobId);
      if (result) return true;
    }
    return false;
  }

  async clearCompleted(olderThanMs = 86400000): Promise<Record<string, number>> {
    const results: Record<string, number> = {};
    for (const [type, queue] of this.queues) {
      results[type] = await queue.clearCompleted(olderThanMs);
    }
    return results;
  }

  isHealthy(): boolean {
    for (const queue of this.queues.values()) {
      if (!queue.isHealthy()) return false;
    }
    return this.isStarted;
  }

  getRegisteredTypes(): JobType[] {
    return Array.from(this.queues.keys());
  }
}

let globalManager: WorkerManager | null = null;

export function createWorkerManager(options: WorkerManagerOptions = {}): WorkerManager {
  globalManager = new WorkerManager(options);
  return globalManager;
}

export function getWorkerManager(): WorkerManager | null {
  return globalManager;
}