/**
 * Debounced Excel sync - batches multiple changes into one sync
 */
import { ExcelSync } from './excel.ts';
import type { ApplicationRepository, JobRepository, MatchRepository, ResumeRepository, CoverLetterRepository } from '../database/repositories.ts';
import { logger } from '../core/logger.ts';
import { config } from '../core/config.ts';

export class DebouncedExcelSync {
  private timeoutId: NodeJS.Timeout | null = null;
  private debounceMs: number;
  private pendingSync: boolean = false;
  private syncPromise: Promise<any> | null = null;
  private excelSync: ExcelSync;

  constructor(debounceMs = config.cache?.excelSyncDebounceMs || 2000, outputPath?: string) {
    this.debounceMs = debounceMs;
    this.excelSync = new ExcelSync(outputPath);
  }

  schedule(
    appRepo: ApplicationRepository,
    jobRepo: JobRepository,
    matchRepo: MatchRepository,
    resumeRepo: ResumeRepository,
    coverRepo: CoverLetterRepository,
    options = {}
  ): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }

    this.timeoutId = setTimeout(async () => {
      await this.syncNow(appRepo, jobRepo, matchRepo, resumeRepo, coverRepo, options);
    }, this.debounceMs);

    logger.debug('Excel sync scheduled', { debounceMs: this.debounceMs });
  }

  async syncNow(
    appRepo: ApplicationRepository,
    jobRepo: JobRepository,
    matchRepo: MatchRepository,
    resumeRepo: ResumeRepository,
    coverRepo: CoverLetterRepository,
    options = {}
  ): Promise<any> {
    if (this.syncPromise) {
      return this.syncPromise;
    }

    this.syncPromise = (async () => {
      try {
        logger.info('Executing debounced Excel sync');
        const result = await this.excelSync.sync(appRepo, jobRepo, matchRepo, resumeRepo, coverRepo, options);
        logger.info('Debounced Excel sync completed', { applicationsSynced: result.applicationsSynced });
        return result;
      } catch (error) {
        logger.error('Debounced Excel sync failed', { error: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally {
        this.syncPromise = null;
        this.timeoutId = null;
      }
    })();

    return this.syncPromise;
  }

  flush(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }
}

export const debouncedExcelSync = new DebouncedExcelSync();
export default debouncedExcelSync;