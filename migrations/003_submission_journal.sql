-- Phase 6W/6X — Submission journal (crash-safe, durable safety boundary).
--
-- Why: the previous lifecycle persisted the application only AFTER the
-- submission call returned. A crash between the Submit click and that write
-- (measured 2026-10-08, APP-20261008-000099, one real click at 10:41:03.612)
-- erased all knowledge that a real click had happened, so the duplicate guard
-- could not protect the next run.
--
-- The journal is append-only and is written BEFORE the irreversible click, so
-- "a submit was started" survives process termination. Phases:
--   started   — intent persisted immediately BEFORE the click
--   request   — a submission-shaped request was observed
--   response  — its response status was observed
--   confirmed — the ATS confirmed the application (confirmation was seen)
--   uncertain — clicked but not confirmed (SUBMISSION_UNCERTAIN, never auto-retry)
--   failed    — the click/submission demonstrably did not go through
--
-- No secrets are stored: host/path/method/status/timing only, never headers,
-- cookies, CSRF values, presigned query strings or payloads.

CREATE TABLE IF NOT EXISTS submission_journal (
    entry_id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    candidate_id TEXT,
    company_id TEXT,
    application_route TEXT,
    ats_type TEXT,
    phase TEXT NOT NULL,
    method TEXT,
    host TEXT,
    path TEXT,
    status INTEGER,
    resource_type TEXT,
    elapsed_ms INTEGER,
    session_id TEXT,
    detail TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_submission_journal_app ON submission_journal(application_id);
CREATE INDEX IF NOT EXISTS idx_submission_journal_job ON submission_journal(job_id);
CREATE INDEX IF NOT EXISTS idx_submission_journal_phase ON submission_journal(phase);

-- applications: durable "a click was started" marker + last journalled phase
ALTER TABLE applications ADD COLUMN submission_started_at TIMESTAMP;
ALTER TABLE applications ADD COLUMN submission_state TEXT;