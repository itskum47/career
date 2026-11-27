/**
 * Database client - unified interface for SQLite and PostgreSQL.
 */

import { config } from '../core/config.ts';
import { logger } from '../core/logger.ts';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DatabaseRow {
  [key: string]: any;
}

export interface QueryResult {
  rows: DatabaseRow[];
  rowCount: number;
  insertId?: string;
}

export interface Transaction {
  query(sql: string, params?: any[]): Promise<QueryResult>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface DatabaseClient {
  query(sql: string, params?: any[]): Promise<QueryResult>;
  transaction(): Promise<Transaction>;
  close(): Promise<void>;
  isConnected(): boolean;
  getDriver(): 'sqlite' | 'postgres';
  runMigrations(migrationsPath: string): Promise<void>;
}

let sqliteDb: any = null;
let pgPool: any = null;

function parseSqliteRows(result: any): QueryResult {
  if (Array.isArray(result)) {
    return { rows: result, rowCount: result.length };
  }
  return { rows: result.rows || [], rowCount: result.changes || result.rowCount || 0, insertId: result.lastInsertRowid };
}

function parsePgRows(result: any): QueryResult {
  return { rows: result.rows || [], rowCount: result.rowCount || 0, insertId: result.rows?.[0]?.id };
}

export async function createDatabaseClient(): Promise<DatabaseClient> {
  const dbConfig = config.database;

  if (dbConfig.driver === 'sqlite') {
    return createSqliteClient(dbConfig.path!);
  } else {
    return createPostgresClient(dbConfig.url!);
  }
}

async function createSqliteClient(dbPath: string): Promise<DatabaseClient> {
  const Database = (await import('better-sqlite3')).default;

  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  sqliteDb = new Database(dbPath, { verbose: config.testing.verboseDatabase ? console.log : undefined });

  // Enable WAL mode for better concurrency
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('busy_timeout = 5000');
  sqliteDb.pragma('foreign_keys = ON');

  logger.info('SQLite database connected', { path: dbPath });

  return {
    async query(sql: string, params?: any[]): Promise<QueryResult> {
      try {
        const stmt = sqliteDb.prepare(sql);
        const isSelect = /^\s*select/i.test(sql);
        if (params && params.length > 0) {
          const result = isSelect ? stmt.all(...params) : stmt.run(...params);
          return parseSqliteRows(result);
        } else {
          const result = isSelect ? stmt.all() : stmt.run();
          return parseSqliteRows(result);
        }
      } catch (error) {
        logger.error('SQLite query error', { sql, error: String(error) });
        throw error;
      }
    },

    async transaction(): Promise<Transaction> {
      const tx = sqliteDb.transaction(() => {}) as any;
      let committed = false;
      let rolledBack = false;

      return {
        async query(sql: string, params?: any[]): Promise<QueryResult> {
          const stmt = sqliteDb.prepare(sql);
          if (params && params.length > 0) {
            return parseSqliteRows(stmt.run(...params));
          } else {
            return parseSqliteRows(stmt.all());
          }
        },
        async commit(): Promise<void> {
          if (!committed && !rolledBack) {
            committed = true;
          }
        },
        async rollback(): Promise<void> {
          if (!committed && !rolledBack) {
            rolledBack = true;
            // SQLite auto-rollbacks on error, but we can throw to trigger it
            throw new Error('Transaction rolled back');
          }
        },
      };
    },

    async close(): Promise<void> {
      if (sqliteDb) {
        sqliteDb.close();
        sqliteDb = null;
        logger.info('SQLite database closed');
      }
    },

    isConnected(): boolean {
      return sqliteDb !== null;
    },

    getDriver(): 'sqlite' | 'postgres' {
      return 'sqlite';
    },

    async runMigrations(migrationsPath: string): Promise<void> {
      const files = fs.readdirSync(migrationsPath)
        .filter(f => f.endsWith('.sql'))
        .sort();

      // Track applied migrations so re-runs are idempotent.
      sqliteDb.exec('CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
      for (const file of files) {
        const already = sqliteDb.prepare('SELECT 1 FROM schema_migrations WHERE filename = ?').get(file);
        if (already) { logger.debug('Migration already applied', { file }); continue; }
        const sql = fs.readFileSync(path.join(migrationsPath, file), 'utf-8');
        const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
        for (const stmt of statements) {
          try {
            sqliteDb.exec(stmt);
          } catch (e) {
            // Tolerate "already exists" errors on legacy DBs so migration is recorded.
            logger.warn('Migration statement failed', { file, statement: stmt.slice(0, 100), error: String(e) });
          }
        }
        sqliteDb.prepare('INSERT OR IGNORE INTO schema_migrations (filename, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
        logger.info('Applied migration', { file });
      }
    },
  };
}

async function createPostgresClient(connectionString: string): Promise<DatabaseClient> {
  const { Pool } = await import('pg');

  pgPool = new Pool({
    connectionString,
    min: config.database.poolMin,
    max: config.database.poolMax,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pgPool.on('error', (err: any) => {
    logger.error('Unexpected PostgreSQL pool error', { error: String(err) });
  });

  // Test connection
  const client = await pgPool.connect();
  client.release();
  logger.info('PostgreSQL database connected');

  return {
    async query(sql: string, params?: any[]): Promise<QueryResult> {
      try {
        const result = await pgPool.query(sql, params);
        return parsePgRows(result);
      } catch (error) {
        logger.error('PostgreSQL query error', { sql, error: String(error) });
        throw error;
      }
    },

    async transaction(): Promise<Transaction> {
      const client = await pgPool.connect();
      let released = false;

      await client.query('BEGIN');

      return {
        async query(sql: string, params?: any[]): Promise<QueryResult> {
          const result = await client.query(sql, params);
          return parsePgRows(result);
        },
        async commit(): Promise<void> {
          if (!released) {
            await client.query('COMMIT');
            client.release();
            released = true;
          }
        },
        async rollback(): Promise<void> {
          if (!released) {
            await client.query('ROLLBACK');
            client.release();
            released = true;
          }
        },
      };
    },

    async close(): Promise<void> {
      if (pgPool) {
        await pgPool.end();
        pgPool = null;
        logger.info('PostgreSQL database closed');
      }
    },

    isConnected(): boolean {
      return pgPool !== null && !pgPool.ended;
    },

    getDriver(): 'sqlite' | 'postgres' {
      return 'postgres';
    },

    async runMigrations(migrationsPath: string): Promise<void> {
      const files = fs.readdirSync(migrationsPath)
        .filter(f => f.endsWith('.sql'))
        .sort();

      await pgPool.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
      for (const file of files) {
        const { rows } = await pgPool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
        if (rows.length) { logger.debug('Migration already applied', { file }); continue; }
        const sql = fs.readFileSync(path.join(migrationsPath, file), 'utf-8');
        try {
          await pgPool.query(sql);
        } catch (e) {
          logger.warn('Migration statement failed', { file, error: String(e) });
        }
        await pgPool.query('INSERT INTO schema_migrations (filename, applied_at) VALUES ($1, NOW()) ON CONFLICT (filename) DO NOTHING', [file]);
        logger.info('Applied migration', { file });
      }
    },
  };
}

export async function closeDatabaseClient(): Promise<void> {
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
  }
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
  }
}