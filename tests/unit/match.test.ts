/**
 * Unit tests for candidate matching engine.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CandidateMatcher } from '@job-agent/match/engine.js';
import type { MasterProfile, JobDescription, MatchAnalysis } from '@job-agent/core/types.js';

const mockProfile: MasterProfile = {
  candidateId: 'CAND-test' as any,
  personal: {
    fullName: 'Test User',
    email: 'test@example.com',
    phone: '+1234567890',
    location: 'San Francisco, CA',
    summary: 'Experienced DevOps engineer',
    linkedin: 'https://linkedin.com/in/test',
    github: 'https://github.com/test',
    portfolio: 'https://test.dev',
    website: 'https://test.dev',
  },
  skills: [
    {
      name: 'AWS',
      category: 'cloud',
      proficiency: 'expert',
      yearsExperience: 5,
      lastUsed: new Date(),
      evidence: [],
    },
    {
      name: 'Kubernetes',
      category: 'containerization',
      proficiency: 'advanced',
      yearsExperience: 4,
      lastUsed: new Date(),
      evidence: [],
    },
    {
      name: 'Docker',
      category: 'containerization',
      proficiency: 'expert',
      yearsExperience: 5,
      lastUsed: new Date(),
      evidence: [],
    },
    {
      name: 'Terraform',
      category: 'infrastructure-as-code',
      proficiency: 'advanced',
      yearsExperience: 3,
      lastUsed: new Date(),
      evidence: [],
    },
  ],
  experience: [
    {
      id: 'exp1',
      title: 'Senior DevOps Engineer',
      company: 'Tech Corp',
      startDate: new Date('2020-01-01'),
      endDate: undefined,
      current: true,
      location: 'San Francisco, CA',
      remote: true,
      description: 'Managing cloud infrastructure at scale',
      achievements: ['Reduced costs by 30%'],
      technologies: ['AWS', 'Kubernetes', 'Terraform'],
    },
  ],
  education: [
    {
      id: 'edu1',
      degree: 'Bachelor of Science',
      field: 'Computer Science',
      institution: 'Stanford University',
      startDate: new Date('2014-09-01'),
      endDate: new Date('2018-06-01'),
      location: 'Stanford, CA',
      gpa: '3.8',
    },
  ],
  certifications: [
    {
      id: 'cert1',
      name: 'AWS Certified Solutions Architect',
      issuer: 'Amazon Web Services',
      issueDate: new Date('2020-06-01'),
    },
  ],
  projects: [],
  achievements: [],
  compensation: {
    minBase: 120000,
    targetBase: 150000,
    currency: 'USD',
    benefitsPriorities: ['healthcare', 'equity'],
  },
  preferences: {
    targetRoles: ['DevOps Engineer', 'Platform Engineer'],
    targetSeniority: ['senior'],
    targetLocations: ['Remote', 'San Francisco, CA'],
    remotePreference: ['fully-remote', 'hybrid'],
    noticePeriodDays: 30,
    currency: 'USD',
    workAuthorization: ['citizen'],
  },
  authorization: {
    countries: ['USA'],
    workAuthorizations: ['citizen'],
    requiresSponsorship: false,
  },
  questionAnswers: [],
  version: 1,
  updatedAt: new Date(),
};

const mockJobDescription: JobDescription = {
  jobId: 'JOB-123' as any,
  company: 'Test Company',
  title: 'DevOps Engineer',
  location: 'San Francisco, CA',
  remote: true,
  remotePolicy: 'hybrid',
  seniority: 'senior',
  employmentType: 'full-time',
  requiredSkills: [
    {
      name: 'AWS',
      category: 'cloud',
      importance: 'required',
      yearsExperience: 3,
      confidence: 0.9,
    },
    {
      name: 'Kubernetes',
      category: 'containerization',
      importance: 'required',
      yearsExperience: 2,
      confidence: 0.85,
    },
  ],
  preferredSkills: [
    {
      name: 'Terraform',
      category: 'infrastructure-as-code',
      importance: 'preferred',
      yearsExperience: 1,
      confidence: 0.8,
    },
    {
      name: 'Docker',
      category: 'containerization',
      importance: 'preferred',
      yearsExperience: 2,
      confidence: 0.9,
    },
  ],
  niceToHaveSkills: [
    {
      name: 'GCP',
      category: 'cloud',
      importance: 'nice-to-have',
      confidence: 0.7,
    },
  ],
  responsibilities: ['Manage cloud infrastructure', 'Implement CI/CD pipelines'],
  experienceRequirements: [],
  educationRequirements: [],
  certifications: ['AWS Certified Solutions Architect'],
  cloudPlatforms: ['AWS', 'GCP'],
  programmingLanguages: ['Python', 'Go'],
  devopsTools: ['Docker', 'Kubernetes', 'Terraform'],
  cicdTools: ['GitHub Actions', 'GitLab CI'],
  monitoringTools: ['Prometheus', 'Grafana'],
  databases: ['PostgreSQL', 'Redis'],
  securityRequirements: [],
  keywords: ['devops', 'kubernetes', 'aws', 'terraform'],
  fullText: 'Full job description text',
  extractedAt: new Date(),
  confidence: 0.95,
  sourceUrl: 'https://example.com/job',
  extractionMethod: 'llm',
  applicationQuestions: [],
  otherConstraints: [],
} as JobDescription;

describe('CandidateMatcher', () => {
  let matcher: CandidateMatcher;

  beforeEach(() => {
    matcher = new CandidateMatcher();
  });

  it('should match candidate with job', () => {
    const result = matcher.match(mockJobDescription, mockProfile);

    expect(result).toBeDefined();
    expect(String(result.jobId)).toBe('JOB-123');
    expect(String(result.candidateId)).toBe('CAND-test');
    expect(result.overallScore).toBeGreaterThan(50);
    expect(result.recommendation).toBeDefined();
    expect(['APPLY', 'SKIP', 'REVIEW']).toContain(result.recommendation);
  });

  it('should calculate required skill coverage', () => {
    const result = matcher.match(mockJobDescription, mockProfile);

    expect(result.requiredSkillCoverage).toBeGreaterThan(0);
    expect(result.requiredSkillCoverage).toBeLessThanOrEqual(100);
  });

  it('should identify missing required skills', () => {
    const result = matcher.match(mockJobDescription, mockProfile);

    // AWS and Kubernetes are in profile, should not be missing
    const missingNames = result.missingRequired.map(m => m.skill.toLowerCase());
    expect(missingNames).not.toContain('aws');
    expect(missingNames).not.toContain('kubernetes');
  });

  it('should calculate experience match', () => {
    const result = matcher.match(mockJobDescription, mockProfile);

    expect(result.experienceMatch).toBeGreaterThan(0);
    expect(result.experienceMatch).toBeLessThanOrEqual(100);
  });

  it('should calculate keyword coverage', () => {
    const result = matcher.match(mockJobDescription, mockProfile);

    expect(result.keywordCoverage).toBeGreaterThan(0);
    expect(result.keywordCoverage).toBeLessThanOrEqual(100);
  });

  it('should provide explanation', () => {
    const result = matcher.match(mockJobDescription, mockProfile);

    expect(result.explanation).toBeTruthy();
    expect(result.explanation.length).toBeGreaterThan(0);
  });

  it('should set confidence level', () => {
    const result = matcher.match(mockJobDescription, mockProfile);

    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('should recommend APPLY for strong match', () => {
    const result = matcher.match(mockJobDescription, mockProfile);

    if (result.overallScore >= 70) {
      expect(result.recommendation).toBe('APPLY');
    }
  });

  it('should generate analyzedAt date', () => {
    const result = matcher.match(mockJobDescription, mockProfile);

    expect(result.analyzedAt).toBeInstanceOf(Date);
  });
});