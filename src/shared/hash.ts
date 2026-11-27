/**
 * Hash utilities
 */
import { createHash } from 'crypto';

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function simpleHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash) + content.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}