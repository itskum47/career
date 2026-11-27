/**
 * Filesystem helpers that never throw on permission errors.
 *
 * Some output directories (e.g. ~/Desktop/cv) may be unavailable in restricted
 * environments such as sandboxes. mkdir/write failures there must not crash the
 * whole pipeline - they surface as warnings and the caller decides how to
 * proceed. On a normal Mac Terminal these paths work fine.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../core/logger.ts';

export function safeMkdirSync(dir: string): boolean {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return true;
  } catch (error) {
    logger.warn('Could not create directory', { path: dir, error: String(error) });
    return false;
  }
}

export function safeWriteFile(filePath: string, content: Buffer | string): boolean {
  try {
    const dir = path.dirname(filePath);
    if (!safeMkdirSync(dir)) return false;
    fs.writeFileSync(filePath, content);
    return true;
  } catch (error) {
    logger.warn('Could not write file', { path: filePath, error: String(error) });
    return false;
  }
}