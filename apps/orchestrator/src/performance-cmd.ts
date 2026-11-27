/**
 * Performance report command
 */
import { performanceCollector } from '../../../src/performance/collector.ts';
import * as fs from 'fs';
import * as path from 'path';

export async function generatePerformanceReport(): Promise<void> {
  const report = performanceCollector.generateReport();
  console.log(report);
  
  const outPath = path.join(process.cwd(), 'performance-report.md');
  fs.writeFileSync(outPath, report);
  console.log(`\nReport saved to ${outPath}`);
}