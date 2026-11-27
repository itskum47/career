/**
 * ATS-specific browser strategies for optimized handling
 */
import type { Page } from 'playwright';
import { logger } from '../core/logger.ts';
import { config } from '../core/config.ts';

export interface ATSHandler {
  name: string;
  detect(url: string): boolean;
  waitForReady(page: Page): Promise<void>;
  getFormSelectors(): string[];
  getFieldTimeout(): number;
}

class GreenhouseHandler implements ATSHandler {
  name = 'Greenhouse';
  detect(url: string): boolean {
    return url.includes('greenhouse.io') || url.includes('boards.greenhouse.io');
  }
  async waitForReady(page: Page): Promise<void> {
    try {
      await page.waitForSelector('[data-qa="application-form"], .application-form, #application_form', {
        timeout: config.browser.defaultTimeout
      });
    } catch (e) {
      await page.waitForSelector('input, select, textarea', { timeout: 3000 });
    }
  }
  getFormSelectors(): string[] {
    return ['[data-qa="application-form"]', '.application-form', '#application_form'];
  }
  getFieldTimeout(): number {
    return 1500;
  }
}

class LeverHandler implements ATSHandler {
  name = 'Lever';
  detect(url: string): boolean {
    return url.includes('lever.co') || url.includes('jobs.lever.co');
  }
  async waitForReady(page: Page): Promise<void> {
    try {
      await page.waitForSelector('.lever-application-form, .application-form', {
        timeout: config.browser.defaultTimeout
      });
    } catch (e) {
      await page.waitForSelector('input, select, textarea', { timeout: 3000 });
    }
  }
  getFormSelectors(): string[] {
    return ['.lever-application-form', '.application-form'];
  }
  getFieldTimeout(): number {
    return 1500;
  }
}

class AshbyHandler implements ATSHandler {
  name = 'Ashby';
  detect(url: string): boolean {
    return url.includes('ashbyhq.com') || url.includes('jobs.ashbyhq.com');
  }
  async waitForReady(page: Page): Promise<void> {
    try {
      await page.waitForSelector('[data-testid="application-form"], .ashby-application-form', {
        timeout: config.browser.defaultTimeout
      });
    } catch (e) {
      await page.waitForSelector('input, select, textarea', { timeout: 3000 });
    }
  }
  getFormSelectors(): string[] {
    return ['[data-testid="application-form"]', '.ashby-application-form'];
  }
  getFieldTimeout(): number {
    return 1500;
  }
}

class WorkdayHandler implements ATSHandler {
  name = 'Workday';
  detect(url: string): boolean {
    return url.includes('myworkdayjobs.com') || url.includes('workday.com');
  }
  async waitForReady(page: Page): Promise<void> {
    try {
      await page.waitForSelector('[data-automation-id="jobApplication"], .wd-application-form', {
        timeout: config.browser.defaultTimeout
      });
    } catch (e) {
      await page.waitForSelector('input, select, textarea', { timeout: 3000 });
    }
  }
  getFormSelectors(): string[] {
    return ['[data-automation-id="jobApplication"]', '.wd-application-form'];
  }
  getFieldTimeout(): number {
    return 2500; // Workday can be slower
  }
}

class GenericHandler implements ATSHandler {
  name = 'Generic';
  detect(url: string): boolean {
    return true;
  }
  async waitForReady(page: Page): Promise<void> {
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('input, select, textarea, button', { timeout: 5000 });
  }
  getFormSelectors(): string[] {
    return ['form', 'application-form', '#application_form'];
  }
  getFieldTimeout(): number {
    return 2000;
  }
}

export class ATSStrategyManager {
  private handlers: ATSHandler[] = [
    new GreenhouseHandler(),
    new LeverHandler(),
    new AshbyHandler(),
    new WorkdayHandler(),
    new GenericHandler(),
  ];

  detectHandler(url: string): ATSHandler {
    for (const h of this.handlers) {
      if (h.detect(url)) {
        return h;
      }
    }
    return new GenericHandler();
  }
}

export const atsStrategyManager = new ATSStrategyManager();
export default atsStrategyManager;