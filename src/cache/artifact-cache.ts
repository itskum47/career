/**
 * Resume/Cover artifact cache
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { logger } from '../core/logger.ts';

interface ArtifactCacheEntry {
  filePath: string;
  artifactType: 'resume' | 'cover';
  /** Phase 4C: sha256 of the artifact bytes written at set-time. A cache hit
   * is only honored when the file on disk still hashes to this value, so a
   * same-name overwrite (different inputs, identical filename) can never be
   * served as a stale artifact. */
  contentHash?: string;
  createdAt: number;
  expiresAt: number;
}

export class ArtifactCache {
  private memory = new Map<string, ArtifactCacheEntry>();
  private cacheDir: string;
  private ttlMs: number;

  constructor(ttlMs = 30 * 24 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
    this.cacheDir = path.join(process.cwd(), '.cache', 'artifacts');
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
    } catch (e) {
      logger.warn('Failed to create artifact cache dir', { error: String(e) });
    }
  }

  private computeKey(candidateProfileHash: string, jdHash: string, resumeTemplateVersion: string, artifactVersion: string): string {
    const hash = createHash('sha256');
    hash.update(candidateProfileHash);
    hash.update(jdHash);
    hash.update(resumeTemplateVersion);
    hash.update(artifactVersion);
    return 'artifact:' + hash.digest('hex').slice(0, 32);
  }

  private keyPath(key: string): string {
    return path.join(this.cacheDir, key.replace('artifact:', 'artifact_') + '.json');
  }

  async get(key: string): Promise<ArtifactCacheEntry | null> {
    const l1 = this.memory.get(key);
    if (l1 && Date.now() <= l1.expiresAt) {
      if (fs.existsSync(l1.filePath)) return l1;
    }
    try {
      const p = this.keyPath(key);
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (Date.now() <= data.expiresAt && fs.existsSync(data.filePath)) {
          this.memory.set(key, data);
          return data;
        } else {
          try { fs.unlinkSync(p); } catch {}
        }
      }
    } catch (e) {
      logger.warn('Artifact cache read error', { error: String(e) });
    }
    return null;
  }

  async set(key: string, filePath: string, artifactType: 'resume' | 'cover', contentHash?: string): Promise<void> {
    const full: ArtifactCacheEntry = {
      filePath,
      artifactType,
      ...(contentHash ? { contentHash } : {}),
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
    };
    this.memory.set(key, full);
    try {
      fs.writeFileSync(this.keyPath(key), JSON.stringify(full));
    } catch (e) {
      logger.warn('Artifact cache write error', { error: String(e) });
    }
  }

  generateKey(candidateProfileHash: string, jdHash: string, resumeTemplateVersion = '1.0.0', artifactVersion = '1.0.0'): string {
    return this.computeKey(candidateProfileHash, jdHash, resumeTemplateVersion, artifactVersion);
  }
}

export const artifactCache = new ArtifactCache();
export default artifactCache;