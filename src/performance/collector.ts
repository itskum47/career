/**
 * Performance data collector and statistics calculator
 */
import { logger } from '../core/logger.ts';

export interface PerformanceMeasurement {
  stage: string;
  durationMs: number;
  success: boolean;
  jobId?: string;
  applicationId?: string;
  source?: string;
  timestamp: number;
}

export interface StageStats {
  stage: string;
  count: number;
  successCount: number;
  failureCount: number;
  min: number;
  max: number;
  average: number;
  median: number;
  p95: number;
}

export interface OverallStats {
  totalJobs: number;
  totalTimeMs: number;
  jobsPerHour: number;
  byStage: Record<string, StageStats>;
}

export class PerformanceCollector {
  private measurements: PerformanceMeasurement[] = [];
  private maxMeasurements = 10000; // Keep last 10k measurements

  record(measurement: Omit<PerformanceMeasurement, 'timestamp'>): void {
    const m: PerformanceMeasurement = {
      ...measurement,
      timestamp: Date.now(),
    };
    this.measurements.push(m);
    
    if (this.measurements.length > this.maxMeasurements) {
      this.measurements.shift();
    }
  }

  clear(): void {
    this.measurements = [];
  }

  getMeasurements(stage?: string): PerformanceMeasurement[] {
    if (stage) {
      return this.measurements.filter(m => m.stage === stage);
    }
    return [...this.measurements];
  }

  calculateStats(stage?: string): StageStats[] {
    const stages = stage ? [stage] : [...new Set(this.measurements.map(m => m.stage))];
    const stats: StageStats[] = [];

    for (const s of stages) {
      const ms = this.measurements.filter(m => m.stage === s && m.success);
      if (ms.length === 0) {
        const allMs = this.measurements.filter(m => m.stage === s);
        stats.push({
          stage: s,
          count: allMs.length,
          successCount: allMs.filter(m => m.success).length,
          failureCount: allMs.filter(m => !m.success).length,
          min: 0,
          max: 0,
          average: 0,
          median: 0,
          p95: 0,
        });
        continue;
      }

      const durations = ms.map(m => m.durationMs).sort((a, b) => a - b);
      const count = ms.length;
      const min = durations[0];
      const max = durations[count - 1];
      const average = durations.reduce((sum, d) => sum + d, 0) / count;
      const median = count % 2 === 0
        ? (durations[count / 2 - 1] + durations[count / 2]) / 2
        : durations[Math.floor(count / 2)];
      const p95Index = Math.floor(count * 0.95);
      const p95 = durations[p95Index >= count ? count - 1 : p95Index];

      const allForStage = this.measurements.filter(m => m.stage === s);
      stats.push({
        stage: s,
        count: allForStage.length,
        successCount: ms.length,
        failureCount: allForStage.length - ms.length,
        min,
        max,
        average,
        median,
        p95,
      });
    }

    return stats;
  }

  calculateOverall(): OverallStats {
    // Calculate jobs/hour based on completed job applications
    const jobMeasurements = this.measurements.filter(m => m.stage === 'job.complete' && m.success);
    const jobDurations = jobMeasurements.map(m => m.durationMs);
    
    let totalJobs = jobMeasurements.length;
    let totalTimeMs = jobDurations.reduce((sum, d) => sum + d, 0);
    
    // If no explicit job.complete, estimate from application.total or sum of stages
    if (totalJobs === 0) {
      const appMeasurements = this.measurements.filter(m => m.stage === 'application.total' && m.success);
      totalJobs = appMeasurements.length;
      totalTimeMs = appMeasurements.reduce((sum, d) => sum + (d.durationMs || 0), 0);
    }

    const jobsPerHour = totalTimeMs > 0 && totalJobs > 0
      ? (totalJobs / (totalTimeMs / 3600000))
      : 0;

    return {
      totalJobs,
      totalTimeMs,
      jobsPerHour,
      byStage: Object.fromEntries(this.calculateStats().map(s => [s.stage, s])),
    };
  }

  generateReport(): string {
    const stats = this.calculateStats();
    const overall = this.calculateOverall();
    const lines: string[] = [];

    lines.push('# Performance Report');
    lines.push('');
    lines.push('## Overall');
    lines.push(`- Total Jobs: ${overall.totalJobs}`);
    lines.push(`- Total Time (ms): ${Math.round(overall.totalTimeMs)}`);
    lines.push(`- Jobs/hour: ${overall.jobsPerHour.toFixed(2)}`);
    lines.push('');

    lines.push('## By Stage');
    lines.push('| Stage | Count | Success | Failure | Min (ms) | Max (ms) | Avg (ms) | Median (ms) | P95 (ms) |');
    lines.push('|-------|-------|---------|---------|----------|----------|----------|-------------|----------|');

    for (const s of stats.sort((a, b) => a.stage.localeCompare(b.stage))) {
      lines.push(
        `| ${s.stage} | ${s.count} | ${s.successCount} | ${s.failureCount} | ` +
        `${Math.round(s.min)} | ${Math.round(s.max)} | ${Math.round(s.average)} | ` +
        `${Math.round(s.median)} | ${Math.round(s.p95)} |`
      );
    }

    return lines.join('\n');
  }

  logReport(): void {
    logger.info('Performance report', { report: this.generateReport() });
  }
}

export const performanceCollector = new PerformanceCollector();
export default performanceCollector;