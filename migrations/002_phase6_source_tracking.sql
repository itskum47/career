-- Phase 6R — Source/route tracking columns for jobs + applications.
-- Answers: "Where was this job found?" and "Where was it actually submitted?"
--
-- NOTE: the migration runner executes statements individually and warns on
-- failure, so idempotency here = IF NOT EXISTS guards where possible.
-- SQLite < 3.35 lacks ADD COLUMN IF NOT EXISTS, so column adds are wrapped
-- by the runner's per-statement try/catch (re-runs warn harmlessly).

-- jobs: discovery + identity + route
ALTER TABLE jobs ADD COLUMN source_job_id TEXT;
ALTER TABLE jobs ADD COLUMN discovered_from TEXT;
ALTER TABLE jobs ADD COLUMN canonical_source TEXT;
ALTER TABLE jobs ADD COLUMN canonical_job_url TEXT;
ALTER TABLE jobs ADD COLUMN application_url TEXT;
ALTER TABLE jobs ADD COLUMN application_route TEXT;
ALTER TABLE jobs ADD COLUMN ats_type TEXT;
ALTER TABLE jobs ADD COLUMN jd_hash TEXT;
ALTER TABLE jobs ADD COLUMN jd_complete BOOLEAN DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN canonical_key TEXT;
ALTER TABLE jobs ADD COLUMN dedupe_confidence REAL;
ALTER TABLE jobs ADD COLUMN allowed_countries TEXT;
ALTER TABLE jobs ADD COLUMN timezone TEXT;
ALTER TABLE jobs ADD COLUMN priority_score REAL;
ALTER TABLE jobs ADD COLUMN priority_rank INTEGER;
ALTER TABLE jobs ADD COLUMN ineligible_reasons TEXT;

-- applications: where the submission actually happened
ALTER TABLE applications ADD COLUMN discovered_from TEXT;
ALTER TABLE applications ADD COLUMN canonical_source TEXT;
ALTER TABLE applications ADD COLUMN application_route TEXT;
ALTER TABLE applications ADD COLUMN ats_type TEXT;
ALTER TABLE applications ADD COLUMN application_url TEXT;
ALTER TABLE applications ADD COLUMN source_job_id TEXT;
ALTER TABLE applications ADD COLUMN canonical_key TEXT;
ALTER TABLE applications ADD COLUMN login_interrupted BOOLEAN DEFAULT FALSE;
ALTER TABLE applications ADD COLUMN captcha_interrupted BOOLEAN DEFAULT FALSE;

-- cross-source occurrences preserved as metadata (6F)
CREATE TABLE IF NOT EXISTS job_occurrences (
    occurrence_id TEXT PRIMARY KEY,
    canonical_key TEXT NOT NULL,
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    source_job_id TEXT,
    source_url TEXT NOT NULL,
    discovered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    dedupe_confidence REAL
);
CREATE INDEX IF NOT EXISTS idx_job_occurrences_canonical ON job_occurrences(canonical_key);
CREATE INDEX IF NOT EXISTS idx_job_occurrences_source ON job_occurrences(source);

-- per-source health snapshots (6N)
CREATE TABLE IF NOT EXISTS source_health (
    source TEXT PRIMARY KEY,
    state TEXT DEFAULT 'healthy',
    searches_attempted INTEGER DEFAULT 0,
    searches_completed INTEGER DEFAULT 0,
    jobs_discovered INTEGER DEFAULT 0,
    jobs_normalized INTEGER DEFAULT 0,
    duplicates INTEGER DEFAULT 0,
    unique_jobs INTEGER DEFAULT 0,
    jd_retrieval_success INTEGER DEFAULT 0,
    jd_retrieval_attempts INTEGER DEFAULT 0,
    route_resolution_success INTEGER DEFAULT 0,
    route_resolution_attempts INTEGER DEFAULT 0,
    application_success INTEGER DEFAULT 0,
    application_attempts INTEGER DEFAULT 0,
    failures INTEGER DEFAULT 0,
    login_interruptions INTEGER DEFAULT 0,
    captcha_interruptions INTEGER DEFAULT 0,
    timeouts INTEGER DEFAULT 0,
    avg_latency_ms REAL DEFAULT 0,
    last_error TEXT,
    last_error_at TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
