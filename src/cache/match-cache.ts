/**
 * Match cache for deterministic candidate matching
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { logger } from '../core/logger.ts';

interface MatchCacheEntry {
  requiredMatches: any[];
  preferredMatches: any[];
  missingSkills: string[];
  equivalences: any[];
  overallScore: number;
  recommendation: string;
  createdAt: number;
  expiresAt: number;
}

export class MatchCache {
  private memory = new Map<string, MatchCacheEntry>();
  private cacheDir: string;
  private ttlMs: number;

  constructor(ttlMs = 7 * 24 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
    this.cacheDir = path.join(process.cwd(), '.cache', 'match');
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
    } catch (e) {
      logger.warn('Failed to create match cache dir', { error: String(e) });
    }
  }

  private computeKey(candidateProfileHash: string, jdHash: string, matchingEngineVersion: string): string {
    const hash = createHash('sha256');
    hash.update(candidateProfileHash);
    hash.update(jdHash);
    hash.update(matchingEngineVersion);
    return 'match:' + hash.digest('hex').slice(0, 32);
  }

  private keyPath(key: string): string {
    return path.join(this.cacheDir, key.replace('match:', 'match_') + '.json');
  }

  async get(key: string): Promise<MatchCacheEntry | null> {
    const l1 = this.memory.get(key);
    if (l1 && Date.now() <= l1.expiresAt) return l1;
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
      logger.warn('Match cache read error', { error: String(e) });
    }
    return null;
  }

  async set(key: string, entry: Omit<MatchCacheEntry, 'createdAt' | 'expiresAt'>): Promise<void> {
    const full: MatchCacheEntry = {
      ...entry,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
    };
    this.memory.set(key, full);
    try {
      fs.writeFileSync(this.keyPath(key), JSON.stringify(full));
    } catch (e) {
      logger.warn('Match cache write error', { error: String(e) });
    }
  }

  generateKey(candidateProfileHash: string, jdHash: string, matchingEngineVersion = '1.0.0'): string {
    return this.computeKey(candidateProfileHash, jdHash, matchingEngineVersion);
  }
}

export const matchCache = new MatchCache();
export default matchCache;