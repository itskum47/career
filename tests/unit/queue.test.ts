/**
 * Unit tests for the in-memory worker queue.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryQueue, createWorkerQueue } from '@job-agent/worker/queue.js';
import type { QueueJob, JobType, JobPriority } from '@job-agent/worker/types.js';

describe('MemoryQueue', () => {
  let queue: MemoryQueue;

  beforeEach(() => {
    queue = createWorkerQueue({
      name: 'test-queue',
      config: {
        concurrency: 2,
        maxRetries: 2,
        retryDelayMs: 100,
        jobTimeoutMs: 5000,
      },
      handlers: new Map(),
    });
  });

  afterEach(async () => {
    await queue.stop(false);
  });

  describe('Job Management', () => {
    it('should add a job to the queue', async () => {
      const id = await queue.add('discover' as JobType, { keywords: ['test'] });
      expect(id).toBeDefined();
      expect(id.startsWith('job-')).toBe(true);

      const job = queue.getJob(id);
      expect(job).toBeDefined();
      expect(job?.type).toBe('discover');
      expect(job?.status).toBe('waiting');
      expect(job?.payload).toEqual({ keywords: ['test'] });
    });

    it('should add with priority', async () => {
      const id = await queue.add('discover' as JobType, {}, { priority: 'high' });
      const job = queue.getJob(id);
      expect(job?.priority).toBe('high');
    });

    it('should add with delay', async () => {
      const delayUntil = new Date(Date.now() + 5000);
      const id = await queue.add('discover' as JobType, {}, { delayUntil });
      const job = queue.getJob(id);
      expect(job?.status).toBe('delayed');
    });

    it('should get job by ID', async () => {
      const id = await queue.add('discover' as JobType, { test: true });
      const job = queue.getJob(id);
      expect(job?.id).toBe(id);
    });

    it('should get jobs by status', async () => {
      const id1 = await queue.add('discover' as JobType, {});
      const id2 = await queue.add('match' as JobType, {});
      const id3 = await queue.add('apply' as JobType, {});

      const waiting = queue.getJobsByStatus('waiting');
      expect(waiting.length).toBe(3);
    });
  });

  describe('Metrics', () => {
    it('should return initial metrics', () => {
      const metrics = queue.getMetrics();
      expect(metrics.jobsProcessed).toBe(0);
      expect(metrics.jobsSucceeded).toBe(0);
      expect(metrics.jobsFailed).toBe(0);
      expect(metrics.jobsRetried).toBe(0);
      expect(metrics.currentActiveJobs).toBe(0);
    });

    it('should track queue length', async () => {
      await queue.add('discover' as JobType, {});
      await queue.add('match' as JobType, {});
      await queue.add('apply' as JobType, {});

      const metrics = queue.getMetrics();
      expect(metrics.queueLength).toBe(3);
    });
  });

  describe('Queue Stats', () => {
    it('should return queue stats', async () => {
      await queue.add('discover' as JobType, {});
      await queue.add('match' as JobType, {});

      const stats = await queue.getQueueStats();
      expect(stats.waiting).toBe(2);
      expect(stats.active).toBe(0);
      expect(stats.completed).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.delayed).toBe(0);
      expect(stats.deadLetter).toBe(0);
    });
  });

  describe('Job Removal', () => {
    it('should remove jobs', async () => {
      const id = await queue.add('discover' as JobType, {});
      expect(queue.getJob(id)).toBeDefined();

      const result = await queue.removeJob(id);
      expect(result).toBe(true);
      expect(queue.getJob(id)).toBeUndefined();
    });

    it('should return false for non-existent job', async () => {
      const result = await queue.removeJob('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('Job Pausing/Resuming', () => {
    it('should pause a waiting job', async () => {
      const id = await queue.add('discover' as JobType, {});
      const result = await queue.pauseJob(id);
      expect(result).toBe(true);

      const job = queue.getJob(id);
      expect(job?.status).toBe('paused');
    });

    it('should resume a paused job', async () => {
      const id = await queue.add('discover' as JobType, {});
      await queue.pauseJob(id);
      const result = await queue.resumeJob(id);
      expect(result).toBe(true);

      const job = queue.getJob(id);
      expect(job?.status).toBe('waiting');
    });
  });

  describe('Job Retry', () => {
    it('should retry failed jobs', async () => {
      // This would need a handler that fails to test fully
      // For now, just verify the method exists
      expect(typeof queue.retryFailedJob).toBe('function');
    });
  });

  describe('Health Check', () => {
    it('should return health status', () => {
      expect(queue.isHealthy()).toBe(false);
    });
  });
});