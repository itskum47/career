/**
 * Phase 7 — chat control surface (CLI).
 *
 * The agent drives this from chat so the user never has to run a command
 * sequence themselves:
 *
 *   npm run chat -- "status"
 *   npm run chat -- "waiting"
 *   npm run chat -- "explain APP-20261008-000099"
 *   npm run chat -- "retry APP-20261008-000099"
 */
import * as path from 'path';
import { createDatabaseClient } from '../src/database/client.ts';
import { SubmissionJournalRepository } from '../src/database/repositories.ts';
import { FileSubmissionJournal } from '../src/application/submission-journal.ts';
import { ChatAgent } from '../src/control/chat-agent.ts';
import { RateLimiter } from '../src/core/rate-limiter.ts';

async function main() {
  const instruction = process.argv.slice(2).join(' ').trim();
  if (!instruction) {
    console.error('Usage: npm run chat -- "<instruction>"');
    process.exitCode = 1;
    return;
  }

  process.env.DB_PATH ||= `${process.cwd()}/data/job-agent.db`;
  const db = await createDatabaseClient();
  await db.runMigrations(path.join(process.cwd(), 'migrations'));

  const agent = new ChatAgent({
    db,
    journalRepo: new SubmissionJournalRepository(db),
    fileJournal: new FileSubmissionJournal(),
    rateLimiter: new RateLimiter(),
  });

  const result = await agent.handle(instruction);
  console.log(result.message);
  if (!result.ok) process.exitCode = 2;
  await db.close();
}

main().catch(err => { console.error(err); process.exit(1); });