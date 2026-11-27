/**
 * Fake ATS Server for end-to-end testing.
 * Simulates ATS behavior for application testing without external dependencies.
 */

import { createServer } from 'http';
import { parse } from 'url';
import { URLSearchParams } from 'url';

interface FakeATSExtraField {
  name: string;
  label: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
}

interface FakeATSJob {
  id: string;
  title: string;
  company: string;
  description: string;
  url: string;
  status: 'open' | 'closed';
  extraFields?: FakeATSExtraField[];
}

interface FakeATSApplication {
  id: string;
  jobId: string;
  applicantData: Record<string, string>;
  resumeFile?: string;
  coverLetterFile?: string;
  status: 'pending' | 'submitted' | 'reviewed' | 'rejected' | 'accepted';
  submittedAt: Date;
  confirmationId?: string;
}

class FakeATSServer {
  private jobs: Map<string, FakeATSJob> = new Map();
  private applications: Map<string, FakeATSApplication> = new Map();
  private server: ReturnType<typeof createServer>;
  private port: number;
  // Benchmark instrumentation: transient failures injected for controlled fault tests
  private transientFailures: Map<string, number> = new Map();
  private transientSkip: Map<string, number> = new Map();
  private transientSkipSeen: Map<string, number> = new Map();
  private requestLog: Array<{ method: string; path: string; status: number; at: number }> = [];

  constructor(port = 31415) {
    this.port = port;
    this.initializeJobs();
    this.server = createServer(this.handleRequest.bind(this));
  }

  private initializeJobs(): void {
    // Add some test jobs
    const testJobs: FakeATSJob[] = [
      {
        id: 'ATS-JOB-001',
        title: 'DevOps Engineer',
        company: 'TestCorp',
        description: 'We are looking for a DevOps Engineer with AWS and Kubernetes experience.',
        url: 'https://testcorp.com/careers/devops-engineer',
        status: 'open',
      },
      {
        id: 'ATS-JOB-002',
        title: 'Platform Engineer',
        company: 'CloudScale',
        description: 'Platform Engineer role requiring Terraform, Docker, and CI/CD expertise.',
        url: 'https://cloudscale.io/jobs/platform-engineer',
        status: 'open',
      },
      {
        id: 'ATS-JOB-003',
        title: 'Senior DevOps Engineer',
        company: 'DevTools Inc',
        description: 'Senior role with focus on infrastructure as code and monitoring.',
        url: 'https://devtools.com/jobs/senior-devops',
        status: 'open',
      },
    ];

    for (const job of testJobs) {
      this.jobs.set(job.id, job);
    }
  }

  private handleRequest(req: any, res: any): void {
    const { pathname, query } = parse(req.url || '', true);
    const path = pathname || '/';

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      this.routeRequest(req.method || 'GET', path, query, body, res);
    });
  }

  private routeRequest(method: string, path: string, query: any, body: string, res: any): void {
    // Parse body as JSON, form data, or multipart
    let payload: any = {};
    try {
      if (body) {
        payload = JSON.parse(body);
      }
    } catch {
      // Try multipart form data
      const contentType = '';
      if (body.includes('Content-Disposition: form-data')) {
        // Parse multipart/form-data
        const parts = body.split('--');
        for (const part of parts) {
          const nameMatch = part.match(/name="([^"]+)"/);
          const valueMatch = part.match(/\r\n\r\n([\s\S]*?)\r\n/);
          if (nameMatch && valueMatch) {
            const name = nameMatch[1];
            const value = valueMatch[1].trim();
            if (!name.includes('filename')) { // Skip file content
              payload[name] = value;
            }
          }
        }
      } else {
        // Try URLSearchParams
        const params = new URLSearchParams(body);
        for (const [key, value] of params) {
          payload[key] = value;
        }
      }
    }

    // Routes
    if (path === '/api/health' && method === 'GET') {
      this.handleHealth(res);
    } else if (path === '/api/jobs' && method === 'GET') {
      this.handleListJobs(query, res);
    } else if (path.startsWith('/api/jobs/') && method === 'GET') {
      const jobId = path.split('/').pop();
      this.handleGetJob(jobId || '', res);
    } else if (path === '/api/applications' && method === 'POST') {
      this.handleSubmitApplication(payload, res);
    } else if (path.startsWith('/api/applications/') && method === 'GET') {
      const appId = path.split('/').pop();
      this.handleGetApplication(appId || '', res);
    } else if (path === '/apply' && method === 'GET') {
      // Controlled transient failure injection (benchmark G)
      const failId = query.jobId || '';
      const skipLimit = this.transientSkip.get(failId) || 0;
      let seen = this.transientSkipSeen.get(failId) || 0;
      const remaining = this.transientFailures.get(failId) || 0;
      if (seen < skipLimit) {
        // Skip window: let the JD-extraction GET through untouched
        this.transientSkipSeen.set(failId, seen + 1);
        this.requestLog.push({ method, path, status: 200, at: Date.now() });
        this.handleApplyPage(query, res);
        return;
      }
      if (remaining > 0) {
        this.transientFailures.set(failId, remaining - 1);
        this.requestLog.push({ method, path, status: 500, at: Date.now() });
        console.log(`[FakeATS] INJECTED transient failure for ${failId} (remaining after this: ${remaining - 1})`);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<h1>500 Internal Server Error (injected transient failure)</h1>');
        return;
      }
      this.requestLog.push({ method, path, status: 200, at: Date.now() });
      this.handleApplyPage(query, res);
    } else if (path === '/apply' && method === 'POST') {
      this.requestLog.push({ method, path, status: 200, at: Date.now() });
      this.handleApplySubmit(payload, res);
    } else if (path === '/api/captcha' && method === 'GET') {
      this.handleCaptcha(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  private handleHealth(res: any): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
  }

  private handleListJobs(query: any, res: any): void {
    const jobs = Array.from(this.jobs.values()).filter(j => j.status === 'open');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jobs, total: jobs.length }));
  }

  private handleGetJob(jobId: string, res: any): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Job not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(job));
  }

  private handleSubmitApplication(payload: any, res: any): void {
    const jobId = payload.jobId;
    const job = this.jobs.get(jobId);

    if (!job) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Job not found' }));
      return;
    }

    const appId = `APP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const confirmationId = `CONF-${Date.now().toString(36).toUpperCase()}`;

    const application: FakeATSApplication = {
      id: appId,
      jobId,
      applicantData: payload.applicantData || {},
      resumeFile: payload.resumeFile,
      coverLetterFile: payload.coverLetterFile,
      status: 'submitted',
      submittedAt: new Date(),
      confirmationId,
    };

    this.applications.set(appId, application);

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      applicationId: appId,
      confirmationId,
      message: 'Application submitted successfully',
    }));
  }

  private handleGetApplication(appId: string, res: any): void {
    const application = this.applications.get(appId);
    if (!application) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Application not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(application));
  }

  private handleApplyPage(query: any, res: any): void {
    const jobId = query.jobId;
    const job = this.jobs.get(jobId || '');

    if (!job) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<h1>Job not found</h1>');
      return;
    }

    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Apply - ${job.title} at ${job.company}</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
    .form-group { margin-bottom: 15px; }
    label { display: block; margin-bottom: 5px; font-weight: bold; }
    input, textarea, select { width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; }
    button { background: #007bff; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; }
    button:hover { background: #0056b3; }
    .job-info { background: #f8f9fa; padding: 15px; border-radius: 4px; margin-bottom: 20px; }
  </style>
</head>
<body>
  <div class="job-info">
    <h2>${job.title}</h2>
    <p><strong>Company:</strong> ${job.company}</p>
    <p>${job.description}</p>
  </div>
  <form method="POST" action="/apply" enctype="multipart/form-data">
    <input type="hidden" name="jobId" value="${job.id}">
    <div class="form-group">
      <label>Full Name *</label>
      <input type="text" name="fullName" required>
    </div>
    <div class="form-group">
      <label>Email *</label>
      <input type="email" name="email" required>
    </div>
    <div class="form-group">
      <label>Phone *</label>
      <input type="tel" name="phone" required>
    </div>
    <div class="form-group">
      <label>LinkedIn</label>
      <input type="url" name="linkedin">
    </div>
    <div class="form-group">
      <label>GitHub</label>
      <input type="url" name="github">
    </div>
    <div class="form-group">
      <label>Cover Letter</label>
      <textarea name="coverLetter" rows="5"></textarea>
    </div>
    <div class="form-group">
      <label>Resume Upload *</label>
      <input type="file" name="resume" accept=".pdf,.doc,.docx" required>
    </div>
    <div class="form-group">
      <label>Cover Letter Upload</label>
      <input type="file" name="coverLetter" accept=".pdf,.doc,.docx">
    </div>${(job.extraFields || []).map(f => `
    <div class="form-group">
      <label>${f.label}</label>
      <input type="${f.type || 'text'}" name="${f.name}"${f.placeholder ? ` placeholder="${f.placeholder}"` : ''}${f.required ? ' required' : ''}>
    </div>`).join('')}
    <button type="submit">Submit Application</button>
  </form>
</body>
</html>`;

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  }

  private handleApplySubmit(payload: any, res: any): void {
    const jobId = payload.jobId;
    const job = this.jobs.get(jobId);

    if (!job) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<h1>Job not found</h1>');
      return;
    }

    const appId = `APP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const confirmationId = `CONF-${Date.now().toString(36).toUpperCase()}`;

    const application: FakeATSApplication = {
      id: appId,
      jobId,
      applicantData: payload,
      status: 'submitted',
      submittedAt: new Date(),
      confirmationId,
    };

    this.applications.set(appId, application);

    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Application Submitted</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
    .success { color: #28a745; }
    .confirmation { background: #f8f9fa; padding: 20px; border-radius: 4px; margin: 20px 0; }
  </style>
</head>
<body>
  <h1 class="success">Application Submitted Successfully!</h1>
  <div class="confirmation">
    <p><strong>Job:</strong> ${job.title} at ${job.company}</p>
    <p><strong>Application ID:</strong> ${appId}</p>
    <p><strong>Confirmation ID:</strong> ${confirmationId}</p>
    <p><strong>Submitted:</strong> ${new Date().toLocaleString()}</p>
  </div>
  <p>You will receive a confirmation email shortly.</p>
</body>
</html>`;

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  }

  private handleCaptcha(res: any): void {
    // Simulate CAPTCHA challenge
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      challengeId: `captcha-${Date.now()}`,
      type: 'image',
      imageUrl: '/api/captcha/image',
      expiresIn: 300,
    }));
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        console.log(`Fake ATS server running on http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => {
        console.log('Fake ATS server stopped');
        resolve();
      });
    });
  }

  // Test utilities
  getJob(jobId: string): FakeATSJob | undefined {
    return this.jobs.get(jobId);
  }

  // Benchmark utilities: add additional jobs (N-job benchmark batches)
  addJobs(jobs: FakeATSJob[]): void {
    for (const job of jobs) {
      this.jobs.set(job.id, job);
    }
  }

  // Benchmark utilities: inject N transient GET /apply failures for one job.
  // skipGets: ignore the first N GETs (the pipeline fetches the page once for JD
  // extraction before the browser navigates to it).
  injectTransientFailures(jobId: string, times: number, skipGets = 0): void {
    this.transientFailures.set(jobId, times);
    this.transientSkip.set(jobId, skipGets);
    this.transientSkipSeen.set(jobId, 0);
  }

  // Benchmark utilities: applications submitted for a given job (duplicate check)
  applicationsForJob(jobId: string): FakeATSApplication[] {
    return Array.from(this.applications.values()).filter(a => a.jobId === jobId);
  }

  // Benchmark utilities: request log for timing analysis
  getRequestLog(): Array<{ method: string; path: string; status: number; at: number }> {
    return [...this.requestLog];
  }

  clearRequestLog(): void {
    this.requestLog = [];
  }

  getApplication(appId: string): FakeATSApplication | undefined {
    return this.applications.get(appId);
  }

  getAllApplications(): FakeATSApplication[] {
    return Array.from(this.applications.values());
  }

  clearApplications(): void {
    this.applications.clear();
  }
}

// Export for use in tests
export { FakeATSServer, type FakeATSJob, type FakeATSApplication, type FakeATSExtraField };

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new FakeATSServer();
  server.start();

  process.on('SIGINT', async () => {
    await server.stop();
    process.exit(0);
  });
}