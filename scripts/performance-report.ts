#!/usr/bin/env node
/**
 * Generate performance report
 */
import { performanceCollector } from '../src/performance/collector.ts';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  try {
    const report = performanceCollector.generateReport();
    console.log(report);
    
    // Also save to file
    const outPath = path.join(process.cwd(), 'performance-report.md');
    fs.writeFileSync(outPath, report);
    console.log(`\nReport saved to ${outPath}`);
  } catch (error) {
    console.error('Error generating report:', error);
    process.exit(1);
  }
}

main();