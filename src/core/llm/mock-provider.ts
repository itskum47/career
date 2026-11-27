/**
 * Mock LLM provider for testing and offline development.
 * Returns deterministic responses based on request content.
 */

import type { LLMRequest, LLMResponse, LLMStreamChunk, LLMProvider } from './types.ts';
import { logger } from '../logger.ts';

export class MockLLMProvider implements LLMProvider {
  readonly name = 'mock';

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async getModels(): Promise<string[]> {
    return ['mock-v1'];
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const start = Date.now();

    // Deterministic canned responses based on request content
    const content = this.generateCannedResponse(request);

    logger.debug('Mock LLM response generated', {
      promptLength: request.messages.map(m => m.content).join('').length,
      responseLength: content.length,
    });

    return {
      content,
      model: 'mock-v1',
      provider: 'mock',
      latencyMs: Date.now() - start,
      cached: false,
      finishReason: 'stop',
    };
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamChunk> {
    const response = await this.generate(request);
    const words = response.content.split(/(\s+)/);
    for (const word of words) {
      yield { content: word, done: false };
    }
    yield { content: '', done: true };
  }

  private generateCannedResponse(request: LLMRequest): string {
    const combined = request.messages.map(m => m.content).join(' ').toLowerCase();

    if (request.jsonMode) {
      return this.generateJsonResponse(combined);
    }

    if (combined.includes('extract') || combined.includes('job description')) {
      return this.extractCannedJD(combined);
    }

    if (combined.includes('match') || combined.includes('score')) {
      return JSON.stringify({
        overallScore: 72,
        requiredSkillCoverage: 0.8,
        preferredSkillCoverage: 0.6,
        experienceMatch: 0.75,
        projectRelevance: 0.7,
        cloudPlatformMatch: 0.8,
        educationMatch: 0.9,
        locationMatch: 0.8,
        authorizationCompatibility: 1.0,
        keywordCoverage: 0.7,
        missingRequired: [],
        missingPreferred: [{ skill: 'Terraform', category: 'infrastructure-as-code', importance: 'preferred', candidateHas: false }],
        explanation: 'Strong match with cloud and DevOps skills. Missing Terraform preferred skill.',
        recommendation: 'APPLY',
        confidence: 0.85,
        analyzedAt: new Date().toISOString(),
      });
    }

    if (combined.includes('resume') || combined.includes('cv')) {
      return 'Generated resume content with tailored sections.';
    }

    if (combined.includes('cover letter') || combined.includes('coverletter')) {
      return 'Dear Hiring Manager,\n\nI am excited to apply for this position...';
    }

    return 'Mock LLM response for the given request.';
  }

  private generateJsonResponse(combined: string): string {
    if (combined.includes('extract') || combined.includes('job description')) {
      return this.extractCannedJD(combined);
    }
    if (combined.includes('match') || combined.includes('score')) {
      return JSON.stringify({
        overallScore: 72,
        recommendation: 'APPLY',
        confidence: 0.85,
      });
    }
    if (combined.includes('question') || combined.includes('answer')) {
      return JSON.stringify({ answer: 'I have 5 years of relevant experience.', confidence: 0.7 });
    }
    return JSON.stringify({ result: 'mock response', confidence: 0.5 });
  }

  private extractCannedJD(combined: string): string {
    return JSON.stringify({
      company: 'MockTech Inc',
      title: 'Senior DevOps Engineer',
      location: 'Remote',
      remote: true,
      remotePolicy: 'fully-remote',
      seniority: 'senior',
      employmentType: 'full-time',
      requiredSkills: [
        { name: 'AWS', category: 'cloud', importance: 'required', confidence: 0.9 },
        { name: 'Kubernetes', category: 'containerization', importance: 'required', confidence: 0.9 },
      ],
      preferredSkills: [
        { name: 'Terraform', category: 'infrastructure-as-code', importance: 'preferred', confidence: 0.8 },
      ],
      niceToHaveSkills: [],
      responsibilities: ['Manage CI/CD pipelines', 'Automate infrastructure'],
      experienceRequirements: [{ domain: 'DevOps', minYears: 5 }],
      educationRequirements: [],
      cloudPlatforms: ['AWS'],
      programmingLanguages: ['Python', 'Go'],
      devopsTools: ['Terraform', 'Kubernetes', 'Docker'],
      cicdTools: ['GitHub Actions', 'Jenkins'],
      monitoringTools: ['Prometheus', 'Grafana'],
      databases: ['PostgreSQL'],
      securityRequirements: ['IAM'],
      keywords: ['aws', 'kubernetes', 'terraform', 'ci-cd'],
      applicationQuestions: [],
      otherConstraints: [],
    });
  }
}