/**
 * Phase 6U/6W — attachment commit lifecycle (the fix for "Resume/CV is
 * required." with a visible chip).
 *
 * Measured defect (2026-10-08, APP-20261008-000099): file inputs were matched on
 * `name`, which Greenhouse does not set (`#resume` / `#cover_letter`, both
 * name-less), so resume AND cover letter both resolved to the first input — the
 * cover letter overwrote the resume input, the resume attachment state was lost,
 * and Greenhouse's own validator rejected the form client-side. The chip stayed
 * visible because it is local component state, and success was reported as soon
 * as `setInputFiles` returned.
 *
 * Fixture only (tests/fixtures/gh-attachments.html) — reproduces Greenhouse's
 * contract: id-only inputs, presigned-fields fetch, multipart upload, commit only
 * on 2xx, validator requiring a {name,url} attachment object. Submit is never
 * clicked here (window.__submitted must stay null).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';

const testDir = path.dirname(new URL(import.meta.url).pathname);
const projectRoot = path.resolve(testDir, '../../../');
const fixturePath = path.join(projectRoot, 'tests/fixtures/gh-attachments.html');
const fixtureUrl = 'file://' + fixturePath;

// Self-contained fixture PDFs (no dependency on generated ~/Desktop/cv artifacts).
const resumePath = path.join(projectRoot, 'tests/fixtures/attachments/resume.pdf');
const coverPath = path.join(projectRoot, 'tests/fixtures/attachments/cover-letter.pdf');

describe('6W — file input targeting (resume vs cover letter)', () => {
  it('resolves Greenhouse id-only inputs to DISTINCT inputs', async () => {
    const { BrowserController } = await import(path.join(projectRoot, 'src/browser/controller.ts'));
    // Exactly what the live form exposes: ids, no names.
    const targets = BrowserController.resolveFileInputTargets([
      { index: 0, id: 'resume', name: '', accept: '.pdf,.doc,.docx,.txt,.rtf' },
      { index: 1, id: 'cover_letter', name: '', accept: '.pdf,.doc,.docx,.txt,.rtf' },
    ]);
    expect(targets.resume?.index).toBe(0);
    expect(targets.coverLetter?.index).toBe(1);
    expect(targets.resume?.index).not.toBe(targets.coverLetter?.index);
  });

  it('never collapses both attachments onto one input when id/name are absent', async () => {
    const { BrowserController } = await import(path.join(projectRoot, 'src/browser/controller.ts'));
    const targets = BrowserController.resolveFileInputTargets([
      { index: 0, id: '', name: '', accept: '.pdf,.doc' },
      { index: 1, id: '', name: '', accept: '.pdf,.doc' },
    ]);
    expect(targets.resume?.index).toBe(0);
    expect(targets.coverLetter?.index).toBe(1);
  });

  it('prefers explicit identity over ordering (cover letter listed first)', async () => {
    const { BrowserController } = await import(path.join(projectRoot, 'src/browser/controller.ts'));
    const targets = BrowserController.resolveFileInputTargets([
      { index: 0, id: 'cover_letter', name: '', accept: '.pdf' },
      { index: 1, id: 'resume', name: '', accept: '.pdf' },
    ]);
    expect(targets.resume?.id).toBe('resume');
    expect(targets.coverLetter?.id).toBe('cover_letter');
  });
});

describe('6W — attachment commit through the site lifecycle (fixture)', () => {
  let browserController: any;
  let page: any;
  let uploadStatus = 200;
  const seen: Array<{ method: string; path: string; multipart: boolean; status: number }> = [];

  beforeAll(async () => {
    const { BrowserController } = await import(path.join(projectRoot, 'src/browser/controller.ts'));
    browserController = new BrowserController({
      profilePath: '/Users/kumarmangalam/.job-agent/browser-profile-test-attach',
    });
    await browserController.initialize();
    await browserController.createSession('APP-TEST-ATTACH', 'JOB-fixture-attach', fixtureUrl);

    page = browserController.getPage();
    // Presigned fields + multipart upload endpoints (never a real submission).
    await page.route((url: any) => url.pathname.includes('/uncacheable_attributes/presigned_fields'), async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({
          url: 'https://file-upload.fixture.local/upload',
          resume: { fields: { key: 'resume/{timestamp}/{unique_id}', 'Content-Type': 'application/octet-stream' }, key: 'resume/{timestamp}/{unique_id}' },
          cover_letter: { fields: { key: 'cover/{timestamp}/{unique_id}', 'Content-Type': 'application/octet-stream' }, key: 'cover/{timestamp}/{unique_id}' },
        }),
      });
    });
    await page.route((url: any) => url.pathname.startsWith('/upload/'), async (route: any) => {
      const req = route.request();
      const contentType = req.headers()['content-type'] || '';
      seen.push({
        method: req.method(),
        path: new URL(req.url()).pathname,
        multipart: contentType.includes('multipart/form-data'),
        status: uploadStatus,
      });
      await route.fulfill({
        status: uploadStatus,
        contentType: 'text/plain',
        headers: { 'access-control-allow-origin': '*' },
        body: uploadStatus >= 200 && uploadStatus < 300 ? 'ok' : 'rejected',
      });
    });

    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
  }, 60000);

  afterAll(async () => {
    if (browserController) await browserController.close();
  });

  beforeEach(async () => {
    seen.length = 0;
    uploadStatus = 200;
    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      (window as any).__state = { resume: null, cover_letter: null };
      (window as any).__submitted = null;
      (window as any).__requests = [];
    });
  });

  it('commits resume AND cover letter to distinct attachment objects without clicking Submit', async () => {
    const { meta, handles } = await browserController.scanFileInputs();
    expect(meta.map((m: any) => m.id)).toEqual(['resume', 'cover_letter']);

    const targets = browserController.constructor.resolveFileInputTargets(meta);
    const required = await browserController.detectRequiredAttachments();
    expect(required.resume).toBe(true);   // fixture renders "Resume/CV *"
    expect(required.coverLetter).toBe(false);

    // --- resume ---
    const resumeResult = await browserController.attachAttachment(
      handles[targets.resume.index], targets.resume, resumePath, 'resume',
    );
    expect(resumeResult.committed).toBe(true);
    expect(resumeResult.fileAttached).toBe(true);
    expect(resumeResult.uploadObserved).toBe(true);
    expect(resumeResult.uploadStatus).toBe(200);
    expect(resumeResult.uploadHost).toBe('file-upload.fixture.local');
    expect(resumeResult.chipPresent).toBe(true);
    expect(resumeResult.error).toBeUndefined();

    // The page's own state now holds a valid attachment object.
    const resumeState = await page.evaluate(() => (window as any).__state.resume);
    expect(resumeState.name).toBe(path.basename(resumePath));
    expect(resumeState.url).toBeTruthy();

    // --- cover letter (must NOT land in the resume input) ---
    const coverResult = await browserController.attachAttachment(
      handles[targets.coverLetter.index], targets.coverLetter, coverPath, 'cover_letter',
    );
    expect(coverResult.committed).toBe(true);
    expect(coverResult.uploadStatus).toBe(200);
    expect(coverResult.inputIndex).not.toBe(resumeResult.inputIndex);

    // Both attachments distinct; the resume attachment survived the cover upload.
    const state = await page.evaluate(() => (window as any).__state);
    expect(state.resume.name).toBe(path.basename(resumePath));
    expect(state.cover_letter.name).toBe(path.basename(coverPath));
    expect(state.resume.url).not.toBe(state.cover_letter.url);

    // Files remain on their own inputs (no cross-wiring).
    const inputFiles = await page.evaluate(() => ({
      resume: (document.getElementById('resume') as HTMLInputElement).files?.[0]?.name,
      cover: (document.getElementById('cover_letter') as HTMLInputElement).files?.[0]?.name,
    }));
    expect(inputFiles.resume).toBe(path.basename(resumePath));
    expect(inputFiles.cover).toBe(path.basename(coverPath));

    // Two uploads observed, both multipart POSTs to the presigned host.
    expect(seen.filter(r => r.method === 'POST').length).toBe(2);
    expect(seen.every(r => r.multipart)).toBe(true);

    // Greenhouse-equivalent validator passes WITHOUT submitting.
    const errors = await page.evaluate(() => (window as any).__validate());
    expect(errors).toEqual([]);

    // And Submit was never clicked by this suite.
    expect(await page.evaluate(() => (window as any).__submitted)).toBeNull();
  }, 90000);

  it('reports NOT committed when the upload is rejected (no false success)', async () => {
    uploadStatus = 403;
    const { meta, handles } = await browserController.scanFileInputs();
    const targets = browserController.constructor.resolveFileInputTargets(meta);

    const result = await browserController.attachAttachment(
      handles[targets.resume.index], targets.resume, resumePath, 'resume',
    );
    expect(result.committed).toBe(false);
    expect(result.uploadObserved).toBe(true);
    expect(result.uploadStatus).toBe(403);
    expect(result.chipPresent).toBe(false);
    expect(result.error).toContain('rejected');

    // The page's validator still reports the resume as missing — exactly the
    // real-world state that used to produce "Resume/CV is required.".
    const errors = await page.evaluate(() => (window as any).__validate());
    expect(errors).toContain('Resume/CV is required.');
    expect(await page.evaluate(() => (window as any).__submitted)).toBeNull();
  }, 60000);
});