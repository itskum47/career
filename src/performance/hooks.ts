/**
 * Hooks to integrate performance tracking
 */
import { performanceCollector, startTimer } from './index.ts';
import { STAGES } from './stages.ts';

export function trackStage(stage: string, context: { jobId?: string; applicationId?: string; source?: string } = {}) {
  const timer = startTimer({ ...context, stage });
  return {
    timer,
    end: (success = true, error?: string) => {
      const result = timer.end(success, error);
      performanceCollector.record({
        stage: result.stage,
        durationMs: result.durationMs,
        success: result.success,
        jobId: result.jobId,
        applicationId: result.applicationId,
        source: result.source,
      });
      return result;
    },
  };
}

export { STAGES };
export { performanceCollector };