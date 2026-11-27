import { createDatabaseClient, closeDatabaseClient } from '../src/database/client.ts';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const db = await createDatabaseClient();
  const migrationsPath = path.join(__dirname, '..', 'migrations');
  await db.runMigrations(migrationsPath);
  await closeDatabaseClient();
  console.log('Migrations applied.');
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});