-- Database schema for job-agent
-- Works with both PostgreSQL and SQLite (with minor adjustments)

-- ============================================================================
-- Core tables
-- ============================================================================

-- Companies
CREATE TABLE IF NOT EXISTS companies (
    company_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    domain TEXT,
    career_url TEXT,
    ats_type TEXT,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Jobs discovered
CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(company_id),
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    location TEXT,
    remote BOOLEAN DEFAULT FALSE,
    remote_policy TEXT,
    seniority TEXT,
    employment_type TEXT,
    url TEXT NOT NULL UNIQUE,
    description TEXT,
    salary_text TEXT,
    posted_at TIMESTAMP,
    discovered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    verified BOOLEAN DEFAULT FALSE,
    verification_confidence REAL,
    raw_data TEXT
);

-- Job Descriptions (extracted/structured)
CREATE TABLE IF NOT EXISTS job_descriptions (
    job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,
    required_skills TEXT NOT NULL, -- JSON array of SkillRequirement
    preferred_skills TEXT NOT NULL,
    nice_to_have_skills TEXT NOT NULL,
    responsibilities TEXT NOT NULL, -- JSON array
    experience_requirements TEXT NOT NULL,
    education_requirements TEXT NOT NULL,
    certifications TEXT NOT NULL,
    cloud_platforms TEXT NOT NULL,
    programming_languages TEXT NOT NULL,
    devops_tools TEXT NOT NULL,
    cicd_tools TEXT NOT NULL,
    monitoring_tools TEXT NOT NULL,
    databases TEXT NOT NULL,
    security_requirements TEXT NOT NULL,
    keywords TEXT NOT NULL,
    salary JSON,
    visa_requirements JSON,
    application_questions TEXT NOT NULL,
    other_constraints TEXT NOT NULL,
    full_text TEXT NOT NULL,
    extracted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    confidence REAL,
    extraction_method TEXT
);

-- Candidate profile (master profile)
CREATE TABLE IF NOT EXISTS candidate_profiles (
    candidate_id TEXT PRIMARY KEY,
    personal_info TEXT NOT NULL, -- JSON PersonalInfo
    education TEXT NOT NULL,
    experience TEXT NOT NULL,
    projects TEXT NOT NULL,
    skills TEXT NOT NULL,
    certifications TEXT NOT NULL,
    achievements TEXT NOT NULL,
    preferences TEXT NOT NULL,
    authorization TEXT NOT NULL,
    compensation TEXT NOT NULL,
    question_answers TEXT NOT NULL,
    version INTEGER DEFAULT 1,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Match analysis results
CREATE TABLE IF NOT EXISTS match_analyses (
    match_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    candidate_id TEXT NOT NULL REFERENCES candidate_profiles(candidate_id) ON DELETE CASCADE,
    overall_score REAL NOT NULL,
    required_skill_coverage REAL,
    preferred_skill_coverage REAL,
    experience_match REAL,
    project_relevance REAL,
    cloud_platform_match REAL,
    education_match REAL,
    location_match REAL,
    authorization_compatibility REAL,
    keyword_coverage REAL,
    missing_required TEXT NOT NULL, -- JSON array of SkillGap
    missing_preferred TEXT NOT NULL,
    explanation TEXT,
    recommendation TEXT,
    confidence REAL,
    analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Resumes/CVs generated
CREATE TABLE IF NOT EXISTS resumes (
    resume_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    application_id TEXT REFERENCES applications(application_id) ON DELETE SET NULL,
    candidate_id TEXT NOT NULL REFERENCES candidate_profiles(candidate_id) ON DELETE CASCADE,
    version INTEGER DEFAULT 1,
    format TEXT NOT NULL,
    file_path TEXT NOT NULL,
    ats_score REAL,
    ats_details TEXT, -- JSON ATSScore
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    generator_version TEXT
);

-- Cover letters
CREATE TABLE IF NOT EXISTS cover_letters (
    cover_letter_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    application_id TEXT REFERENCES applications(application_id) ON DELETE SET NULL,
    candidate_id TEXT NOT NULL REFERENCES candidate_profiles(candidate_id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    file_path TEXT,
    template_id TEXT,
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Applications
CREATE TABLE IF NOT EXISTS applications (
    application_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    candidate_id TEXT NOT NULL REFERENCES candidate_profiles(candidate_id) ON DELETE CASCADE,
    company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    status TEXT NOT NULL,
    resume_id TEXT REFERENCES resumes(resume_id) ON DELETE SET NULL,
    cover_letter_id TEXT REFERENCES cover_letters(cover_letter_id) ON DELETE SET NULL,
    browser_session_id TEXT,
    confirmation_id TEXT,
    submitted_at TIMESTAMP,
    confirmed_at TIMESTAMP,
    error TEXT,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    next_action TEXT,
    next_action_at TIMESTAMP
);

-- Application events (audit log)
CREATE TABLE IF NOT EXISTS application_events (
    event_id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(application_id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    agent TEXT,
    message TEXT NOT NULL,
    metadata TEXT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Browser sessions
CREATE TABLE IF NOT EXISTS browser_sessions (
    session_id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(application_id) ON DELETE CASCADE,
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    state TEXT NOT NULL,
    cookies TEXT NOT NULL, -- JSON array
    local_storage TEXT NOT NULL, -- JSON object
    screenshot_paths TEXT NOT NULL, -- JSON array
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Question answers cache
CREATE TABLE IF NOT EXISTS question_answers (
    answer_id TEXT PRIMARY KEY,
    question_hash TEXT NOT NULL UNIQUE,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    category TEXT NOT NULL,
    source TEXT NOT NULL,
    answered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,
    confidence REAL,
    used_count INTEGER DEFAULT 0
);

-- ============================================================================
-- Indexes
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company_id);
CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
CREATE INDEX IF NOT EXISTS idx_jobs_discovered ON jobs(discovered_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_verified ON jobs(verified);

CREATE INDEX IF NOT EXISTS idx_applications_job ON applications(job_id);
CREATE INDEX IF NOT EXISTS idx_applications_candidate ON applications(candidate_id);
CREATE INDEX IF NOT EXISTS idx_applications_state ON applications(state);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_created ON applications(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_application ON application_events(application_id);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON application_events(timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_browser_sessions_application ON browser_sessions(application_id);
CREATE INDEX IF NOT EXISTS idx_browser_sessions_job ON browser_sessions(job_id);

CREATE INDEX IF NOT EXISTS idx_match_job ON match_analyses(job_id);
CREATE INDEX IF NOT EXISTS idx_match_candidate ON match_analyses(candidate_id);

CREATE INDEX IF NOT EXISTS idx_resumes_job ON resumes(job_id);
CREATE INDEX IF NOT EXISTS idx_resumes_application ON resumes(application_id);

CREATE INDEX IF NOT EXISTS idx_cover_job ON cover_letters(job_id);
CREATE INDEX IF NOT EXISTS idx_cover_application ON cover_letters(application_id);

-- ============================================================================
-- Triggers for updated_at (PostgreSQL specific - SQLite handles differently)
-- ============================================================================