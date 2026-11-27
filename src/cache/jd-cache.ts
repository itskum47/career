/**
 * JD content cache
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { logger } from '../core/logger.ts';

interface JDCacheEntry {
  rawJD: string;
  normalizedJD: string;
  extractedRequirements: any;
  verificationResult: any;
  canonicalSkills: string[];
  createdAt: number;
  expiresAt: number;
}

export class JDCache {
  private memory = new Map<string, JDCacheEntry>();
  private cacheDir: string;
  private ttlMs: number;

  constructor(ttlMs = 7 * 24 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
    this.cacheDir = path.join(process.cwd(), '.cache', 'jd');
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
    } catch (e) {
      logger.warn('Failed to create JD cache dir', { error: String(e) });
    }
  }

  private computeKey(source: string, jobUrl: string, jdContent: string, extractorVersion?: string): string {
    const hash = createHash('sha256');
    hash.update(source);
    hash.update(jobUrl);
    hash.update(jdContent);
    if (extractorVersion) hash.update(extractorVersion);
    return 'jd:' + hash.digest('hex').slice(0, 32);
  }

  private keyPath(key: string): string {
    return path.join(this.cacheDir, key.replace('jd:', 'jd_') + '.json');
  }

  async get(key: string): Promise<JDCacheEntry | null> {
    // L1
    const l1 = this.memory.get(key);
    if (l1 && Date.now() <= l1.expiresAt) {
      return l1;
    }

    // L2
    try {
      const p = this.keyPath(key);
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (Date.now() <= data.expiresAt) {
          this.memory.set(key, data);
          return data;
        } else {
          fs.unlinkSync(p);
        }
      }
    } catch (e) {
      logger.warn('JD cache read error', { error: String(e) });
    }
    return null;
  }

  async set(key: string, entry: Omit<JDCacheEntry, 'createdAt' | 'expiresAt'>): Promise<void> {
    const full: JDCacheEntry = {
      ...entry,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
    };
    this.memory.set(key, full);
    try {
      fs.writeFileSync(this.keyPath(key), JSON.stringify(full));
    } catch (e) {
      logger.warn('JD cache write error', { error: String(e) });
    }
  }

  generateKey(source: string, jobUrl: string, jdContent: string, extractorVersion = '1.0.0'): string {
    return this.computeKey(source, jobUrl, jdContent, extractorVersion);
  }
}

export const jdCache = new JDCache();
export default jdCache;