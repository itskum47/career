#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const home = os.homedir();

function run(cmd) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: root });
}

function ensureDir(p) {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
    console.log(`created ${p}`);
  }
}

try {
  // 1. Node version check
  const nodeMajor = parseInt(process.version.slice(1).split('.')[0], 10);
  if (nodeMajor !== 22) {
    console.warn(`Warning: Node ${process.version} detected; Node 22 is recommended (.nvmrc).`);
  }

  // 2. Install deps
  run('npm ci');

  // 3. Playwright browser
  try { run('npx playwright install chromium'); } catch (e) { console.warn('Playwright install failed; run manually: npx playwright install chromium'); }

  // 4. Env file
  const envPath = path.join(root, '.env');
  const examplePath = path.join(root, '.env.example');
  if (!fs.existsSync(envPath) && fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, envPath);
    console.log('created .env from .env.example');
  }

  // 5. Profile
  const profilePath = path.join(root, 'profile', 'master_profile.yaml');
  const profileExample = path.join(root, 'profile', 'master_profile.example.yaml');
  if (!fs.existsSync(profilePath) && fs.existsSync(profileExample)) {
    fs.copyFileSync(profileExample, profilePath);
    console.log('created profile/master_profile.yaml from template — FILL IT IN');
  }

  // 6. Output dirs
  const cvDir = path.join(home, 'Desktop', 'cv');
  ensureDir(cvDir);
  ensureDir(path.join(root, 'data'));
  ensureDir(path.join(root, 'logs'));

  // 7. Migrate
  run('npm run db:migrate');

  console.log('\n✅ Setup complete. Next:');
  console.log('   1. Edit .env (set ANTHROPIC_API_KEY or keep MOCK_LLM=1)');
  console.log('   2. Edit profile/master_profile.yaml with your details');
  console.log('   3. npm run agent -- discover');
} catch (err) {
  console.error('\n❌ Setup failed:', err.message);
  process.exit(1);
}