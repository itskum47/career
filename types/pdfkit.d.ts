declare module 'pdfkit' {
  import { Writable } from 'stream';

  interface PDFKitOptions {
    size?: string;
    margin?: number;
    layout?: string;
    bufferPages?: boolean;
    autoFirstPage?: boolean;
  }

  interface PDFKitDocument extends Writable {
    font(name: string, options?: any): this;
    fontSize(size: number): this;
    text(text: string, options?: any): this;
    moveDown(lines?: number): this;
    moveTo(x: number, y: number): this;
    lineTo(x: number, y: number): this;
    stroke(): this;
    on(event: 'data', listener: (chunk: Buffer) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    end(): void;
    y: number;
  }

  class PDFDocument extends Writable {
    constructor(options?: PDFKitOptions);
    font(name: string, options?: any): this;
    fontSize(size: number): this;
    text(text: string, options?: any): this;
    moveDown(lines?: number): this;
    moveTo(x: number, y: number): this;
    lineTo(x: number, y: number): this;
    stroke(): this;
    y: number;
  }

  export default PDFDocument;
}