import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {FakeATSServer} from './fake-ats.ts';
import path from 'path';

const testDir = path.dirname(new URL(import.meta.url, import.meta.url).pathname);
const projectRoot = path.resolve(testDir, '../../');
const srcPath = path.join(projectRoot, 'src');

describe('Browser Lifecycle Focused Test', () => {
  let server: FakeATSServer;
  let browserController: any;

  beforeAll(async () => {
    // Start Fake ATS
    server = new FakeATSServer(32501);
    await server.start();
    console.log('[TEST] Fake ATS server started');

    // Initialize BrowserController with custom profile to avoid conflicts
    const {BrowserController} = await import(path.join(srcPath, 'browser/controller.ts'));
    browserController = new BrowserController({ profilePath: '/Users/kumarmangalam/.job-agent/browser-profile-test' });
    await browserController.initialize();
    console.log('[TEST] BrowserController initialized');
  });

  afterAll(async () => {
    if (browserController) {
      console.log('[TEST] Closing BrowserController');
      await browserController.close();
      console.log('[TEST] BrowserController closed');
    }
    if (server) {
      console.log('[TEST] Stopping Fake ATS server');
      await server.stop();
      console.log('[TEST] Fake ATS server stopped');
    }
  });

  it('should navigate to Fake ATS and inspect page', async () => {
    const url = 'http://localhost:32501/apply?jobId=ATS-JOB-001';
    console.log('[TEST] Creating session first (production flow)');
    await browserController.createSession('APP-TEST-001', 'JOB-fake-ats', url);
    console.log('[TEST] Session created');

    console.log('[TEST] Navigating to:', url);
    const result = await browserController.navigate(url);
    console.log('[TEST] Navigation result:', JSON.stringify({
      success: result.success,
      error: result.error,
      url: result.url,
      title: result.title
    }));

    expect(result.success).toBe(true);

    // Inspect page
    const page = browserController.getPage();
    console.log('[TEST] page.url():', page?.url());
    console.log('[TEST] page.title():', await page?.title());

    // Check a known Fake ATS selector
    const inputSelector = await page?.$('input[name="jobId"]');
    console.log('[TEST] Found jobId input:', !!inputSelector);

    // Keep page alive briefly
    await new Promise(r => setTimeout(r, 1000));
    console.log('[TEST] Page kept alive for 1s');
  }, 30000);
});