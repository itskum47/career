/**
 * Profile loader - loads master profile from YAML file.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';
import * as yaml from 'yaml';
import type { MasterProfile, CandidateId } from '../core/types.ts';
import { config } from '../core/config.ts';
import { logger } from '../core/logger.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let cachedProfile: MasterProfile | null = null;

export const PROFILE_FILE = 'profile/master_profile.yaml';

export async function loadProfile(profilePath?: string): Promise<MasterProfile> {
  if (cachedProfile) return cachedProfile;

  const actualPath = path.join(__dirname, '../../profile/master_profile.yaml');

  if (!fs.existsSync(actualPath)) {
    throw new Error(
      `Profile not found at ${actualPath}. ` +
      `Copy profile/master_profile.example.yaml to profile/master_profile.yaml and fill in your details, then re-run.`
    );
  }

  const content = fs.readFileSync(actualPath, 'utf-8');
  const data = yaml.parse(content);

  // Convert dates
  cachedProfile = convertDates(data) as MasterProfile;
  // Phase 9: stamp the content hash so every artifact built from this profile
  // records which version it came from.
  cachedProfile.profileVersion = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;

  logger.info('Master profile loaded', { candidateId: cachedProfile.candidateId });
  return cachedProfile;
}

/**
 * Phase 9 — load the profile together with its version (a sha256 content hash).
 *
 * Every generated artifact records this version, so a document can always be
 * traced back to the exact profile it came from, and a profile edit invalidates
 * artifacts generated before it.
 */
export async function loadProfileWithMeta(profilePath?: string): Promise<{ profile: MasterProfile; profileVersion: string; sourcePath: string }> {
  const actualPath = profilePath ?? path.join(__dirname, '../../profile/master_profile.yaml');
  if (!fs.existsSync(actualPath)) {
    throw new Error(
      `Profile not found at ${actualPath}. ` +
      `Copy profile/master_profile.example.yaml to profile/master_profile.yaml and fill in your details, then re-run.`
    );
  }
  const content = fs.readFileSync(actualPath, 'utf-8');
  const profile = convertDates(yaml.parse(content)) as MasterProfile;
  const profileVersion = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
  profile.profileVersion = profileVersion;
  if (!profilePath) cachedProfile = profile;
  logger.info('Master profile loaded with version', { candidateId: profile.candidateId, profileVersion });
  return { profile, profileVersion, sourcePath: actualPath };
}

/**
 * The ACTIVE profile version, computed from the file on disk (never cached), so
 * an approval can never be matched against a stale in-memory copy.
 */
export function activeProfileVersion(): string {
  const actualPath = path.join(__dirname, '../../profile/master_profile.yaml');
  const content = fs.readFileSync(actualPath, 'utf-8');
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

function convertDates(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj;

  if (obj instanceof Date) return obj;

  if (Array.isArray(obj)) {
    return obj.map(convertDates);
  }

  const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && isDateString(value) && isDateKey(key)) {
      result[key] = new Date(value);
    } else if (typeof value === 'object' && value !== null) {
      result[key] = convertDates(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function isDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?)?$/.test(value);
}

function isDateKey(key: string): boolean {
  const dateKeys = [
    'startDate', 'endDate', 'issueDate', 'expiryDate', 'answeredAt',
    'expiresAt', 'updatedAt', 'extractedAt', 'analyzedAt', 'generatedAt',
    'createdAt', 'timestamp', 'postedAt', 'availableFrom', 'lastUsed'
  ];
  return dateKeys.includes(key);
}

export function clearProfileCache(): void {
  cachedProfile = null;
}