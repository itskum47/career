/**
 * File storage utilities for CVs, cover letters, and application artifacts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../core/config.ts';
import { logger } from '../core/logger.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class FileStorage {
  private cvOutputDir: string;
  private applicationsDir: string;

  constructor() {
    this.cvOutputDir = config.desktop.cvOutputDir;
    this.applicationsDir = path.resolve(__dirname, '../../applications');
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    for (const dir of [this.cvOutputDir, this.applicationsDir]) {
      try {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
          logger.info('Created directory', { path: dir });
        }
      } catch (error) {
        // Non-fatal: the CV output directory may be unavailable (e.g. sandbox or
        // a read-only Desktop). CV saving will fail later with a clear error.
        logger.warn('Could not create directory', { path: dir, error: String(error) });
      }
    }
  }

  getCVOutputDir(): string {
    return this.cvOutputDir;
  }

  getApplicationsDir(): string {
    return this.applicationsDir;
  }

  getApplicationDir(applicationId: string): string {
    const appDir = path.join(this.applicationsDir, applicationId);
    if (!fs.existsSync(appDir)) {
      fs.mkdirSync(appDir, { recursive: true });
      // Create subdirectories
      fs.mkdirSync(path.join(appDir, 'screenshots'), { recursive: true });
      fs.mkdirSync(path.join(appDir, 'browser-state'), { recursive: true });
    }
    return appDir;
  }

  generateCVFileName(company: string, title: string, format: 'pdf' | 'docx'): string {
    const date = new Date().toISOString().split('T')[0];
    const safeCompany = company.replace(/[^a-zA-Z0-9]/g, '_');
    const safeTitle = title.replace(/[^a-zA-Z0-9]/g, '_');
    return `${safeCompany}_${safeTitle}_${date}.${format}`;
  }

  generateCoverLetterFileName(company: string, title: string, format: 'pdf' | 'docx'): string {
    const date = new Date().toISOString().split('T')[0];
    const safeCompany = company.replace(/[^a-zA-Z0-9]/g, '_');
    const safeTitle = title.replace(/[^a-zA-Z0-9]/g, '_');
    return `CoverLetter_${safeCompany}_${safeTitle}_${date}.${format}`;
  }

  getCVPath(company: string, title: string, format: 'pdf' | 'docx'): string {
    const fileName = this.generateCVFileName(company, title, format);
    return path.join(this.cvOutputDir, fileName);
  }

  getCoverLetterPath(company: string, title: string, format: 'pdf' | 'docx'): string {
    const fileName = this.generateCoverLetterFileName(company, title, format);
    return path.join(this.cvOutputDir, fileName);
  }

  getApplicationFilePath(applicationId: string, fileName: string): string {
    return path.join(this.getApplicationDir(applicationId), fileName);
  }

  async saveCV(content: Buffer | string, company: string, title: string, format: 'pdf' | 'docx'): Promise<string> {
    const filePath = this.getCVPath(company, title, format);
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    await fs.promises.writeFile(filePath, buffer);
    logger.info('CV saved', { path: filePath, company, title, format });
    return filePath;
  }

  async saveCoverLetter(content: Buffer | string, company: string, title: string, format: 'pdf' | 'docx'): Promise<string> {
    const filePath = this.getCoverLetterPath(company, title, format);
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    await fs.promises.writeFile(filePath, buffer);
    logger.info('Cover letter saved', { path: filePath, company, title, format });
    return filePath;
  }

  async saveApplicationFile(applicationId: string, fileName: string, content: Buffer | string): Promise<string> {
    const filePath = this.getApplicationFilePath(applicationId, fileName);
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    await fs.promises.writeFile(filePath, buffer);
    return filePath;
  }

  async readApplicationFile(applicationId: string, fileName: string): Promise<Buffer> {
    const filePath = this.getApplicationFilePath(applicationId, fileName);
    return fs.promises.readFile(filePath);
  }

  listApplicationFiles(applicationId: string): string[] {
    const appDir = this.getApplicationDir(applicationId);
    try {
      return fs.readdirSync(appDir, { recursive: true }) as string[];
    } catch {
      return [];
    }
  }

  fileExists(filePath: string): boolean {
    return fs.existsSync(filePath);
  }

  getFileStats(filePath: string): fs.Stats | null {
    try {
      return fs.statSync(filePath);
    } catch {
      return null;
    }
  }
}

export const fileStorage = new FileStorage();
