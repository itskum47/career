/**
 * Structured logging with Winston.
 * JSON output for machines, pretty for terminals.
 */

import winston from 'winston';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logDir = config.observability.logDir;
const logFormat = config.observability.structuredLogs
  ? winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      winston.format.errors({ stack: true }),
      winston.format.json()
    )
  : winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      winston.format.errors({ stack: true }),
      winston.format.colorize(),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        return `${timestamp} [${level}]: ${message}${metaStr}`;
      })
    );

const transports: winston.transport[] = [
  new winston.transports.Console({
    level: config.observability.logLevel,
    format: logFormat,
  }),
];

// File transports
const logFiles = [
  { filename: 'agent.log', level: 'debug' },
  { filename: 'discovery.log', level: 'debug' },
  { filename: 'jd.log', level: 'debug' },
  { filename: 'resume.log', level: 'debug' },
  { filename: 'browser.log', level: 'debug' },
  { filename: 'application.log', level: 'debug' },
  { filename: 'error.log', level: 'error' },
];

for (const { filename, level } of logFiles) {
  transports.push(
    new winston.transports.File({
      filename: path.join(logDir, filename),
      level,
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
    })
  );
}

export const logger = winston.createLogger({
  level: config.observability.logLevel,
  transports,
  defaultMeta: { service: 'job-agent' },
  exitOnError: false,
});

export function createChildLogger(context: Record<string, unknown>): winston.Logger {
  return logger.child(context);
}

export function logAgentResult(agent: string, result: {
  jobId?: string;
  applicationId?: string;
  status: string;
  confidence: number;
  errors: Array<{ code: string; message: string }>;
  durationMs: number;
}): void {
  logger.info('Agent completed', { agent, ...result });
}

export function logApplicationEvent(applicationId: string, event: {
  type: string;
  fromState?: string;
  toState: string;
  message: string;
  metadata?: Record<string, unknown>;
}): void {
  logger.info('Application event', { applicationId, ...event });
}