/**
 * JD Extractor - extracts structured job description from HTML/ATS pages.
 */

import type { JDExtractionInput, JDExtractionResult, JobDescription, ApplicationQuestion as JDApplicationQuestion } from './types.ts';
import type { JobId, SkillCategory, Seniority, EmploymentType, RemotePolicy, SkillRequirement, ExperienceRequirement, EducationRequirement, SalaryRange, VisaRequirement } from '../core/types.ts';
import { generateJobId } from '../core/ids.ts';
import { logger } from '../core/logger.ts';
import { trackStage } from '../performance/hooks.ts';
import { STAGES } from '../performance/stages.ts';

const SKILL_CATEGORIES: Record<string, SkillCategory[]> = {
  'aws': ['cloud'], 'azure': ['cloud'], 'gcp': ['cloud'], 'google cloud': ['cloud'],
  'kubernetes': ['containerization'], 'docker': ['containerization'], 'container': ['containerization'],
  'terraform': ['infrastructure-as-code'], 'ansible': ['infrastructure-as-code'], 'cloudformation': ['infrastructure-as-code'],
  'ci/cd': ['ci-cd'], 'github actions': ['ci-cd'], 'gitlab ci': ['ci-cd'], 'jenkins': ['ci-cd'], 'circleci': ['ci-cd'],
  'prometheus': ['monitoring'], 'grafana': ['monitoring'], 'datadog': ['monitoring'], 'new relic': ['monitoring'],
  'python': ['programming', 'scripting'], 'go': ['programming'], 'golang': ['programming'], 'rust': ['programming'],
  'java': ['programming'], 'javascript': ['programming'], 'typescript': ['programming'],
  'postgresql': ['database'], 'mysql': ['database'], 'redis': ['database'], 'mongodb': ['database'],
  'nginx': ['networking'], 'istio': ['networking'], 'linkerd': ['networking'],
  'vault': ['security'], 'oauth': ['security'], 'saml': ['security'],
};

// Canonical grouping for skills that are equivalent in practice (e.g. any
// CI/CD tool satisfies a "ci/cd" requirement). Prevents the extractor from
// emitting the same requirement 4 times over (ci/cd, github actions, jenkins,
// gitlab ci) and lets the matcher treat them as one requirement.
const SKILL_CANONICAL: Record<string, string> = {
  'ci/cd': 'ci-cd', 'ci cd': 'ci-cd', 'continuous integration': 'ci-cd',
  'continuous deployment': 'ci-cd', 'github actions': 'ci-cd', 'gitlab ci': 'ci-cd',
  'jenkins': 'ci-cd', 'circleci': 'ci-cd', 'bamboo': 'ci-cd',
  'istio': 'service-mesh', 'linkerd': 'service-mesh',
  'aws': 'aws', 'amazon web services': 'aws',
  'azure': 'azure', 'microsoft azure': 'azure',
  'gcp': 'gcp', 'google cloud': 'gcp', 'google cloud platform': 'gcp',
  'kubernetes': 'kubernetes', 'k8s': 'kubernetes', 'kube': 'kubernetes',
  'prometheus': 'prometheus',
  'grafana': 'grafana',
  'datadog': 'datadog',
  'docker': 'docker',
  'terraform': 'terraform',
  'ansible': 'ansible',
  'go': 'go', 'golang': 'go',
  'python': 'python',
  'security': 'security',
  'monitoring': 'monitoring',
  'logging': 'logging',
};

function canonicalSkill(name: string): string {
  return SKILL_CANONICAL[name.toLowerCase().trim()] || name.toLowerCase().trim();
}

const SENIORITY_KEYWORDS: Record<Seniority, string[]> = {
  'intern': ['intern', 'internship', 'trainee', 'entry level', 'entry-level', 'junior'],
  'junior': ['junior', 'jr.', '0-2 years', '1-2 years', 'early career'],
  'mid': ['mid', 'mid-level', '2-4 years', '3-5 years', 'intermediate'],
  'senior': ['senior', 'sr.', '5+ years', '5-8 years', 'experienced'],
  'lead': ['lead', 'tech lead', 'team lead', 'leading', 'leadership'],
  'principal': ['principal', 'staff', 'architect', 'distinguished'],
  'staff': ['staff', 'principal'],
  'director': ['director', 'head of', 'vp engineering', 'vice president'],
  'vp': ['vp', 'vice president'],
  'c-level': ['cto', 'cio', 'chief technology', 'chief information'],
};

export class JDExtractor {
  extract(input: JDExtractionInput): JDExtractionResult {
    const t = trackStage(STAGES.JD_EXTRACTION, { source: input.url, jobId: undefined });
    const warnings: string[] = [];
    let descriptionText = this.extractTextFromHtml(input.html);
    
    if (!descriptionText || descriptionText.length < 200) {
      warnings.push('Extracted description is very short, may be incomplete');
      if (input.accessibilityTree) {
        descriptionText = this.extractFromAccessibilityTree(input.accessibilityTree);
      }
    }

    const jobDescription = this.parseJobDescription(input.url, descriptionText, warnings);
    const confidence = this.calculateConfidence(jobDescription, warnings);

    t.end(true);
    return {
      jobDescription,
      confidence,
      extractionMethod: 'dom',
      warnings,
    };
  }

  private extractTextFromHtml(html: string): string {
    // Remove scripts, styles, and other non-content elements
    let text = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '')
      .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, '')
      .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '')
      .replace(/<aside\b[^<]*(?:(?!<\/aside>)<[^<]*)*<\/aside>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&/g, '&')
      .replace(/</g, '<')
      .replace(/>/g, '>')
      .replace(/\s+/g, ' ')
      .trim();

    return text;
  }

  private extractFromAccessibilityTree(tree: any): string {
    if (!tree) return '';
    
    const extractNode = (node: any): string => {
      let text = '';
      if (node.name) text += node.name + ' ';
      if (node.value) text += node.value + ' ';
      if (node.description) text += node.description + ' ';
      if (node.children) {
        for (const child of node.children) {
          text += extractNode(child);
        }
      }
      return text;
    };

    return extractNode(tree).replace(/\s+/g, ' ').trim();
  }

  private parseJobDescription(url: string, text: string, warnings: string[]): JobDescription {
    const jobId = generateJobId('extracted', 'unknown', 'job') as JobId;
    
    // Extract company from URL or text
    const company = this.extractCompany(url, text) || 'Unknown Company';
    const title = this.extractTitle(text) || 'Unknown Position';
    
    // Parse structured sections
    const sections = this.parseSections(text);
    
    const requiredSkills = this.extractSkills(sections.requirements || '', 'required');
    const preferredSkills = this.extractSkills(sections.preferred || '', 'preferred');
    const niceToHaveSkills = this.extractSkills(sections.niceToHave || '', 'nice-to-have');
    
    const responsibilities = this.extractListItems(sections.responsibilities || '');
    const experienceRequirements = this.extractExperience(sections.requirements || '');
    const educationRequirements = this.extractEducation(sections.requirements || '');
    
    const cloudPlatforms = this.extractKeywords(text, ['aws', 'azure', 'gcp', 'google cloud']);
    const programmingLanguages = this.extractKeywords(text, ['python', 'go', 'golang', 'rust', 'java', 'javascript', 'typescript', 'c++', 'c#', 'ruby', 'php']);
    const devopsTools = this.extractKeywords(text, ['terraform', 'ansible', 'cloudformation', 'helm', 'kubernetes', 'docker', 'k8s']);
    const cicdTools = this.extractKeywords(text, ['github actions', 'gitlab ci', 'jenkins', 'circleci', 'ci/cd', 'ci cd', 'pipeline']);
    const monitoringTools = this.extractKeywords(text, ['prometheus', 'grafana', 'datadog', 'new relic', 'splunk', 'elk']);
    const databases = this.extractKeywords(text, ['postgresql', 'mysql', 'redis', 'mongodb', 'dynamodb', 'cassandra', 'elasticsearch']);
    const securityRequirements = this.extractKeywords(text, ['security', 'compliance', 'soc2', 'pci', 'hipaa', 'gdpr', 'encryption', 'iam']);
    
    const keywords = [...new Set([
      ...cloudPlatforms, ...programmingLanguages, ...devopsTools, 
      ...cicdTools, ...monitoringTools, ...databases, ...securityRequirements
    ])];

    const seniority = this.detectSeniority(text) || 'mid';
    const remotePolicy = this.detectRemotePolicy(text) || 'unspecified';
    const employmentType = this.detectEmploymentType(text) || 'full-time';

    return {
      jobId,
      company,
      title,
      location: this.extractLocation(text) || 'Not specified',
      remote: remotePolicy === 'fully-remote' || remotePolicy === 'hybrid',
      remotePolicy: remotePolicy as RemotePolicy,
      seniority: seniority as Seniority,
      employmentType: employmentType as EmploymentType,
      requiredSkills,
      preferredSkills,
      niceToHaveSkills,
      responsibilities,
      experienceRequirements,
      educationRequirements,
      certifications: this.extractCertifications(text),
      cloudPlatforms,
      programmingLanguages,
      devopsTools,
      cicdTools,
      monitoringTools,
      databases,
      securityRequirements,
      keywords,
      salary: this.extractSalary(text),
      visaRequirements: this.extractVisaRequirements(text),
      applicationQuestions: this.extractApplicationQuestions(text),
      otherConstraints: this.extractConstraints(text),
      fullText: text,
      extractedAt: new Date(),
      confidence: 0, // Will be set by caller
      sourceUrl: url,
      extractionMethod: 'dom',
    };
  }

  private parseSections(text: string): Record<string, string> {
    const sections: Record<string, string> = {};
    const sectionPatterns = {
      requirements: /(?:requirements?|qualifications?|what you.{0,10}need|must have)[:\s]*([\s\S]{0,2000}?)(?:\n\s*\n|$)/i,
      preferred: /(?:preferred|nice to have|bonus|plus)[:\s]*([\s\S]{0,2000}?)(?:\n\s*\n|$)/i,
      niceToHave: /(?:nice.{0,10}have|bonus|additional)[:\s]*([\s\S]{0,1000}?)(?:\n\s*\n|$)/i,
      responsibilities: /(?:responsibilities|duties|what you.{0,10}do|role)[:\s]*([\s\S]{0,2000}?)(?:\n\s*\n|$)/i,
      about: /(?:about|overview|description|summary)[:\s]*([\s\S]{0,2000}?)(?:\n\s*\n|$)/i,
    };

    for (const [key, pattern] of Object.entries(sectionPatterns)) {
      const match = text.match(pattern);
      if (match) sections[key] = match[1].trim();
    }

    return sections;
  }

  private extractSkills(text: string, importance: 'required' | 'preferred' | 'nice-to-have'): SkillRequirement[] {
    const skills: SkillRequirement[] = [];
    const skillKeywords = [
      'aws', 'azure', 'gcp', 'google cloud', 'kubernetes', 'docker', 'terraform', 'ansible',
      'python', 'go', 'golang', 'rust', 'java', 'javascript', 'typescript', 'c++', 'c#',
      'postgresql', 'mysql', 'redis', 'mongodb', 'prometheus', 'grafana', 'datadog',
      'ci/cd', 'github actions', 'gitlab ci', 'jenkins', 'circleci', 'helm', 'istio', 'linkerd',
      'kafka', 'rabbitmq', 'elasticsearch', 'spark', 'hadoop', 'airflow', 'dagster',
      'git', 'linux', 'bash', 'shell', 'networking', 'security', 'monitoring', 'logging'
    ];

    // Deduplicate by canonical name so "ci/cd", "github actions" and "jenkins"
    // don't each become a separate required skill. First-seen importance wins.
    const foundSkills = new Set<string>();
    const canonicalSeen = new Set<string>();
    const lowerText = text.toLowerCase();

    for (const skill of skillKeywords) {
      if (lowerText.includes(skill.toLowerCase()) && !foundSkills.has(skill)) {
        foundSkills.add(skill);
        const canonical = canonicalSkill(skill);
        if (canonicalSeen.has(canonical)) continue;
        canonicalSeen.add(canonical);
        const categories = SKILL_CATEGORIES[skill.toLowerCase()] || ['other'];
        skills.push({
          name: skill,
          category: categories[0],
          importance,
          confidence: 0.8,
        });
      }
    }

    return skills;
  }

  private extractListItems(text: string): string[] {
    const items: string[] = [];
    const lines = text.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.match(/^[\-\*\•\d+\.\)]\s+/) || trimmed.match(/^[A-Z][^.]{10,}\.$/)) {
        const cleaned = trimmed.replace(/^[\-\*\•\d+\.\)]\s+/, '');
        if (cleaned.length > 10) items.push(cleaned);
      }
    }
    
    return items.slice(0, 20);
  }

  private extractExperience(text: string): ExperienceRequirement[] {
    const experiences: ExperienceRequirement[] = [];
    const expPattern = /(\d+)\+?\s*years?\s*(?:of\s*)?(?:experience\s*)?(?:in|with|using)?\s*([^.\n,]{2,50})/gi;
    let match;
    
    while ((match = expPattern.exec(text)) !== null && experiences.length < 10) {
      experiences.push({
        domain: match[2].trim(),
        minYears: parseInt(match[1], 10),
        details: match[0],
      });
    }
    
    return experiences;
  }

  private extractEducation(text: string): EducationRequirement[] {
    const education: EducationRequirement[] = [];
    const degreePattern = /(bachelor|master|phd|doctorate|associate|degree)\s*(?:in|of)?\s*([^.\n,]{2,50})/gi;
    let match;
    
    while ((match = degreePattern.exec(text)) !== null && education.length < 5) {
      education.push({
        degree: match[1].charAt(0).toUpperCase() + match[1].slice(1),
        field: match[2].trim(),
        required: true,
      });
    }
    
    return education;
  }

  private extractCertifications(text: string): string[] {
    const certs: string[] = [];
    const certPatterns = [
      /aws\s*(?:certified|certification)?\s*\w*/gi,
      /azure\s*(?:certified|certification)?\s*\w*/gi,
      /gcp\s*(?:certified|certification)?\s*\w*/gi,
      /ckad?|cka|cks/gi,
      /terraform\s*(?:associate|professional)?/gi,
      /pmp|cissp|cisa|cism/gi,
    ];
    
    for (const pattern of certPatterns) {
      const matches = text.match(pattern);
      if (matches) certs.push(...matches.map(m => m.toUpperCase()));
    }
    
    return [...new Set(certs)];
  }

  private extractKeywords(text: string, keywords: string[]): string[] {
    const lowerText = text.toLowerCase();
    return keywords.filter(k => lowerText.includes(k.toLowerCase()));
  }

  private detectSeniority(text: string): Seniority | null {
    const lowerText = text.toLowerCase();
    for (const [level, keywords] of Object.entries(SENIORITY_KEYWORDS)) {
      if (keywords.some(k => lowerText.includes(k))) {
        return level as Seniority;
      }
    }
    return null;
  }

  private detectRemotePolicy(text: string): RemotePolicy | null {
    const lowerText = text.toLowerCase();
    if (lowerText.includes('fully remote') || lowerText.includes('100% remote') || lowerText.includes('work from anywhere')) return 'fully-remote';
    if (lowerText.includes('hybrid')) return 'hybrid';
    if (lowerText.includes('on.site') || lowerText.includes('on-site') || lowerText.includes('office')) return 'on-site';
    if (lowerText.includes('remote with travel') || lowerText.includes('occasional travel')) return 'remote-with-travel';
    return null;
  }

  private detectEmploymentType(text: string): EmploymentType | null {
    const lowerText = text.toLowerCase();
    if (lowerText.includes('full.time') || lowerText.includes('full-time')) return 'full-time';
    if (lowerText.includes('part.time') || lowerText.includes('part-time')) return 'part-time';
    if (lowerText.includes('contract') || lowerText.includes('contractor')) return 'contract';
    if (lowerText.includes('intern')) return 'internship';
    if (lowerText.includes('freelance')) return 'freelance';
    return null;
  }

  private extractLocation(text: string): string | null {
    // Simple location extraction - look for city, state patterns
    const locationPattern = /(?:location|based in|office in)[:\s]*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?:,\s*[A-Z]{2})?)/i;
    const match = text.match(locationPattern);
    return match ? match[1].trim() : null;
  }

  private extractSalary(text: string): SalaryRange | undefined {
    const salaryPattern = /\$(\d{2,3})(?:,\d{3})*(?:\s*[-–]\s*\$?(\d{2,3})(?:,\d{3})*)?\s*(?:per\s*(?:year|annum|month|hour)|k?\s*(?:yearly|annually|monthly|hourly))?/i;
    const match = text.match(salaryPattern);
    
    if (match) {
      const min = parseInt(match[1].replace(/,/g, ''), 10) * (match[1].length <= 3 ? 1000 : 1);
      const max = match[2] ? parseInt(match[2].replace(/,/g, ''), 10) * (match[2].length <= 3 ? 1000 : 1) : undefined;
      return {
        min,
        max,
        currency: 'USD',
        period: 'yearly',
        negotiable: text.toLowerCase().includes('negotiable'),
      };
    }
    return undefined;
  }

  private extractVisaRequirements(text: string): VisaRequirement | undefined {
    const lowerText = text.toLowerCase();
    const sponsorship = lowerText.includes('visa sponsorship') || 
                        lowerText.includes('sponsor visa') || 
                        lowerText.includes('h1b') || 
                        lowerText.includes('work authorization');
    
    if (sponsorship) {
      return {
        sponsorship: true,
        details: lowerText.includes('h1b') ? 'H1B sponsorship available' : 'Visa sponsorship mentioned',
      };
    }
    
    if (lowerText.includes('no sponsorship') || lowerText.includes('cannot sponsor') || lowerText.includes('not sponsor')) {
      return { sponsorship: false, details: 'Explicitly states no sponsorship' };
    }
    
    return undefined;
  }

  private extractApplicationQuestions(text: string): JDApplicationQuestion[] {
    const questions: JDApplicationQuestion[] = [];
    const questionPattern = /(?:question|ask)[:\s]*([^?\n]{10,}\??)/gi;
    let match;

    while ((match = questionPattern.exec(text)) !== null && questions.length < 10) {
      questions.push({
        question: match[1].trim(),
        type: 'text',
        required: false,
      });
    }

    return questions;
  }

  private extractConstraints(text: string): string[] {
    const constraints: string[] = [];
    const lowerText = text.toLowerCase();
    
    const constraintKeywords = [
      'security clearance', 'background check', 'drug test', 'non-compete',
      'relocation', 'travel required', 'on-call', 'shift work',
      'us citizen', 'green card', 'permanent resident',
    ];
    
    for (const keyword of constraintKeywords) {
      if (lowerText.includes(keyword)) {
        constraints.push(keyword);
      }
    }
    
    return constraints;
  }

  private extractCompany(url: string, text: string): string | null {
    // Try to extract from URL
    const urlMatch = url.match(/https?:\/\/([^\/]+)/);
    if (urlMatch) {
      const domain = urlMatch[1].replace('www.', '');
      const parts = domain.split('.');
      if (parts.length >= 2) {
        return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
      }
    }
    
    // Try to extract from text
    const companyPattern = /(?:company|organization|employer)[:\s]*([A-Z][a-zA-Z0-9\s&.,]{2,50})/i;
    const match = text.match(companyPattern);
    return match ? match[1].trim() : null;
  }

  private extractTitle(text: string): string | null {
    // Look for job title patterns at the beginning
    const lines = text.split('\n').slice(0, 10);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length > 5 && trimmed.length < 100 && 
          (trimmed.match(/^(?:senior|junior|lead|principal|staff)\s+/i) ||
           trimmed.match(/^(?:software|devops|platform|cloud|data|backend|frontend|full.stack|machine.learning|ai)\s+/i))) {
        return trimmed;
      }
    }
    return null;
  }

  private calculateConfidence(jd: JobDescription, warnings: string[]): number {
    let confidence = 0.5;
    
    if (jd.requiredSkills.length > 0) confidence += 0.15;
    if (jd.preferredSkills.length > 0) confidence += 0.1;
    if (jd.responsibilities.length > 0) confidence += 0.1;
    if (jd.experienceRequirements.length > 0) confidence += 0.1;
    if (jd.fullText.length > 500) confidence += 0.1;
    if (jd.company !== 'Unknown Company') confidence += 0.1;
    if (jd.title !== 'Unknown Position') confidence += 0.1;
    
    confidence -= warnings.length * 0.05;
    
    return Math.max(0, Math.min(1, confidence));
  }
}
