/**
 * Stage timing instrumentation for performance measurement
 * Tracks duration of each stage with job/application context
 */
import { logger } from '../core/logger.ts';
import { performanceCollector } from './collector.ts';

export interface TimerContext {
  jobId?: string;
  applicationId?: string;
  source?: string;
  stage: string;
}

export interface TimerResult {
  stage: string;
  durationMs: number;
  success: boolean;
  error?: string;
  jobId?: string;
  applicationId?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export class StageTimer {
  private startTime: number;
  private context: TimerContext;
  private metadata: Record<string, unknown> = {};

  constructor(context: TimerContext) {
    this.context = context;
    this.startTime = Date.now();
  }

  addMetadata(key: string, value: unknown): this {
    this.metadata[key] = value;
    return this;
  }

  async measure<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      this.end(true);
      return result;
    } catch (error) {
      this.end(false, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  end(success: boolean, error?: string): TimerResult {
    const durationMs = Date.now() - this.startTime;
    const result: TimerResult = {
      stage: this.context.stage,
      durationMs,
      success,
      error,
      jobId: this.context.jobId,
      applicationId: this.context.applicationId,
      source: this.context.source,
      metadata: this.metadata,
    };

    logger.info('stage.duration', result);
    
    // Record to performance collector
    performanceCollector.record({
      stage: result.stage,
      durationMs: result.durationMs,
      success: result.success,
      jobId: result.jobId,
      applicationId: result.applicationId,
      source: result.source,
    });
    
    return result;
  }

  getDurationMs(): number {
    return Date.now() - this.startTime;
  }
}

export function startTimer(context: TimerContext): StageTimer {
  return new StageTimer(context);
}