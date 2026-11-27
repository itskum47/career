/**
 * Base discovery adapter classes and utilities.
 */

import type { DiscoveredJob, JobSource, DiscoveryCriteria, VerificationResult, DiscoveryAdapter } from './types.ts';
import { generateJobId } from '../core/ids.ts';
import { logger } from '../core/logger.ts';
import { chromium, type Browser, type Page } from 'playwright';

export abstract class BaseDiscoveryAdapter implements DiscoveryAdapter {
  abstract readonly source: JobSource;
  abstract readonly name: string;

  abstract discover(criteria: DiscoveryCriteria): Promise<DiscoveredJob[]>;

  async verifyJob(job: DiscoveredJob): Promise<VerificationResult> {
    // Default verification - check if description has meaningful content
    const hasDescription = !!job.description && job.description.length > 100;
    const hasTitle = !!job.title && job.title.length > 3;
    const hasCompany = !!job.company && job.company.length > 2;
    const hasUrl = !!job.url && job.url.startsWith('http');

    const verified = hasDescription && hasTitle && hasCompany && hasUrl;
    const confidence = (hasDescription ? 0.4 : 0) + (hasTitle ? 0.2 : 0) + (hasCompany ? 0.2 : 0) + (hasUrl ? 0.2 : 0);

    return {
      verified,
      confidence,
      details: verified ? 'Basic verification passed' : 'Missing required fields',
      fullDescription: job.description,
    };
  }

  protected createJobId(company: string, title: string) {
    return generateJobId(this.source, company, title);
  }

  protected logDiscovery(count: number, criteria: DiscoveryCriteria): void {
    logger.info('Discovery completed', {
      source: this.source,
      adapter: this.name,
      jobsFound: count,
      criteria,
    });
  }
}

export class MockDiscoveryAdapter extends BaseDiscoveryAdapter {
  readonly source: JobSource = 'mock';
  readonly name = 'Mock Discovery';
  private customJobs?: DiscoveredJob[];

  /**
   * @param customJobs Optional explicit job fixtures (e.g. Fake ATS benchmark jobs).
   *                   When provided, the built-in mock jobs are replaced.
   */
  constructor(customJobs?: DiscoveredJob[]) {
    super();
    this.customJobs = customJobs;
  }

  async discover(criteria: DiscoveryCriteria): Promise<DiscoveredJob[]> {
    const jobs: DiscoveredJob[] = [];

    try {
      logger.info('Mock discovery - returning mock data for testing');

      // Return mock jobs
      jobs.push(...await this.yieldMockJobsArray(criteria));
      return jobs;
    } catch (error) {
      logger.error('Mock discovery failed', {
        source: this.source,
        error: error instanceof Error ? error.message : String(error)
      });

      jobs.push(...await this.yieldMockJobsArray(criteria));
      return jobs;
    }
  }

  private async yieldMockJobsArray(criteria: DiscoveryCriteria): Promise<DiscoveredJob[]> {
    const mockJobs: DiscoveredJob[] = this.customJobs && this.customJobs.length > 0 ? this.customJobs : [
      {
        jobId: 'JOB-mock-1' as any,
        company: 'Mock Company A',
        title: 'DevOps Engineer',
        location: 'Remote',
        remote: true,
        url: 'https://example.com/jobs/mock-1',
        source: 'mock',
        postedAt: new Date(),
        description: 'Mock DevOps job description for testing purposes.',
        salary: '$100,000 - $150,000',
        employmentType: 'full-time',
        seniority: 'senior',
      },
      {
        jobId: 'JOB-mock-2' as any,
        company: 'Mock Company B',
        title: 'Platform Engineer',
        location: 'San Francisco, CA',
        remote: true,
        url: 'https://example.com/jobs/mock-2',
        source: 'mock',
        postedAt: new Date(),
        description: 'Mock Platform Engineer job description for testing purposes.',
        salary: '$120,000 - $180,000',
        employmentType: 'full-time',
        seniority: 'mid',
      },
      {
        jobId: 'JOB-fake-ats' as any,
        company: 'TestCorp',
        title: 'DevOps Engineer',
        location: 'Remote',
        remote: true,
        url: 'http://localhost:32500/apply?jobId=ATS-JOB-001',
        source: 'mock',
        postedAt: new Date(),
        description: 'DevOps Engineer with AWS and Kubernetes experience.',
        salary: '$100,000 - $150,000',
        employmentType: 'full-time',
        seniority: 'mid',
      },
    ];

    // Apply criteria filtering
    let filtered = mockJobs;

    if (criteria.keywords && criteria.keywords.length > 0) {
      filtered = filtered.filter(job =>
        criteria.keywords!.some(kw =>
          job.title.toLowerCase().includes(kw.toLowerCase()) ||
          job.description.toLowerCase().includes(kw.toLowerCase())
        )
      );
    }

    if (criteria.remote !== undefined) {
      filtered = filtered.filter(job => job.remote === criteria.remote);
    }

    if (criteria.locations && criteria.locations.length > 0) {
      filtered = filtered.filter(job =>
        criteria.locations!.some(loc => job.location.toLowerCase().includes(loc.toLowerCase()))
      );
    }

    if (criteria.maxResults) {
      filtered = filtered.slice(0, criteria.maxResults);
    }

    return filtered;
  }
}

export class LinkedInDiscoveryAdapter extends BaseDiscoveryAdapter {
  readonly source: JobSource = 'linkedin';
  readonly name = 'LinkedIn Discovery';

  private browser?: Browser;
  private page?: Page;

  async discover(criteria: DiscoveryCriteria): Promise<DiscoveredJob[]> {
    const jobs: DiscoveredJob[] = [];

    try {
      // Initialize browser for LinkedIn
      const browser = await chromium.launch({ headless: true });
      this.browser = browser;
      this.page = await browser.newPage();

      // Set user agent to appear like a regular browser
      await this.page.setExtraHTTPHeaders({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      });

      // Navigate to LinkedIn jobs search
      const searchUrl = this.buildLinkedInSearchUrl(criteria);
      await this.page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });

      // Wait for job listings to load
      await this.page.waitForSelector('[data-test-id="job-search-card"]', { timeout: 10000 }).catch(() => {
        // If specific selector not found, try alternative selectors
        logger.warn('LinkedIn job selector not found, trying alternatives');
      });

      // Extract job listings
      jobs.push(...await this.extractLinkedInJobs(criteria));

      // 6L: zero jobs + a challenge/login marker is a WALL, not a successful
      // empty search. Surface it so source health records a challenge failure
      // (never bypassed, never auto-retried).
      if (jobs.length === 0 && this.page) {
        const html = await this.page.content().catch(() => '');
        const url = this.page.url();
        const wall = /captcha|security verification|verify you are (a )?human|unusual traffic|checkpoint/i.test(html)
          || /authwall|checkpoint|captcha|challenge/i.test(url);
        if (wall) throw new Error(`linkedin challenge/login wall during discovery — never bypassed (${url})`);
      }

    } catch (error) {
      // Propagate: the orchestrator classifies the failure into per-source
      // health (6M/6N) and counts it as a failed search — an empty []
      // would masquerade as success otherwise.
      logger.error('LinkedIn discovery failed', {
        source: this.source,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      await this.browser?.close();
      this.browser = undefined;
      this.page = undefined;
    }

    this.logDiscovery(jobs.length, criteria);
    return jobs;
  }

  private buildLinkedInSearchUrl(criteria: DiscoveryCriteria): string {
    let baseUrl = 'https://www.linkedin.com/jobs/search';
    const params = new URLSearchParams();

    if (criteria.keywords) {
      params.append('keywords', criteria.keywords.join(', '));
    }

    if (criteria.locations && criteria.locations.length > 0) {
      params.append('location', criteria.locations.join(', '));
    }

    if (criteria.remote === true) {
      params.append('f_WT', '2'); // remote filter
    }

    if (criteria.maxResults) {
      params.append('count', criteria.maxResults.toString());
    }

    return baseUrl + '?' + params.toString();
  }

  private async extractLinkedInJobs(criteria: DiscoveryCriteria): Promise<DiscoveredJob[]> {
    const jobs: DiscoveredJob[] = [];

    try {
      // Look for job cards using multiple selectors
      const selectors = [
        '[data-test-id="job-search-card"]',
        '.job-search-card',
        'a.job-card',
        '[class*="job-card"]'
      ];

      let jobElements: any[] = [];
      for (const selector of selectors) {
        jobElements = await this.page?.locator(selector).all() || [];
        if (jobElements.length > 0) {
          break; // Use the first selector that finds elements
        }
      }

      if (!this.page) return jobs;

      // REAL extraction: parse the loaded job cards.
      // LinkedIn's public search page renders job cards; we extract what is visible.
      const extracted = await this.parseLinkedInJobCards();
      jobs.push(...extracted);

      if (extracted.length === 0) {
        logger.warn('LinkedIn extraction returned 0 jobs - page structure may differ or blocked', {
          url: this.page.url(),
        });
      }
    } catch (error) {
      logger.error('Failed to extract LinkedIn jobs', { error: String(error) });
    }

    return jobs;
  }

  /**
   * Parse visible LinkedIn job cards from the loaded page.
   * Returns DiscoveredJob[] (may be empty if selectors don't match).
   * Does NOT fall back to mock data - that is handled by the caller.
   */
  private async parseLinkedInJobCards(): Promise<DiscoveredJob[]> {
    const jobs: DiscoveredJob[] = [];
    if (!this.page) return jobs;

    const selectors = [
      '[data-test-id="job-search-card"]',
      'li.jobs-search__result-item',
      'a[href*="/jobs/view/"]',
    ];

    let cards: any[] = [];
    for (const selector of selectors) {
      try {
        cards = await this.page.locator(selector).all();
      } catch {
        cards = [];
      }
      if (cards.length > 0) break;
    }

    for (const card of cards.slice(0, 50)) {
      try {
        const titleEl = await card.locator('h3, .job-title, [class*="title"]').first();
        const title = (await titleEl.textContent({ timeout: 2000 }))?.trim() || '';
        if (!title) continue;

        const companyEl = await card.locator('[class*="company"], h4').first();
        const company = (await companyEl.textContent({ timeout: 2000 }))?.trim() || '';

        const linkEl = await card.locator('a[href*="/jobs/view/"]').first();
        const href = await linkEl.getAttribute('href');
        const url = href ? new URL(href, 'https://www.linkedin.com').href : '';
        if (!url) continue;

        const locationEl = await card.locator('[class*="location"], span.job-search-results__list-item--location').first();
        const location = (await locationEl.textContent({ timeout: 2000 }))?.trim() || '';

        const descEl = await card.locator('[class*="description"], p').first();
        const description = (await descEl.textContent({ timeout: 2000 }))?.trim() || '';

        jobs.push({
          jobId: this.createJobId(company, title),
          company: company || 'Unknown',
          title,
          location: location || 'Not specified',
          remote: /remote/i.test(location) || /remote/i.test(title),
          url,
          source: this.source,
          postedAt: new Date(),
          description: description || title,
        });
      } catch {
        // Skip cards that fail to parse
      }
    }

    return jobs;
  }

  private async yieldMockJobsArray(criteria: DiscoveryCriteria): Promise<DiscoveredJob[]> {
    const mockJobs: DiscoveredJob[] = [
      {
        jobId: 'JOB-linkedin-1' as any,
        company: 'TechCorp Solutions',
        title: 'Senior DevOps Engineer',
        location: 'San Francisco, CA',
        remote: true,
        url: 'https://www.linkedin.com/jobs/view/senior-devops-engineer-techcorp',
        source: 'linkedin',
        postedAt: new Date(),
        description: `We are seeking a Senior DevOps Engineer to join our growing platform team at TechCorp Solutions. You will be responsible for building and maintaining our CI/CD pipelines, managing cloud infrastructure, and implementing automation solutions.

**Key Responsibilities:**
- Design and maintain CI/CD pipelines using Jenkins, GitHub Actions, and GitLab CI
- Manage AWS infrastructure using Terraform, CloudFormation, and CloudWatch
- Implement Kubernetes clusters and container orchestration
- Develop monitoring and logging solutions using Prometheus, Grafana, and ELK stack
- Automate infrastructure provisioning and configuration management
- Collaborate with development teams to ensure smooth deployment processes
- Implement security best practices and compliance measures

**Requirements:**
- 5+ years experience in DevOps or SRE roles
- Strong expertise in AWS, Kubernetes, Docker, and Terraform
- Proficient in scripting languages (Python, Go, Bash)
- Experience with monitoring tools (Prometheus, Grafana, Datadog)
- Knowledge of container orchestration and microservices
- AWS certifications (optional but preferred)
- Strong communication and teamwork skills

**Benefits:**
- Competitive salary and comprehensive benefits
- Flexible work environment
- Professional development opportunities
- Health, dental, and vision insurance
- 401(k) matching

Join us and be part of a dynamic team that's shaping the future of cloud infrastructure!`,
        salary: '$150,000 - $200,000',
        employmentType: 'full-time',
        seniority: 'senior',
      },
      {
        jobId: 'JOB-linkedin-2' as any,
        company: 'CloudBridge Technologies',
        title: 'Cloud Infrastructure Engineer',
        location: 'New York, NY',
        remote: true,
        url: 'https://www.linkedin.com/jobs/view/cloud-infrastructure-engineer-cloudbridge',
        source: 'linkedin',
        postedAt: new Date(),
        description: `CloudBridge Technologies is looking for a Cloud Infrastructure Engineer to help build our next-generation cloud platform. This role will focus on designing and implementing scalable infrastructure solutions using cloud technologies.

**Key Responsibilities:**
- Design and implement cloud infrastructure using AWS and Google Cloud
- Manage container orchestration with Kubernetes
- Develop automation scripts and tools for infrastructure management
- Monitor and optimize cloud costs and performance
- Collaborate with development teams on deployment strategies
- Implement security controls and compliance measures

**Requirements:**
- 3+ years experience with AWS, GCP, or Azure
- Strong knowledge of Kubernetes, Docker, and Helm
- Experience with Terraform, CloudFormation, or similar IaC tools
- Proficient in Python, Go, or similar scripting languages
- Experience with monitoring and logging tools
- Understanding of networking concepts and security best practices
- Excellent problem-solving and communication skills

**Nice to have:**
- Experience with data engineering tools (Airflow, Spark)
- Knowledge of microservices architecture
- Cloud certifications (AWS Solutions Architect, Google Cloud Professional)

**Company Benefits:**
- Flexible work arrangements
- Health and wellness programs
- Professional development budget
- Equity options
- Generous vacation policy

Apply now and help us build the future of cloud infrastructure!`,
        salary: '$120,000 - $170,000',
        employmentType: 'full-time',
        seniority: 'mid',
      },
    ];

    // Apply criteria filtering
    let filtered = mockJobs;

    if (criteria.keywords && criteria.keywords.length > 0) {
      filtered = filtered.filter(job =>
        criteria.keywords!.some(kw =>
          job.title.toLowerCase().includes(kw.toLowerCase()) ||
          job.description.toLowerCase().includes(kw.toLowerCase())
        )
      );
    }

    if (criteria.remote !== undefined) {
      filtered = filtered.filter(job => job.remote === criteria.remote);
    }

    if (criteria.locations && criteria.locations.length > 0) {
      filtered = filtered.filter(job =>
        criteria.locations!.some(loc => job.location.toLowerCase().includes(loc.toLowerCase()))
      );
    }

    if (criteria.maxResults) {
      filtered = filtered.slice(0, criteria.maxResults);
    }

    return filtered;
  }
}

export class IndeedDiscoveryAdapter extends BaseDiscoveryAdapter {
  readonly source: JobSource = 'indeed';
  readonly name = 'Indeed Discovery';

  private browser?: Browser;
  private page?: Page;

  async discover(criteria: DiscoveryCriteria): Promise<DiscoveredJob[]> {
    const jobs: DiscoveredJob[] = [];

    try {
      const browser = await chromium.launch({ headless: true });
      this.browser = browser;
      this.page = await browser.newPage();

      await this.page.setExtraHTTPHeaders({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      });

      const searchUrl = this.buildIndeedSearchUrl(criteria);
      await this.page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });

      // Wait for job listings
      await this.page.waitForSelector('[data-testid="card-list"]', { timeout: 10000 }).catch(() => {
        logger.warn('Indeed job selector not found, trying alternatives');
      });

      const extracted = await this.extractIndeedJobs();
      jobs.push(...extracted);

      if (extracted.length === 0) {
        logger.warn('Indeed extraction returned 0 jobs - selectors may differ or blocked', {
          url: this.page.url(),
        });
      }
    } catch (error) {
      logger.error('Indeed discovery failed', {
        source: this.source,
        error: error instanceof Error ? error.message : String(error)
      });
      return jobs;
    } finally {
      await this.browser?.close();
      this.browser = undefined;
      this.page = undefined;
    }

    this.logDiscovery(jobs.length, criteria);
    return jobs;
  }

  private buildIndeedSearchUrl(criteria: DiscoveryCriteria): string {
    let baseUrl = 'https://www.indeed.com/jobs';
    const params = new URLSearchParams();

    if (criteria.keywords) {
      params.append('q', criteria.keywords.join(' OR '));
    }

    if (criteria.locations && criteria.locations.length > 0) {
      params.append('l', criteria.locations.join(', '));
    }

    if (criteria.remote === true) {
      params.append('fromage', 'last'); // remote filter
    }

    if (criteria.maxResults) {
      params.append('limit', criteria.maxResults.toString());
    }

    return baseUrl + '?' + params.toString();
  }

  private async extractIndeedJobs(): Promise<DiscoveredJob[]> {
    const jobs: DiscoveredJob[] = [];
    if (!this.page) return jobs;

    const selectors = [
      '[data-testid="card-list"] > div',
      '.jobresult',
      '[data-tn-element="jobCard"]',
      '.result',
    ];

    let cards: any[] = [];
    for (const selector of selectors) {
      try {
        cards = await this.page.locator(selector).all();
      } catch {
        cards = [];
      }
      if (cards.length > 0) break;
    }

    for (const card of cards.slice(0, 50)) {
      try {
        const titleEl = await card.locator('h2 a, .jobTitle, [class*="title"]').first();
        const title = (await titleEl.textContent({ timeout: 2000 }))?.trim() || '';
        if (!title) continue;

        const companyEl = await card.locator('[class*="company"], span[data-company]').first();
        const company = (await companyEl.textContent({ timeout: 2000 }))?.trim() || '';

        const linkEl = await card.locator('a[href*="/page?"], a[href*="/viewjob"]').first();
        const href = await linkEl.getAttribute('href');
        const url = href ? new URL(href, 'https://www.indeed.com').href : '';
        if (!url) continue;

        const locationEl = await card.locator('[class*="location"], span[data-location]').first();
        const location = (await locationEl.textContent({ timeout: 2000 }))?.trim() || '';

        const descEl = await card.locator('[class*="summary"], .snippet').first();
        const description = (await descEl.textContent({ timeout: 2000 }))?.trim() || '';

        jobs.push({
          jobId: this.createJobId(company, title),
          company: company || 'Unknown',
          title,
          location: location || 'Not specified',
          remote: /remote/i.test(location) || /remote/i.test(title),
          url,
          source: this.source,
          postedAt: new Date(),
          description: description || title,
        });
      } catch {
        // Skip cards that fail to parse
      }
    }

    return jobs;
  }

  private async yieldMockJobsArray(criteria: DiscoveryCriteria): Promise<DiscoveredJob[]> {
    const mockJobs: DiscoveredJob[] = [
      {
        jobId: 'JOB-indeed-1' as any,
        company: 'DevOps Solutions LLC',
        title: 'DevOps Engineer',
        location: 'Remote',
        remote: true,
        url: 'https://www.indeed.com/viewjob?jk=1234567890&from=foundation',
        source: 'indeed',
        postedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
        description: `DevOps Solutions LLC is seeking a DevOps Engineer to join our dynamic team. We are looking for someone with strong experience in cloud infrastructure, containerization, and automation.

**About the Role:**
- Design and implement CI/CD pipelines using Jenkins, GitLab CI, and GitHub Actions
- Manage cloud infrastructure on AWS, GCP, or Azure
- Containerize applications using Docker and Kubernetes
- Implement monitoring and alerting solutions
- Write scripts and automation tools to improve operational efficiency
- Collaborate with development teams to ensure smooth deployments

**Requirements:**
- 3+ years of experience in DevOps or related role
- Strong knowledge of AWS, Azure, or GCP cloud platforms
- Experience with Kubernetes, Docker, and container orchestration
- Proficiency in scripting languages (Python, Bash, Go)
- Experience with configuration management tools (Ansible, Terraform, CloudFormation)
- Understanding of monitoring and logging tools (Prometheus, Grafana, ELK)
- Knowledge of security best practices and compliance

**Nice to have:**
- Experience with Docker containers and Kubernetes clusters
- Knowledge of microservices architecture
- Cloud certifications (AWS Certified Solutions Architect, etc.)
- Experience with GitOps tools (ArgoCD, Flux)

**What we offer:**
- Competitive salary and comprehensive benefits
- Flexible work arrangement
- Professional development opportunities
- Health, dental, and vision coverage
- 401(k) plan with company match
- Paid time off

Join our team and help us build the future of DevOps! This is a great opportunity for someone looking to grow their career in cloud infrastructure and automation.

**Application Requirements:**
- Resume required
- GitHub portfolio preferred
- 2+ years of relevant experience preferred

If you are passionate about DevOps and automation, we want to hear from you! Apply today and be part of our growth story.

Location: Remote positions available in all 50 states. Candidates must be eligible to work in the United States.

Apply Now - We are hiring!`,
        salary: '$110,000 - $160,000',
        employmentType: 'full-time',
        seniority: 'senior',
      },
      {
        jobId: 'JOB-indeed-2' as any,
        company: 'CloudNative Corp',
        title: 'SRE Engineer',
        location: 'New York, NY',
        remote: false,
        url: 'https://www.indeed.com/viewjob?jk=2345678901&from=foundation',
        source: 'indeed',
        postedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000), // 1 day ago
        description: `CloudNative Corp is looking for a Site Reliability Engineer (SRE) to help us maintain and improve our cloud infrastructure. This is a great opportunity for someone who wants to bridge the gap between development and operations.

**About Us:**
- We're a fast-growing tech company focused on cloud-native solutions
- Our team builds scalable, reliable infrastructure that powers millions of users
- We're committed to continuous improvement and implementing DevOps best practices

**Key Responsibilities:**
- Monitor and maintain production systems to ensure high availability
- Implement automation to reduce manual processes and improve reliability
- Analyze system performance and identify areas for improvement
- Develop tools and scripts to enhance operational efficiency
- Participate in on-call rotations to respond to production incidents
- Collaborate with developers to improve deployment processes

**Required Skills:**
- 2+ years of experience in SRE, DevOps, or related role
- Strong understanding of Linux system administration
- Experience with monitoring tools (Prometheus, Grafana, New Relic)
- Knowledge of container technologies (Docker, Kubernetes)
- Proficiency in programming languages (Python, Go, Bash)
- Experience with cloud platforms (AWS, GCP, Azure)
- Understanding of networking concepts and security
- Strong problem-solving and analytical skills

**Nice to have:**
- Experience with service mesh (Istio, Linkerd)
- Knowledge of databases (SQL, NoSQL)
- Experience with GitOps tools (ArgoCD, Flux)
- Cloud certifications

**What we offer:**
- Competitive salary: $100,000 - $140,000
- Health, dental, and vision insurance
- 401(k) plan with company match
- Professional development budget
- Flexible vacation policy
- Modern office location in NYC

**About the Position:**
This is a full-time, on-site position in our New York office. We offer a collaborative work environment where you can make a real impact on our infrastructure and systems.

If you are passionate about reliability, automation, and improving operational excellence, we want to hear from you! Apply today and join our team that's making a difference in the cloud-native space.

**Application Process:**
1. Submit your application with resume
2. Complete a technical assessment (optional)
3. Participate in interviews with our technical team
4. On-site interview (if located in NYC)

Join us and be part of a team that's building the future of cloud infrastructure!`,
        salary: '$100,000 - $140,000',
        employmentType: 'full-time',
        seniority: 'mid',
      },
    ];

    // Apply criteria filtering
    let filtered = mockJobs;

    if (criteria.keywords && criteria.keywords.length > 0) {
      filtered = filtered.filter(job =>
        criteria.keywords!.some(kw =>
          job.title.toLowerCase().includes(kw.toLowerCase()) ||
          job.description.toLowerCase().includes(kw.toLowerCase())
        )
      );
    }

    if (criteria.remote !== undefined) {
      filtered = filtered.filter(job => job.remote === criteria.remote);
    }

    if (criteria.locations && criteria.locations.length > 0) {
      filtered = filtered.filter(job =>
        criteria.locations!.some(loc => job.location.toLowerCase().includes(loc.toLowerCase()))
      );
    }

    if (criteria.maxResults) {
      filtered = filtered.slice(0, criteria.maxResults);
    }

    return filtered;
  }
}

export class GreenhouseDiscoveryAdapter extends BaseDiscoveryAdapter {
  readonly source: JobSource = 'greenhouse';
  readonly name = 'Greenhouse Discovery';

  async discover(criteria: DiscoveryCriteria): Promise<DiscoveredJob[]> {
    const jobs: DiscoveredJob[] = [];

    try {
      // Greenhouse exposes a public Board API per company:
      //   https://boards-api.greenhouse.io/v1/boards/{boardToken}/jobs
      // It requires a company board token. We iterate a configured list;
      // if no tokens are configured, we return 0 real jobs (no mock fallback).
      const tokens = this.getBoardTokens(criteria);
      for (const token of tokens) {
        const found = await this.fetchBoard(token, criteria);
        jobs.push(...found);
      }

      if (jobs.length === 0 && tokens.length === 0) {
        logger.warn('Greenhouse: no company board tokens configured', {
          hint: 'Set GREENHOUSE_BOARD_TOKENS (comma-separated) to enable real Greenhouse discovery',
        });
      }
    } catch (error) {
      logger.error('Greenhouse discovery failed', {
        source: this.source,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    this.logDiscovery(jobs.length, criteria);
    return jobs;
  }

  /**
   * Read configured Greenhouse board tokens from env.
   * e.g. GREENHOUSE_BOARD_TOKENS="acme,widgetco"
   */
  private getBoardTokens(_criteria: DiscoveryCriteria): string[] {
    const raw = process.env.GREENHOUSE_BOARD_TOKENS || '';
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  }

  /**
   * Fetch real jobs for a single Greenhouse board via the public Board API.
   * No authentication, no scraping - this is Greenhouse's official public endpoint.
   */
  private async fetchBoard(token: string, criteria: DiscoveryCriteria): Promise<DiscoveredJob[]> {
    const jobs: DiscoveredJob[] = [];
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`;

    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'job-agent/1.0' },
    });
    if (!res.ok) {
      logger.warn('Greenhouse board API error', { token, status: res.status });
      return jobs;
    }

    const data = await res.json() as any;
    const openings: any[] = Array.isArray(data) ? data : data.jobs || [];

    for (const opening of openings.slice(0, 50)) {
      const title = opening.title || '';
      const company = opening.location?.name || token;
      const location = opening.location?.name || 'Not specified';
      const jobUrl = opening.absolute_url || `https://boards.greenhouse.io/${token}/jobs/${opening.id}`;
      const description = opening.description ? this.stripHtml(opening.description) : title;

      if (criteria.keywords && criteria.keywords.length > 0) {
        const hay = (title + ' ' + description).toLowerCase();
        if (!criteria.keywords.some(k => hay.includes(k.toLowerCase()))) continue;
      }

      jobs.push({
        jobId: this.createJobId(company, title),
        company,
        title,
        location,
        remote: /remote/i.test(location) || /remote/i.test(title),
        url: jobUrl,
        source: this.source,
        postedAt: opening.updated_at ? new Date(opening.updated_at) : new Date(),
        description: description || title,
        salary: opening.salary ? `${opening.salary.min} - ${opening.salary.max}` : undefined,
        employmentType: opening.type || undefined,
      });
    }

    return jobs;
  }

  private stripHtml(html: string): string {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private async yieldMockJobsArray(criteria: DiscoveryCriteria): Promise<DiscoveredJob[]> {
    const mockJobs: DiscoveredJob[] = [
      {
        jobId: 'JOB-greenhouse-1' as any,
        company: 'Acme Technologies',
        title: 'DevOps Engineer',
        location: 'San Francisco, CA',
        remote: true,
        url: 'https://boards.greenhouse.com/acme-technologies/jobs/12345',
        source: 'greenhouse',
        postedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 days ago
        description: `Acme Technologies is looking for a DevOps Engineer to help us scale our platform and improve our infrastructure. We are a growing SaaS company with headquarters in San Francisco.

**About Acme Technologies:**
- Established tech company with 200+ employees
- Leading provider of cloud-based solutions
- Fast-paced, innovative work environment
- Strong emphasis on continuous improvement and automation

**Key Responsibilities:**
- Design and implement CI/CD pipelines using Jenkins, GitHub Actions, and GitLab CI
- Manage AWS infrastructure using Terraform, CloudFormation, and CloudWatch
- Containerize applications and deploy to Kubernetes clusters
- Monitor system performance and implement observability solutions
- Develop automation scripts to improve operational efficiency
- Collaborate with development teams on deployment strategies
- Participate in on-call rotations to respond to production incidents

**Required Skills:**
- 3+ years of experience in DevOps or related role
- Strong knowledge of AWS, Azure, or Google Cloud
- Experience with Kubernetes, Docker, and container orchestration
- Proficiency in Python, Go, Bash, or similar scripting languages
- Experience with configuration management (Ansible, Terraform, Puppet)
- Understanding of monitoring tools (Prometheus, Grafana, Datadog)
- Knowledge of security best practices and compliance
- Excellent communication and problem-solving skills

**Nice to have:**
- Experience with serverless computing (AWS Lambda, Google Cloud Functions)
- Knowledge of infrastructure as code best practices
- Experience with GitOps tools (ArgoCD, Flux)
- Cloud certifications (AWS Solutions Architect, Google Cloud Professional)
- Experience with microservices architecture
- Knowledge of databases (SQL, NoSQL) and caching strategies

**What we offer:**
- Competitive salary: $130,000 - $180,000
- Health, dental, and vision insurance
- 401(k) plan with company match
- Professional development budget
- Flexible vacation policy
- Paid parental leave
- Equity options

**Company Benefits:**
- Comprehensive health benefits
- 401(k) with company match
- Generous vacation and sick leave
- Professional development and training programs
- Flexible work arrangements
- Wellness programs and gym membership
- Multiple office locations

**About the Role:**
This is a full-time, exempt position reporting to the Director of Engineering. We offer a collaborative work environment where you can make a real impact on our infrastructure and operations.

If you are passionate about DevOps, automation, and continuous improvement, we want to hear from you! Apply today and join a team that's making a difference in the tech industry.

**Application Requirements:**
- Resume
- Portfolio of projects (GitHub, personal website)
- Cover letter (optional)
- 2-3 references

**About Our Team:**
Our DevOps team is growing rapidly and we need someone who can hit the ground running. You'll be working with a talented team of engineers who are passionate about automation, reliability, and continuous improvement.

We value diversity and inclusion and are an equal opportunity employer. All qualified applicants will receive consideration for employment regardless of race, color, religion, sex, sexual orientation, gender identity, national origin, disability, or veteran status.

**Next Steps:**
1. Submit your application with resume
2. Complete a technical assessment (optional)
3. Participate in interviews with our technical team
4. Final interview with senior leadership

Join Acme Technologies and be part of our growth story! We are looking for talented individuals who are excited about the future of technology and want to make a real impact.

**Apply Today!**

*We offer competitive compensation, comprehensive benefits, and a collaborative work environment where your ideas matter.*

Location: San Francisco office (hybrid remote work available)

*EOE/M/F/D/V*`,
        salary: '$130,000 - $180,000',
        employmentType: 'full-time',
        seniority: 'senior',
      },
      {
        jobId: 'JOB-greenhouse-2' as any,
        company: 'Nimbus Cloud',
        title: 'Platform Engineer',
        location: 'Seattle, WA',
        remote: false,
        url: 'https://boards.greenhouse.com/nimbus-cloud/jobs/67890',
        source: 'greenhouse',
        postedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5 days ago
        description: `Nimbus Cloud is seeking a Platform Engineer to join our platform team. We're looking for someone with strong DevOps skills and a passion for building scalable infrastructure.

**About Nimbus Cloud:**
- Cloud infrastructure company focused on enterprise solutions
- 150+ employees with offices in major tech hubs
- Strong focus on innovation and continuous improvement
- Competitive benefits and compensation

**Key Responsibilities:**
- Design and implement platform services and infrastructure
- Build CI/CD pipelines and automation solutions
- Manage cloud infrastructure and deployment strategies
- Collaborate with development teams on feature development
- Monitor and optimize system performance and reliability
- Implement security controls and compliance measures
- Develop operational tools and documentation

**Required Skills:**
- 2+ years of experience in platform engineering or DevOps
- Strong knowledge of AWS, Kubernetes, Docker, and Terraform
- Proficiency in Go, Python, or similar languages
- Experience with GitOps tools (ArgoCD, Flux, Jenkins X)
- Understanding of microservices architecture and patterns
- Knowledge of monitoring and logging solutions (Prometheus, Grafana)
- Experience with cloud security and compliance
- Excellent problem-solving and communication skills

**Nice to have:**
- Experience with service mesh (Istio, Linkerd, Consul Connect)
- Knowledge of databases and data pipelines (Spark, Flink)
- Experience with machine learning infrastructure
- Cloud certifications (AWS Certified Advanced Networking, etc.)
- Experience with container security scanning

**What we offer:**
- Competitive salary: $120,000 - $160,000
- Health, dental, and vision insurance
- 401(k) plan with company match
- Professional development budget
- Flexible vacation policy
- Paid time off for parental leave
- Health and wellness programs
- Company equity

**About the Role:**
This is a full-time, on-site position at our Seattle headquarters. We offer a collaborative work environment where you can make a real impact on our platform and infrastructure.

If you are passionate about platform engineering, cloud infrastructure, and automation, we want to hear from you! Apply today and join our team that's building the future of cloud platforms.

**Application Process:**
1. Submit your application with resume
2. Complete a technical assessment
3. Participate in technical interviews with our platform team
4. Final interview with senior leadership

**About Our Platform:**
Our platform engineers are the backbone of our operations. You'll work closely with development teams to ensure smooth deployment, scaling, and reliability of our cloud services. We're looking for someone who can think critically, solve complex problems, and collaborate effectively.

**We value:**
- Continuous learning and professional growth
- Innovation and creativity
- Collaboration and teamwork
- Quality and excellence
- Open communication and transparency

If you are excited about the challenges of building and maintaining a large-scale cloud platform, we want to meet you! Apply today and be part of our journey.

**Join Nimbus Cloud!**

*We're an equal opportunity employer and value diversity. All qualified applicants will receive consideration for employment regardless of race, color, religion, sex, sexual orientation, gender identity, national origin, disability, or veteran status.*

Location: Seattle, WA

*EOE/M/F/D/V*`,
        salary: '$120,000 - $160,000',
        employmentType: 'full-time',
        seniority: 'mid',
      },
    ];

    // Apply criteria filtering
    let filtered = mockJobs;

    if (criteria.keywords && criteria.keywords.length > 0) {
      filtered = filtered.filter(job =>
        criteria.keywords!.some(kw =>
          job.title.toLowerCase().includes(kw.toLowerCase()) ||
          job.description.toLowerCase().includes(kw.toLowerCase())
        )
      );
    }

    if (criteria.remote !== undefined) {
      filtered = filtered.filter(job => job.remote === criteria.remote);
    }

    if (criteria.locations && criteria.locations.length > 0) {
      filtered = filtered.filter(job =>
        criteria.locations!.some(loc => job.location.toLowerCase().includes(loc.toLowerCase()))
      );
    }

    if (criteria.maxResults) {
      filtered = filtered.slice(0, criteria.maxResults);
    }

    return filtered;
  }
}
