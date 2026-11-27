/**
 * Phase 6U — Combobox (react-select style) fill for human-escalation answers.
 *
 * Greenhouse's custom questions are react-select dropdowns: typing a value
 * never commits it — the option must be CLICKED. fillField detects
 * role=combobox / aria-haspopup=listbox and drives the full select
 * (measured on the live form 2026-10-07; committed value landed only via
 * option click).
 *
 * Fixture only (tests/fixtures/combobox.html) — never a live site.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';

const testDir = path.dirname(new URL(import.meta.url).pathname);
const projectRoot = path.resolve(testDir, '../../../');
const fixtureUrl = 'file://' + path.join(projectRoot, 'tests/fixtures/combobox.html');

describe('6Q — combobox fill via fillField', () => {
  let browserController: any;

  beforeAll(async () => {
    const { BrowserController } = await import(
      path.join(projectRoot, 'src/browser/controller.ts')
    );
    browserController = new BrowserController({
      profilePath: '/Users/kumarmangalam/.job-agent/browser-profile-test-combobox',
    });
    await browserController.initialize();
    await browserController.createSession('APP-TEST-COMBOBOX', 'JOB-fixture', fixtureUrl);
    await browserController.getPage().goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
  }, 60000);

  afterAll(async () => {
    if (browserController) await browserController.close();
  });

  const field = {
    uid: 'Q-fixture-country',
    label: 'What is your current country of residence?*',
    type: 'text' as const,
    id: 'q_country',
    required: true,
    confidence: 1,
    source: 'label' as const,
  };

  const committedValue = async (): Promise<string> =>
    browserController.getPage().$eval('#country_value', (el: any) => el.value);

  it('commits an exact option match (filter path)', async () => {
    await browserController.fillField(field, 'India');
    expect(await committedValue()).toBe('India');
  }, 30000);

  it('opens the full menu and commits a partial match when strict filtering finds nothing', async () => {
    // 'Ind' matches no option strictly → fallback clears + opens menu →
    // partial match clicks India.
    await browserController.fillField(field, 'Ind');
    expect(await committedValue()).toBe('India');
  }, 30000);

  it('fails honestly when no option matches (never commits garbage)', async () => {
    await expect(browserController.fillField(field, 'Atlantis')).rejects.toThrow(
      /No combobox option matches/,
    );
    expect(await committedValue()).toBe('India'); // previous selection untouched
  }, 30000);
});
