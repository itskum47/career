

<pasted_content id="daed">
# BUILD A FULLY AUTONOMOUS MULTI-AGENT JOB APPLICATION SYSTEM

You are a senior staff/principal software engineer, AI-agent architect, browser automation engineer, DevOps engineer, data engineer, and security engineer.

Your job is to **actually build a working autonomous job application platform**, not merely describe one.

Use these projects as references:

* Career-ops: https://career-ops.org/
* Offer Toolkit Skill: https://github.com/yanliudesign/offer-toolkit-skill

Study their architecture and useful ideas, but do not blindly copy them. Build a stronger integrated system.

The final system must discover jobs, read and understand every JD, generate a job-specific CV and cover letter, open the actual application website, fill the application, upload the correct documents, ask the user only when necessary, resume from the exact point where it stopped, submit the application when permitted by configuration, verify the submission, maintain an Excel tracker, maintain a database, and monitor application outcomes.

---

# 1. CORE OBJECTIVE

Build an autonomous system that performs this complete workflow:

```text
JOB DISCOVERY
      ↓
DEDUPLICATION
      ↓
OPEN JOB
      ↓
EXTRACT COMPLETE JD
      ↓
VERIFY JD
      ↓
ANALYZE JD
      ↓
MATCH AGAINST MASTER PROFILE
      ↓
APPLY / SKIP DECISION
      ↓
CREATE JOB-SPECIFIC CV
      ↓
ATS VALIDATION
      ↓
REVISE CV IF NECESSARY
      ↓
CREATE JOB-SPECIFIC COVER LETTER
      ↓
SAVE DOCUMENTS
      ↓
OPEN REAL APPLICATION WEBSITE
      ↓
UNDERSTAND FORM
      ↓
FILL KNOWN QUESTIONS
      ↓
ASK USER ONLY WHEN NECESSARY
      ↓
RESUME
      ↓
UPLOAD EXACT JOB-SPECIFIC DOCUMENTS
      ↓
VALIDATE FORM
      ↓
SUBMIT
      ↓
VERIFY SUBMISSION
      ↓
DATABASE UPDATE
      ↓
EXCEL UPDATE
      ↓
EMAIL / STATUS MONITORING
```

The system must be stateful and resumable.

A crash must not mean starting the application from scratch.

---

# 2. MULTI-AGENT ARCHITECTURE

Use multiple specialized agents/workers rather than one giant LLM prompt.

Create an orchestration layer that coordinates them.

Recommended agents:

```text
Orchestrator Agent

Discovery Agents
├── LinkedIn Discovery Agent
├── Indeed Discovery Agent
├── Greenhouse Discovery Agent
├── Lever Discovery Agent
├── Ashby Discovery Agent
└── Company Career Page Agent

Job Intelligence Agents
├── JD Extraction Agent
├── JD Verification Agent
├── JD Analysis Agent
└── Job Deduplication Agent

Candidate Agents
├── Candidate Match Agent
├── Resume Agent
├── ATS Optimization Agent
└── Cover Letter Agent

Browser Agents
├── Browser Navigation Agent
├── ATS Detection Agent
├── Form Understanding Agent
├── Application Question Agent
├── File Upload Agent
└── Submission Verification Agent

Support Agents
├── Human Escalation Agent
├── Application Tracking Agent
├── Email Monitoring Agent
└── Recovery Agent
```

Do not make every agent an independent unrestricted LLM.

Prefer deterministic code for deterministic operations.

Use LLM reasoning where semantic understanding is actually required.

---

# 3. PARALLEL AGENT EXECUTION

Use parallel execution whenever tasks are independent.

For example:

```text
                JOB DISCOVERY
                     │
       ┌─────────────┼─────────────┐
       ↓             ↓             ↓
   LinkedIn       Indeed       Greenhouse
       │             │             │
       └─────────────┼─────────────┘
                     ↓
                 DEDUPE
```

Similarly, after a JD has been verified:

```text
                VERIFIED JD
                     │
        ┌────────────┼────────────┐
        ↓            ↓            ↓
    JD Analysis   Candidate     Metadata
                   Match        extraction
        │            │            │
        └────────────┼────────────┘
                     ↓
                  MERGE
```

After the job is approved:

```text
              APPROVED JOB
                    │
          ┌─────────┴─────────┐
          ↓                   ↓
    Resume Agent       Cover Letter Agent
          ↓                   ↓
    ATS Validator             │
          ↓                   │
          └─────────┬─────────┘
                    ↓
                  MERGE
```

Do NOT parallelize operations that can conflict with the same browser session.

For example:

```text
DO NOT:
Agent A fills form
Agent B clicks next
Agent C uploads CV
```

Instead, one browser session must have a single authoritative browser controller.

---

# 4. ORCHESTRATOR

Create one orchestrator responsible for:

* task scheduling
* agent dispatch
* state transitions
* concurrency limits
* retries
* failures
* human escalation
* merging agent outputs
* database updates
* Excel synchronization

The orchestrator must be deterministic.

Every agent should return structured output.

Example:

```json
{
  "agent": "jd-analysis",
  "job_id": "JOB-123",
  "status": "SUCCESS",
  "result": {},
  "confidence": 0.94,
  "errors": []
}
```

---

# 5. JOB DISCOVERY

Build modular discovery adapters for supported sources.

Where technically and legally feasible:

* LinkedIn
* Indeed
* Greenhouse
* Lever
* Ashby
* company career pages
* other ATS platforms

Each discovery worker should return normalized jobs.

```json
{
  "job_id": "...",
  "company": "...",
  "title": "...",
  "location": "...",
  "remote": true,
  "url": "...",
  "source": "...",
  "posted_at": "...",
  "description": ""
}
```

Use controlled concurrency.

Do not hammer websites.

Respect applicable terms, rate limits, and anti-automation controls.

Do not implement CAPTCHA bypasses or security-control evasion.

---

# 6. COMPLETE JD REQUIREMENT

This is a HARD GATE.

No verified JD means:

```text
NO CV
NO COVER LETTER
NO APPLICATION
```

The system must verify that the JD contains meaningful content.

If extraction fails:

```text
retry
↓
render page
↓
inspect DOM
↓
inspect accessibility tree
↓
use ATS adapter
↓
retry
↓
human escalation / BLOCKED
```

Never silently continue using only the job title.

---

# 7. JD ANALYSIS

Analyze every JD.

Extract:

```text
job title
company
location
remote policy
seniority
required skills
preferred skills
responsibilities
experience requirements
education
certifications
cloud platforms
programming languages
DevOps tools
CI/CD tools
monitoring tools
databases
security requirements
keywords
salary
visa requirements
application questions
other constraints
```

Separate:

```text
REQUIRED
PREFERRED
NICE_TO_HAVE
```

---

# 8. MASTER CANDIDATE PROFILE

Create a structured source of truth:

```text
profile/
├── master_profile.yaml
├── personal.yaml
├── education.yaml
├── experience.yaml
├── projects.yaml
├── skills.yaml
├── certifications.yaml
├── achievements.yaml
├── preferences.yaml
├── authorization.yaml
├── compensation.yaml
└── question_answers.yaml
```

The master profile must never be modified by resume tailoring.

It contains only verified candidate information.

---

# 9. ZERO FABRICATION POLICY

The system may:

* reorder information
* emphasize relevant skills
* rewrite truthful descriptions
* improve wording
* use relevant JD terminology
* prioritize relevant projects

The system must NOT invent:

* experience
* years of experience
* employers
* job titles
* certifications
* projects
* technologies
* achievements
* qualifications
* legal status
* immigration status
* salary history

If a requirement is not supported by the master profile:

```text
mark as missing
```

Do not fabricate it.

---

# 10. CANDIDATE MATCHING

For every job calculate:

```text
overall match
required skill coverage
preferred skill coverage
experience match
project relevance
cloud/platform match
education match
location match
authorization compatibility
keyword coverage
missing requirements
```

Store the explanation, not just a number.

Example:

```json
{
  "overall": 87,
  "required_skill_coverage": 92,
  "experience_match": 85,
  "project_match": 90,
  "missing_required": [],
  "missing_preferred": ["Ansible Tower"]
}
```

Make the threshold configurable.

---

# 11. JOB-SPECIFIC CV

This is mandatory.

EVERY APPLICATION MUST RECEIVE A FRESH JOB-SPECIFIC CV.

Never simply upload the master CV.

Pipeline:

```text
verified JD
↓
JD analysis
↓
candidate evidence matching
↓
resume generation
↓
ATS analysis
↓
revision
↓
final CV
```

Tailor:

* professional summary
* skills ordering
* experience emphasis
* project emphasis
* bullet wording
* relevant technologies
* relevant achievements

Remain truthful.

---

# 12. ATS OPTIMIZATION

Run an ATS validation agent.

Check:

```text
required keyword coverage
skill coverage
experience relevance
section structure
formatting
parsing
readability
JD alignment
```

If below threshold:

```text
revise
↓
validate
```

Maximum three revision cycles unless configured otherwise.

Store the final score.

---

# 13. CV STORAGE

All generated CVs must be stored in:

```text
~/Desktop/cv/
```

Create it automatically.

Example:

```text
~/Desktop/cv/
├── Amazon_AWS_DevOps_Engineer_2026-09-27.pdf
├── Amazon_AWS_DevOps_Engineer_2026-09-27.docx
├── Google_SRE_2026-09-27.pdf
└── Microsoft_Cloud_Engineer_2026-09-27.pdf
```

Never overwrite an existing CV.

The database must store the exact path.

The browser must upload the exact registered CV for that application.

Never randomly select a CV from the folder.

---

# 14. COVER LETTER

Generate a job-specific cover letter where appropriate.

Use verified candidate information.

Make it specific to the company and role.

Avoid generic filler.

Store the exact path in the database.

---

# 15. BROWSER AUTOMATION

Use Playwright or an equivalent robust browser automation framework.

Maintain a persistent browser profile:

```text
~/.job-agent/browser-profile/
```

The browser agent must support:

* navigation
* clicking
* typing
* dropdowns
* checkboxes
* radio buttons
* scrolling
* dynamic content
* dialogs
* file uploads
* validation errors
* screenshots
* accessibility tree
* visible text extraction

---

# 16. FORM UNDERSTANDING

Do not rely exclusively on brittle CSS selectors.

Use:

```text
labels
aria-label
role
accessible name
placeholder
nearby text
DOM relationships
semantic classification
```

Example:

```json
{
  "label": "First Name",
  "type": "text",
  "confidence": 0.99,
  "source": "profile.personal.first_name"
}
```

---

# 17. APPLICATION QUESTION ENGINE

Classify questions:

```text
KNOWN
DERIVABLE
USER_REQUIRED
UNSAFE_TO_GUESS
```

Examples:

```text
First name
→ KNOWN

Years of AWS experience
→ DERIVABLE

Visa sponsorship
→ USER_REQUIRED unless explicitly configured

Non-compete agreement
→ USER_REQUIRED

Legal declaration
→ USER_REQUIRED
```

Never guess consequential information.

---

# 18. HUMAN-IN-THE-LOOP

When the agent genuinely gets stuck:

```text
PAUSE
↓
SAVE browser state
↓
SAVE URL
↓
SAVE screenshot
↓
SAVE application state
↓
ASK USER
```

Example:

```text
APPLICATION PAUSED

Company: Example Corp
Role: DevOps Engineer

Question:
Are you subject to any non-compete restrictions?

I do not have a verified answer.

Please provide the answer.
```

After the user answers:

```text
store answer
↓
resume exact browser state
↓
continue
```

Do not restart the application.

---

# 19. CAPTCHA / MFA / LOGIN

Never bypass security controls.

If CAPTCHA appears:

```text
pause
ask user to complete it
resume
```

If MFA appears:

```text
pause
ask user
resume
```

If login is required:

```text
pause
ask user to authenticate
resume
```

Never store passwords.

---

# 20. APPLICATION SUBMISSION

Make submission configurable.

Development:

```yaml
auto_submit: false
```

Production:

```yaml
auto_submit: true
```

Before submission verify:

```text
correct company
correct role
correct application
JD verified
correct CV
correct cover letter
required fields complete
no unresolved questions
no validation errors
not already submitted
```

Only then submit.

---

# 21. SUBMISSION VERIFICATION

Do not assume Submit succeeded.

Detect:

* confirmation page
* confirmation text
* confirmation ID
* application ID
* redirect
* confirmation email

If ambiguous:

```text
SUBMISSION_UNCERTAIN
```

Do not automatically resubmit.

---

# 22. DATABASE

Use PostgreSQL as the machine-readable source of truth.

Tables:

```text
jobs
job_descriptions
candidate_profiles
resume_versions
cover_letters
applications
application_events
application_questions
question_answers
browser_sessions
companies
email_events
```

Every application gets a unique ID.

Example:

```text
APP-2026-000001
```

---

# 23. APPLICATION STATE MACHINE

Implement explicit states:

```text
DISCOVERED
VERIFIED
ANALYZED
MATCHED
SKIPPED
RESUME_GENERATED
RESUME_VALIDATED
READY_TO_APPLY
BROWSER_STARTED
FORM_ANALYZING
FORM_FILLING
PAUSED_FOR_USER
READY_TO_SUBMIT
SUBMITTED
CONFIRMED
REJECTED
INTERVIEW
ASSESSMENT
OFFER
WITHDRAWN
BLOCKED
SUBMISSION_UNCERTAIN
ERROR
```

Every state transition creates an event.

The system must resume from the last valid state after crashes.

---

# 24. EXCEL TRACKER

The system MUST maintain an Excel workbook at:

```text
~/Desktop/job-applications.xlsx
```

Excel is the human-readable tracking layer.

PostgreSQL remains the source of truth.

Synchronize Excel automatically.

Create these sheets:

## Applications

Columns:

```text
Application ID
Date Found
Date Applied
Company
Job Title
Location
Remote
Job URL
Application URL
Source
JD Verified
Match Score
ATS Score
Required Skills
Missing Skills
CV Path
Cover Letter Path
Application Status
Submission Status
Confirmation ID
Last Updated
Next Action
Notes
```

## Jobs

Track every discovered job, including skipped jobs.

Columns:

```text
Job ID
Company
Title
Location
URL
Source
Posted Date
JD Verified
Match Score
Decision
Reason
Date Discovered
```

## Interviews

Columns:

```text
Application ID
Company
Role
Interview Type
Scheduled Date
Stage
Status
Notes
Next Action
```

## Statistics

Automatically calculate:

```text
jobs discovered
jobs evaluated
jobs skipped
applications
submitted
pending
paused
interviews
assessments
offers
rejections
average match score
average ATS score
application rate
interview rate
offer rate
```

## Agent Questions

Columns:

```text
Application ID
Company
Role
Question
Answer
Answer Source
Date Asked
Date Answered
Reused Later
```

---

# 25. EXCEL SYNCHRONIZATION

Whenever an event occurs, update the Excel row.

Example:

```text
JOB DISCOVERED
→ create row

JD VERIFIED
→ JD Verified = Yes

CV CREATED
→ CV Path populated
→ ATS Score populated

APPLICATION SUBMITTED
→ Application Status = SUBMITTED
→ Date Applied populated

CONFIRMATION RECEIVED
→ Confirmation ID populated

INTERVIEW EMAIL
→ Application Status = INTERVIEW
→ Interviews sheet updated
```

Do not create duplicate rows.

Use Application ID / Job ID as stable identifiers.

---

# 26. EXCEL FORMATTING

Make the workbook readable.

Use conditional formatting for status:

```text
SUBMITTED → green
INTERVIEW → green
ASSESSMENT → blue
PAUSED_FOR_USER → yellow
IN_PROGRESS → yellow
REJECTED → red
ERROR → red
BLOCKED → orange
SKIPPED → gray
```

Status text must always be visible.

Freeze headers.

Enable filters.

Resize columns appropriately.

Add summary statistics.

---

# 27. QUESTION MEMORY

Store previous answers.

If the agent sees:

```text
Are you willing to relocate?
```

and later:

```text
Would you consider relocation?
```

it should recognize the semantic similarity.

However, answers involving:

* legal declarations
* authorization
* immigration
* compensation
* contractual restrictions

must be treated carefully and should not blindly reuse stale answers.

---

# 28. EMAIL MONITORING

Monitor relevant application emails.

Classify:

```text
APPLICATION_RECEIVED
REJECTION
INTERVIEW
ASSESSMENT
HR_INTERVIEW
TECHNICAL_INTERVIEW
OFFER
DOCUMENT_REQUEST
WITHDRAWAL
OTHER
```

Update the application database and Excel tracker.

Do not automatically send email replies unless explicitly configured.

---

# 29. DASHBOARD

Build a local dashboard.

Display:

```text
Jobs Found
Jobs Evaluated
Applications
Submitted
Paused
Interviews
Assessments
Offers
Rejections
Errors
```

Allow:

```text
resume application
answer question
view JD
view CV
view cover letter
retry failed application
view screenshots
view application history
```

---

# 30. SCHEDULER

Support daily execution.

Default schedule:

```text
09:00 AM
```

Daily process:

```text
discover
↓
dedupe
↓
verify JD
↓
analyze
↓
match
↓
generate CV
↓
generate cover letter
↓
queue application
```

Use worker queues.

Do not start unlimited browser sessions.

---

# 31. CONCURRENCY

Use queues and configurable concurrency.

Example:

```yaml
workers:
  discovery: 5
  jd_analysis: 5
  resume_generation: 3
  browser_applications: 2
  email_monitor: 2
```

Browser sessions should have much lower concurrency than cheap analysis tasks.

Never allow two agents to control the same browser page simultaneously.

---

# 32. PARALLEL PIPELINE EXAMPLE

For 50 discovered jobs:

```text
                50 JOBS
                   │
             Deduplication
                   │
             35 unique jobs
                   │
          ┌────────┴────────┐
          ↓                 ↓
   JD extraction pool   Metadata pool
          │                 │
          └────────┬────────┘
                   ↓
              JD validation
                   ↓
          ┌────────┴─────────┐
          ↓                  ↓
     JD analysis        Candidate match
          │                  │
          └────────┬─────────┘
                   ↓
              Apply filter
                   ↓
               12 jobs
                   │
        ┌──────────┼──────────┐
        ↓          ↓          ↓
     Resume     Cover      ATS analysis
     agents     agents       agents
        │          │          │
        └──────────┼──────────┘
                   ↓
             Application queue
                   ↓
          Browser worker pool
                   ↓
              Submission
```

Use `Promise.all`, worker queues, BullMQ, or an equivalent architecture where appropriate.

Do not create unnecessary LLM calls.

---

# 33. RECOVERY AGENT

Create a dedicated recovery mechanism.

If:

```text
browser crashes
network fails
page changes
ATS changes
application times out
LLM returns invalid JSON
file disappears
```

the recovery system should:

```text
detect
↓
record
↓
retry if safe
↓
restore state
↓
continue
```

Never blindly restart an application.

---

# 34. OBSERVABILITY

Use structured logs.

Store:

```text
timestamp
application_id
job_id
agent
stage
event
result
error
duration
```

Create:

```text
logs/
├── agent.log
├── discovery.log
├── jd.log
├── resume.log
├── browser.log
├── application.log
└── error.log
```

---

# 35. SCREENSHOTS

Capture screenshots at:

```text
job page
application start
form error
human intervention
before submission
after submission
confirmation
```

Store them per application.

---

# 36. SECURITY

Never commit:

```text
API keys
passwords
cookies
session tokens
OAuth secrets
```

Use:

```text
.env
OS keychain where appropriate
secure local configuration
```

Sanitize logs.

---

# 37. TESTING

Create unit, integration, and end-to-end tests.

Test:

```text
JD extraction
JD validation
job deduplication
candidate matching
resume generation
ATS scoring
question classification
answer resolution
form detection
browser recovery
file upload
submission verification
state transitions
Excel synchronization
database synchronization
```

Create a local fake ATS:

```text
tests/fake-ats/
├── simple-form
├── dropdown-form
├── multi-page-form
├── dynamic-form
├── unknown-question
├── login-required
├── captcha-simulation
└── submission-success
```

Do not test automatic submission against random real employers during development.

---

# 38. TECHNOLOGY

Prefer:

```text
TypeScript
Node.js
Playwright
PostgreSQL
Redis
BullMQ
Fastify
React / Next.js
Docker
```

Use a provider abstraction for LLMs.

Example:

```text
LLMProvider
├── OpenAI
├── Anthropic
└── Compatible providers
```

Use structured output.

---

# 39. PROJECT STRUCTURE

Suggested structure:

```text
job-agent/
├── apps/
│   ├── orchestrator/
│   ├── worker/
│   ├── browser-agent/
│   └── dashboard/
│
├── packages/
│   ├── job-discovery/
│   ├── jd-analyzer/
│   ├── candidate-matcher/
│   ├── resume-generator/
│   ├── ats-validator/
│   ├── cover-letter-generator/
│   ├── form-agent/
│   ├── question-engine/
│   ├── browser-control/
│   ├── application-engine/
│   ├── excel-sync/
│   ├── email-monitor/
│   ├── database/
│   ├── agent-runtime/
│   └── shared/
│
├── profile/
├── applications/
├── tests/
├── migrations/
├── scripts/
├── logs/
├── docker/
├── .env.example
├── docker-compose.yml
└── README.md
```

Adapt this to the existing repository instead of rebuilding working components.

---

# 40. ARTIFACT STORAGE

Each application gets an isolated workspace:

```text
applications/
└── APP-2026-000001/
    ├── jd.md
    ├── jd-analysis.json
    ├── match-analysis.json
    ├── resume.pdf
    ├── resume.docx
    ├── ats-score.json
    ├── cover-letter.pdf
    ├── application.json
    ├── screenshots/
    └── browser-state/
```

The final CV must ALSO exist in:

```text
~/Desktop/cv/
```

The exact Desktop path must be recorded in the database.

---

# 41. DAILY LIMITS

Support:

```yaml
limits:
  max_jobs_discovered: 200
  max_applications_per_day: 25
  max_browser_concurrency: 2
  max_resume_revisions: 3
```

Make these configurable.

---

# 42. HUMAN ESCALATION

Only interrupt me when necessary.

Good reasons:

```text
unknown consequential question
CAPTCHA
MFA
login
ambiguous legal question
ambiguous work authorization
application error
unexpected website behavior
submission uncertainty
```

Do NOT interrupt me for:

```text
normal dropdowns
first name
last name
email
phone
address
known skills
known experience
known education
routine yes/no questions already configured
file uploads
normal navigation
```

The goal is:

```text
maximum automation
minimum interruptions
```

---

# 43. FINAL APPLICATION AUDIT

Before every submission:

```text
[ ] JD verified
[ ] correct company
[ ] correct role
[ ] correct application URL
[ ] candidate match calculated
[ ] job-specific CV generated
[ ] ATS validation completed
[ ] CV exists
[ ] exact CV path registered
[ ] cover letter generated if required
[ ] required questions answered
[ ] no unresolved consequential questions
[ ] no validation errors
[ ] correct files attached
[ ] application not previously submitted
[ ] submission policy allows submission
```

Only then submit.

---

# 44. DEVELOPMENT PHASES

Build in phases but do not stop after writing the plan.

### Phase 1

* inspect repository
* architecture
* profile
* database
* discovery
* JD extraction
* JD validation

### Phase 2

* JD analysis
* candidate matching
* resume generation
* ATS validation
* cover letter
* Desktop CV storage

### Phase 3

* Playwright
* ATS detection
* form understanding
* form filling
* file upload

### Phase 4

* human escalation
* pause/resume
* question memory
* browser persistence

### Phase 5

* submission
* confirmation verification
* application state machine

### Phase 6

* PostgreSQL
* Excel synchronization
* dashboard
* email monitoring

### Phase 7

* parallel worker architecture
* recovery
* observability
* tests
* security
* performance
* documentation

---

# 45. DO NOT STOP AT PLANNING

When starting:

1. Inspect the current repository.
2. Inspect existing files.
3. Inspect existing job automation code.
4. Reuse working components.
5. Identify missing components.
6. Create a concise implementation checklist.
7. Start coding immediately.
8. Run tests.
9. Fix errors.
10. Continue until the system is runnable.

Do not spend the entire task producing architecture prose.

Build the software.

---

# 46. WHEN YOU NEED ME

Ask only one focused question at a time.

Do not ask me for information that can be discovered from:

* repository files
* environment variables
* existing configuration
* browser state
* application page
* JD
* database

When human input is genuinely necessary:

```text
PAUSED

Company:
Role:

Question:

Why I cannot safely determine this:

Your answer:
```

After receiving my answer:

```text
save
→ validate
→ resume
```

---

# 47. SUCCESS CONDITION

The system is complete only when I can run:

```bash
npm run agent
```

and it can autonomously:

```text
find jobs
↓
read complete JDs
↓
verify them
↓
analyze them
↓
match them against my profile
↓
select suitable jobs
↓
generate unique CVs
↓
save CVs to ~/Desktop/cv/
↓
generate cover letters
↓
open real application websites
↓
understand forms
↓
fill forms
↓
ask me only when genuinely stuck
↓
resume
↓
upload exact job-specific documents
↓
submit
↓
verify submission
↓
update PostgreSQL
↓
update Excel
↓
monitor emails
↓
update status
```

The Excel file must always be available at:

```text
~/Desktop/job-applications.xlsx
```

The generated CV folder must always be:

```text
~/Desktop/cv/
```

---

# 48. FINAL DESIGN PRINCIPLE

The system should behave like a highly capable autonomous job-search employee.

It should be:

```text
AUTONOMOUS
STATEFUL
PARALLEL
RESUMABLE
TRUTHFUL
AUDITABLE
OBSERVABLE
FAULT-TOLERANT
HUMAN-AWARE
```

The key rule is:

```text
AUTOMATE EVERYTHING THAT IS SAFE TO AUTOMATE.

ASK THE USER ONLY WHEN THE SYSTEM CANNOT RELIABLY DETERMINE THE ANSWER.

NEVER INVENT CANDIDATE INFORMATION.

NEVER APPLY WITHOUT READING AND VERIFYING THE ACTUAL JD.

EVERY APPLICATION GETS ITS OWN JD-SPECIFIC CV.

EVERY APPLICATION IS TRACKED IN THE DATABASE AND EXCEL.

EVERY BROWSER ACTION MUST BE RECOVERABLE.
```

Now inspect the existing project and start implementing.
</pasted_content id="daed">
