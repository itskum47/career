# Job Agent — Autonomous Job Application System

A multi-agent system that discovers jobs, reads/verifies JDs, tailors a CV + cover letter per job, drives a real browser to fill applications, tracks everything in SQLite + Excel, and escalates to you only when it genuinely needs input.

> **Status:** Personal tool made portable. Expect rough edges. Default mode is safe (`MOCK_LLM=1`, `AUTO_SUBMIT=false`).

## Prerequisites

- **Node.js 22** (use `nvm`: `nvm install 22 && nvm use 22`) — Node 26 breaks `better-sqlite3`.
- npm 10+
- macOS / Linux / Windows (paths use `~`).

## Quick Start (plug & play)

```bash
# 1. Clone
git clone <this-repo> job-agent && cd job-agent

# 2. Use the right Node
nvm use            # reads .nvmrc

# 3. Install
npm ci

# 4. Install browser
npx playwright install chromium

# 5. Configure
cp .env.example .env
# edit .env: set ANTHROPIC_API_KEY (or keep MOCK_LLM=1 for a free dry run)

# 6. Set up your profile
cp profile/master_profile.example.yaml profile/master_profile.yaml
# fill in your details

# 7. Migrate DB
npm run db:migrate

# 8. Run
npm run agent -- discover
```

Or run the one-shot setup:

```bash
npm run setup
```

## Scripts

| Script | What |
|---|---|
| `npm run setup` | Install + migrate + playwright + create output dirs |
| `npm run agent` | CLI (discover/extract/match/generate/apply/run/status/...) |
| `npm run agent:discover` | Discovery only |
| `npm run agent:apply` | Apply to a single job |
| `npm run agent:dashboard` | Dashboard dev server (experimental — not fully implemented) |
| `npm run test` | Unit + integration tests (uses MOCK_LLM) |
| `npm run build` | TypeScript typecheck |
| `npm run db:migrate` | Run migrations |
| `npm run chat` | Chat control interface |

## Configuration

All config is via `.env` (see `.env.example`). Key flags:

- `DB_DRIVER=sqlite` (default, zero-config) or `postgres` (+ `DATABASE_URL`).
- `USE_REDIS=false` (default). Set true only if you run Redis.
- `MOCK_LLM=1` (default in example) — deterministic, free, no API key. Set `0` for real LLM calls.
- `AUTO_SUBMIT=false` — keep false until you trust it. Submission is gated.
- `CV_OUTPUT_DIR=~/Desktop/cv`, `EXCEL_PATH=~/Desktop/job-applications.xlsx`.

## Optional: Obscura browser backend

By default the agent drives Chromium via Playwright. For a lighter, stealthier
engine (Rust, ~4 MB, anti-detect), install
[Obscura](https://github.com/itskum47/obscura) and flip the backend:

```bash
npm run browser:install-obscura
# then in .env:
BROWSER_BACKEND=obscura
OBSCURA_STEALTH=true   # optional
```

Playwright's automation API is unchanged — only the launched browser swaps.

**Limitation (as of obscura 0.2.7):** obscura's V8 runtime does not implement
`DataTransfer`, so `setInputFiles` (resume/cover-letter upload) fails. For job
applications that require file uploads, keep `BROWSER_BACKEND=playwright`. Obscura
remains useful for scraping, screenshots and non-upload automation.

## Safety

- Never commits secrets: `.env*` is gitignored.
- Never submits without `AUTO_SUBMIT=true` (or `--auto-submit`).
- Never fabricates candidate info — missing requirements are marked missing.
- CAPTCHA / MFA / login always pause for you.

## License

MIT. See `LICENSE`.