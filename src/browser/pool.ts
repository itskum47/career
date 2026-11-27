/**
 * Browser Pool for reusing browser instances with isolated contexts
 * Implements MAX_BROWSER_CONCURRENCY and proper context isolation
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { logger } from '../core/logger.ts';
import { config } from '../core/config.ts';
import * as path from 'path';
import * as fs from 'fs';

export interface PooledContext {
  id: string;
  context: BrowserContext;
  page: Page;
  browserId: string;
  inUse: boolean;
  lastUsed: number;
  applicationId?: string;
  healthy: boolean;
}

export interface BrowserInstance {
  id: string;
  browser: Browser;
  contexts: Map<string, PooledContext>;
  createdAt: number;
  healthy: boolean;
}

export class BrowserPool {
  private browsers: Map<string, BrowserInstance> = new Map();
  private waitingQueue: Array<(ctx: PooledContext) => void> = [];
  private maxBrowsers: number = config.limits?.maxBrowserConcurrency || config.application?.maxConcurrentApplications || 2;
  private contextsPerBrowser: number = 2; // Max contexts per browser
  private maxContexts: number = this.maxBrowsers * this.contextsPerBrowser;

  async initialize(): Promise<void> {
    logger.info('Initializing browser pool', { maxBrowsers: this.maxBrowsers, maxContexts: this.maxContexts });
  }

  private async createBrowser(): Promise<BrowserInstance> {
    const browserId = `browser_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const profileBase = path.join(config.browser.profilePath, browserId);
    
    if (!fs.existsSync(profileBase)) {
      fs.mkdirSync(profileBase, { recursive: true });
    }

    const context = await chromium.launchPersistentContext(profileBase, {
      headless: config.browser.headless,
      slowMo: config.browser.slowMo,
      viewport: config.browser.viewport,
      userAgent: config.browser.userAgent,
      locale: config.browser.locale,
      timezoneId: config.browser.timezoneId,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    });

    const browser = context.browser()!;
    if (!browser) {
      throw new Error('Failed to get browser from context');
    }

    const instance: BrowserInstance = {
      id: browserId,
      browser,
      contexts: new Map(),
      createdAt: Date.now(),
      healthy: true,
    };

    this.browsers.set(browserId, instance);
    logger.info('Created browser instance', { browserId });
    return instance;
  }

  async acquire(applicationId?: string): Promise<PooledContext> {
    // Try to find an available context
    for (const browser of this.browsers.values()) {
      if (!browser.healthy) continue;
      for (const ctx of browser.contexts.values()) {
        if (!ctx.inUse && ctx.healthy) {
          ctx.inUse = true;
          ctx.lastUsed = Date.now();
          ctx.applicationId = applicationId;
          logger.debug('Reusing browser context', { contextId: ctx.id, applicationId });
          return ctx;
        }
      }
    }

    // Need to create new context
    let browser = Array.from(this.browsers.values()).find(b => b.healthy && b.contexts.size < this.contextsPerBrowser);
    if (!browser) {
      if (this.browsers.size < this.maxBrowsers) {
        browser = await this.createBrowser();
      } else {
        // Wait for a context to become available
        return new Promise((resolve) => {
          this.waitingQueue.push((ctx) => {
            ctx.inUse = true;
            ctx.lastUsed = Date.now();
            ctx.applicationId = applicationId;
            resolve(ctx);
          });
        });
      }
    }

    // Create new context in this browser
    const contextId = `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const ctx = await browser.browser.newContext({
      viewport: config.browser.viewport,
      userAgent: config.browser.userAgent,
      locale: config.browser.locale,
      timezoneId: config.browser.timezoneId,
    });

    const page = await ctx.newPage();
    ctx.setDefaultTimeout(config.browser.defaultTimeout);
    ctx.setDefaultNavigationTimeout(config.browser.navigationTimeout);

    const pooledCtx: PooledContext = {
      id: contextId,
      context: ctx,
      page,
      browserId: browser.id,
      inUse: true,
      lastUsed: Date.now(),
      applicationId,
      healthy: true,
    };

    browser.contexts.set(contextId, pooledCtx);
    logger.info('Created new browser context', { contextId, browserId: browser.id, applicationId });
    return pooledCtx;
  }

  async release(contextId: string): Promise<void> {
    for (const browser of this.browsers.values()) {
      const ctx = browser.contexts.get(contextId);
      if (ctx) {
        ctx.inUse = false;
        ctx.applicationId = undefined;
        ctx.lastUsed = Date.now();
        logger.debug('Released browser context', { contextId });
        
        // Process waiting queue
        if (this.waitingQueue.length > 0) {
          const waiter = this.waitingQueue.shift();
          if (waiter && ctx.healthy) {
            ctx.inUse = true;
            waiter(ctx);
          }
        }
        return;
      }
    }
    logger.warn('Attempted to release unknown context', { contextId });
  }

  async healthCheck(): Promise<void> {
    for (const browser of this.browsers.values()) {
      try {
        // Simple health check - create a blank page and close it
        const testPage = await browser.browser.newPage();
        await testPage.close();
        browser.healthy = true;
        for (const ctx of browser.contexts.values()) {
          ctx.healthy = true;
        }
      } catch (e) {
        logger.error('Browser health check failed', { browserId: browser.id, error: String(e) });
        browser.healthy = false;
        for (const ctx of browser.contexts.values()) {
          ctx.healthy = false;
        }
        await this.recover(browser.id);
      }
    }
  }

  async recover(browserId: string): Promise<void> {
    const browser = this.browsers.get(browserId);
    if (!browser) return;
    
    logger.info('Recovering browser', { browserId });
    try {
      // Close all contexts
      for (const ctx of browser.contexts.values()) {
        try { await ctx.context.close(); } catch {}
      }
      await browser.browser.close();
    } catch (e) {
      logger.warn('Error closing broken browser', { error: String(e) });
    }
    this.browsers.delete(browserId);
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down browser pool');
    for (const browser of this.browsers.values()) {
      try {
        for (const ctx of browser.contexts.values()) {
          try { await ctx.context.close(); } catch {}
        }
        await browser.browser.close();
      } catch (e) {
        logger.warn('Error closing browser on shutdown', { error: String(e) });
      }
    }
    this.browsers.clear();
    this.waitingQueue.length = 0;
  }

  getStats(): {
    browsers: number;
    totalContexts: number;
    inUseContexts: number;
    availableContexts: number;
  } {
    let totalContexts = 0;
    let inUseContexts = 0;
    for (const b of this.browsers.values()) {
      totalContexts += b.contexts.size;
      inUseContexts += Array.from(b.contexts.values()).filter(c => c.inUse).length;
    }
    return {
      browsers: this.browsers.size,
      totalContexts,
      inUseContexts,
      availableContexts: totalContexts - inUseContexts,
    };
  }
}

export const browserPool = new BrowserPool();
export default browserPool;