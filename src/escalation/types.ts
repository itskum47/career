/**
 * Human Escalation types for persistent pause/resume.
 */

export interface EscalationRecord {
  id: string;
  applicationId: string;
  questionId: string;
  question: string;
  context: string;
  options?: string[];
  category: 'legal' | 'authorization' | 'compensation' | 'technical' | 'personal' | 'other';
  urgency: 'low' | 'medium' | 'high' | 'critical';
  status: 'pending' | 'answered' | 'expired' | 'cancelled';
  createdAt: Date;
  updatedAt: Date;
  answeredAt?: Date;
  answeredBy?: 'user' | 'cached' | 'agent';
  answer?: string;
  confidence?: number;
  source?: string;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface EscalationFilter {
  applicationId?: string;
  status?: EscalationRecord['status'][];
  category?: EscalationRecord['category'][];
  urgency?: EscalationRecord['urgency'][];
  assignedTo?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

export interface EscalationStats {
  total: number;
  pending: number;
  answered: number;
  expired: number;
  byCategory: Record<string, number>;
  byUrgency: Record<string, number>;
  averageResponseTimeMs: number;
}

export interface PauseResumeSnapshot {
  applicationId: string;
  state: string;
  browserState?: any;
  formData?: Record<string, string>;
  escalations: EscalationRecord[];
  timestamp: Date;
  version: number;
}

export type EscalationEventType =
  | 'escalation_created'
  | 'escalation_answered'
  | 'escalation_expired'
  | 'escalation_cancelled'
  | 'application_paused'
  | 'application_resumed'
  | 'application_recovered';

export interface EscalationEvent {
  id: string;
  type: EscalationEventType;
  applicationId: string;
  escalationId?: string;
  timestamp: Date;
  data?: Record<string, unknown>;
  userId?: string;
}