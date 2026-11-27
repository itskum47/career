/**
 * Human Escalation Manager - handles persistent pause/resume for applications.
 */

import type {
  EscalationRecord,
  EscalationFilter,
  EscalationStats,
  PauseResumeSnapshot,
  EscalationEventType,
  EscalationEvent,
} from './types.ts';
import { generateEventId } from '../core/ids.ts';
import { logger } from '../core/logger.ts';
import { fileStorage } from '../shared/storage.ts';
import * as fs from 'fs';
import * as path from 'path';

const ESCALATION_DIR = path.join(process.cwd(), '.escalations');
const SNAPSHOT_DIR = path.join(process.cwd(), '.snapshots');

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export class EscalationManager {
  private escalations: Map<string, EscalationRecord> = new Map();
  private snapshots: Map<string, PauseResumeSnapshot> = new Map();
  private eventListeners: Set<(event: EscalationEvent) => void> = new Set();
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    ensureDir(ESCALATION_DIR);
    ensureDir(SNAPSHOT_DIR);

    // Load existing escalations from disk
    await this.loadFromDisk();

    this.initialized = true;
    logger.info('Escalation manager initialized', {
      escalationsLoaded: this.escalations.size,
      snapshotsLoaded: this.snapshots.size,
    });
  }

  private async loadFromDisk(): Promise<void> {
    try {
      // Load escalations
      const escalationFiles = fs.readdirSync(ESCALATION_DIR).filter(f => f.endsWith('.json'));
      for (const file of escalationFiles) {
        const content = fs.readFileSync(path.join(ESCALATION_DIR, file), 'utf-8');
        const escalation = JSON.parse(content) as EscalationRecord;
        escalation.createdAt = new Date(escalation.createdAt);
        escalation.updatedAt = new Date(escalation.updatedAt);
        if (escalation.answeredAt) escalation.answeredAt = new Date(escalation.answeredAt);
        if (escalation.expiresAt) escalation.expiresAt = new Date(escalation.expiresAt);
        this.escalations.set(escalation.id, escalation);
      }

      // Load snapshots
      const snapshotFiles = fs.readdirSync(SNAPSHOT_DIR).filter(f => f.endsWith('.json'));
      for (const file of snapshotFiles) {
        const content = fs.readFileSync(path.join(SNAPSHOT_DIR, file), 'utf-8');
        const snapshot = JSON.parse(content) as PauseResumeSnapshot;
        snapshot.timestamp = new Date(snapshot.timestamp);
        this.snapshots.set(snapshot.applicationId, snapshot);
      }
    } catch (error) {
      logger.warn('Failed to load escalation data from disk', { error: String(error) });
    }
  }

  private async saveEscalationToDisk(escalation: EscalationRecord): Promise<void> {
    try {
      ensureDir(ESCALATION_DIR);
      const filePath = path.join(ESCALATION_DIR, `${escalation.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(escalation, null, 2));
    } catch (error) {
      logger.error('Failed to save escalation to disk', { error: String(error), escalationId: escalation.id });
    }
  }

  private async saveSnapshotToDisk(snapshot: PauseResumeSnapshot): Promise<void> {
    try {
      ensureDir(SNAPSHOT_DIR);
      const filePath = path.join(SNAPSHOT_DIR, `${snapshot.applicationId}.json`);
      fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
    } catch (error) {
      logger.error('Failed to save snapshot to disk', { error: String(error), applicationId: snapshot.applicationId });
    }
  }

  private emit(event: EscalationEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        logger.error('Escalation event listener error', { error: String(error) });
      }
    }
  }

  addEventListener(listener: (event: EscalationEvent) => void): void {
    this.eventListeners.add(listener);
  }

  removeEventListener(listener: (event: EscalationEvent) => void): void {
    this.eventListeners.delete(listener);
  }

  // ============================================================================
  // Escalation CRUD
  // ============================================================================

  async createEscalation(
    applicationId: string,
    question: string,
    context: string,
    options?: string[],
    category: EscalationRecord['category'] = 'technical',
    urgency: EscalationRecord['urgency'] = 'medium',
    expiresAt?: Date,
    metadata?: Record<string, unknown>
  ): Promise<EscalationRecord> {
    const id = `ESC-${generateEventId().slice(4)}`;
    const now = new Date();

    const escalation: EscalationRecord = {
      id,
      applicationId,
      questionId: `Q-${applicationId}-${Date.now()}`,
      question,
      context,
      options,
      category,
      urgency,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      expiresAt,
      metadata,
    };

    this.escalations.set(id, escalation);
    await this.saveEscalationToDisk(escalation);

    this.emit({
      id: generateEventId(),
      type: 'escalation_created',
      applicationId,
      escalationId: id,
      timestamp: now,
      data: { question, category, urgency },
    });

    logger.info('Escalation created', { id, applicationId, category, urgency });
    return escalation;
  }

  /**
   * Re-read escalation + snapshot files from disk. Answers submitted from
   * another process (CLI `escalation:answer`) land on disk; the engine polls
   * this while waiting so it observes them in its in-memory map.
   */
  async reloadFromDisk(): Promise<void> {
    await this.loadFromDisk();
  }

  async getEscalation(id: string): Promise<EscalationRecord | undefined> {
    return this.escalations.get(id);
  }

  async getEscalationsByApplication(applicationId: string): Promise<EscalationRecord[]> {
    return Array.from(this.escalations.values())
      .filter(e => e.applicationId === applicationId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async getEscalations(filter: EscalationFilter = {}): Promise<EscalationRecord[]> {
    let results = Array.from(this.escalations.values());

    if (filter.applicationId) {
      results = results.filter(e => e.applicationId === filter.applicationId);
    }
    if (filter.status?.length) {
      results = results.filter(e => filter.status!.includes(e.status));
    }
    if (filter.category?.length) {
      results = results.filter(e => filter.category!.includes(e.category));
    }
    if (filter.urgency?.length) {
      results = results.filter(e => filter.urgency!.includes(e.urgency));
    }
    if (filter.dateFrom) {
      results = results.filter(e => e.createdAt >= filter.dateFrom!);
    }
    if (filter.dateTo) {
      results = results.filter(e => e.createdAt <= filter.dateTo!);
    }

    return results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async answerEscalation(
    id: string,
    answer: string,
    answeredBy: 'user' | 'cached' | 'agent' = 'user',
    confidence = 1.0,
    source = 'user-provided'
  ): Promise<EscalationRecord | null> {
    const escalation = this.escalations.get(id);
    if (!escalation) return null;
    if (escalation.status !== 'pending') {
      logger.warn('Attempted to answer non-pending escalation', { id, status: escalation.status });
      return escalation;
    }

    escalation.status = 'answered';
    escalation.answer = answer;
    escalation.answeredAt = new Date();
    escalation.answeredBy = answeredBy;
    escalation.confidence = confidence;
    escalation.source = source;
    escalation.updatedAt = new Date();

    await this.saveEscalationToDisk(escalation);

    this.emit({
      id: generateEventId(),
      type: 'escalation_answered',
      applicationId: escalation.applicationId,
      escalationId: id,
      timestamp: new Date(),
      data: { answer, answeredBy, confidence },
    });

    logger.info('Escalation answered', { id, applicationId: escalation.applicationId, answeredBy });
    return escalation;
  }

  async cancelEscalation(id: string): Promise<EscalationRecord | null> {
    const escalation = this.escalations.get(id);
    if (!escalation) return null;

    escalation.status = 'cancelled';
    escalation.updatedAt = new Date();

    await this.saveEscalationToDisk(escalation);

    this.emit({
      id: generateEventId(),
      type: 'escalation_cancelled',
      applicationId: escalation.applicationId,
      escalationId: id,
      timestamp: new Date(),
    });

    logger.info('Escalation cancelled', { id });
    return escalation;
  }

  async expireOldEscalations(): Promise<number> {
    const now = new Date();
    let count = 0;

    for (const escalation of this.escalations.values()) {
      if (escalation.status === 'pending' && escalation.expiresAt && escalation.expiresAt < now) {
        escalation.status = 'expired';
        escalation.updatedAt = now;
        await this.saveEscalationToDisk(escalation);
        count++;

        this.emit({
          id: generateEventId(),
          type: 'escalation_expired',
          applicationId: escalation.applicationId,
          escalationId: escalation.id,
          timestamp: now,
        });
      }
    }

    if (count > 0) {
      logger.info('Expired escalations', { count });
    }
    return count;
  }

  async getStats(): Promise<EscalationStats> {
    const all = Array.from(this.escalations.values());
    const byCategory: Record<string, number> = {};
    const byUrgency: Record<string, number> = {};

    for (const e of all) {
      byCategory[e.category] = (byCategory[e.category] || 0) + 1;
      byUrgency[e.urgency] = (byUrgency[e.urgency] || 0) + 1;
    }

    const answered = all.filter(e => e.status === 'answered');
    let totalResponseTime = 0;
    for (const e of answered) {
      if (e.answeredAt) {
        totalResponseTime += e.answeredAt.getTime() - e.createdAt.getTime();
      }
    }

    return {
      total: all.length,
      pending: all.filter(e => e.status === 'pending').length,
      answered: answered.length,
      expired: all.filter(e => e.status === 'expired').length,
      byCategory,
      byUrgency,
      averageResponseTimeMs: answered.length > 0 ? totalResponseTime / answered.length : 0,
    };
  }

  // ============================================================================
  // Pause/Resume Snapshots
  // ============================================================================

  async createSnapshot(
    applicationId: string,
    state: string,
    browserState?: any,
    formData?: Record<string, string>,
    escalations?: EscalationRecord[]
  ): Promise<PauseResumeSnapshot> {
    const existing = this.snapshots.get(applicationId);
    const version = (existing?.version || 0) + 1;

    const snapshot: PauseResumeSnapshot = {
      applicationId,
      state,
      browserState,
      formData,
      escalations: escalations || [],
      timestamp: new Date(),
      version,
    };

    this.snapshots.set(applicationId, snapshot);
    await this.saveSnapshotToDisk(snapshot);

    this.emit({
      id: generateEventId(),
      type: 'application_paused',
      applicationId,
      timestamp: new Date(),
      data: { state, version },
    });

    logger.info('Application snapshot created', { applicationId, state, version });
    return snapshot;
  }

  async getSnapshot(applicationId: string): Promise<PauseResumeSnapshot | undefined> {
    return this.snapshots.get(applicationId);
  }

  async resumeFromSnapshot(applicationId: string): Promise<PauseResumeSnapshot | null> {
    const snapshot = this.snapshots.get(applicationId);
    if (!snapshot) return null;

    this.emit({
      id: generateEventId(),
      type: 'application_resumed',
      applicationId,
      timestamp: new Date(),
      data: { previousState: snapshot.state, version: snapshot.version },
    });

    logger.info('Application resumed from snapshot', { applicationId, version: snapshot.version });
    return snapshot;
  }

  async clearSnapshot(applicationId: string): Promise<boolean> {
    const snapshot = this.snapshots.get(applicationId);
    if (!snapshot) return false;

    this.snapshots.delete(applicationId);

    const filePath = path.join(SNAPSHOT_DIR, `${applicationId}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    logger.info('Application snapshot cleared', { applicationId });
    return true;
  }

  // ============================================================================
  // Recovery
  // ============================================================================

  async recoverPausedApplications(): Promise<PauseResumeSnapshot[]> {
    const snapshots = Array.from(this.snapshots.values());
    logger.info('Recovering paused applications', { count: snapshots.length });

    for (const snapshot of snapshots) {
      this.emit({
        id: generateEventId(),
        type: 'application_recovered',
        applicationId: snapshot.applicationId,
        timestamp: new Date(),
        data: { state: snapshot.state, version: snapshot.version },
      });
    }

    return snapshots;
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  async cleanupOldData(olderThanDays = 30): Promise<{ escalations: number; snapshots: number }> {
    const cutoff = new Date(Date.now() - olderThanDays * 86400000);
    let escalationsRemoved = 0;
    let snapshotsRemoved = 0;

    // Clean old answered/expired/cancelled escalations
    for (const [id, escalation] of this.escalations) {
      if (
        ['answered', 'expired', 'cancelled'].includes(escalation.status) &&
        escalation.updatedAt < cutoff
      ) {
        this.escalations.delete(id);
        const filePath = path.join(ESCALATION_DIR, `${id}.json`);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
        escalationsRemoved++;
      }
    }

    // Clean old snapshots (keep latest only)
    // This is handled by version overwrite

    logger.info('Cleanup completed', { escalationsRemoved, snapshotsRemoved });
    return { escalations: escalationsRemoved, snapshots: snapshotsRemoved };
  }

  isHealthy(): boolean {
    return this.initialized;
  }
}

let globalEscalationManager: EscalationManager | null = null;

export function createEscalationManager(): EscalationManager {
  return new EscalationManager();
}

export function getEscalationManager(): EscalationManager {
  if (!globalEscalationManager) {
    globalEscalationManager = new EscalationManager();
  }
  return globalEscalationManager;
}