/**
 * PDF page-to-image conversion utilities.
 *
 * Converts PDF pages to PNG images so they can be sent to Gemini Flash Vision
 * for OCR. Uses pdf-parse for text extraction fallback and sharp for any
 * image pre-processing if needed.
 *
 * The primary conversion method uses a page-by-page approach: since we can't
 * use puppeteer/canvas in a lightweight service, we use pdf-parse for
 * text-first extraction and fall back to marking pages for image-based OCR.
 *
 * For true image-based PDF conversion (render PDF pages to images), the
 * service expects a separate PDF-to-image renderer (like pdftoppm or
 * sharp-based rendering of canvas-backed PDF). In this implementation,
 * we extract text directly via pdf-parse and also provide the raw PDF
 * buffer for server-side rendering if a renderer is available.
 */

import pdfParse from 'pdf-parse';

export interface PdfPage {
  /** 0-indexed page number */
  pageNumber: number;
  /** Extracted text from the page (may be empty for scanned docs) */
  text: string;
}

/**
 * Extract text from a PDF buffer using pdf-parse.
 *
 * For scanned PDFs (no embedded text), returns empty text. The caller
 * should then send the first page as an image to the Gemini API.
 *
 * @param pdfBuffer - Raw PDF file buffer
 * @returns Array of page text and metadata
 */
export async function extractPdfText(pdfBuffer: Buffer): Promise<{
  pages: PdfPage[];
  totalPages: number;
  metadata: Record<string, any>;
}> {
  let data;
  try {
    data = await pdfParse(pdfBuffer);
  } catch (err) {
    // pdf-parse (pdf.js) can fail on malformed xref entries in minimal PDFs.
    // Fall back to basic text extraction from the raw buffer.
    const raw = pdfBuffer.toString('latin1');
    // Try to find text between parentheses in PDF stream objects (common pattern)
    const textMatches: string[] = [];
    const parenRegex = /\(([^)]*)\)/g;
    let match;
    while ((match = parenRegex.exec(raw)) !== null) {
      const t = match[1].trim();
      if (t.length > 0) textMatches.push(t);
    }
    const fallbackText = textMatches.length > 0
      ? textMatches.join('\n')
      : '';

    return {
      pages: fallbackText
        ? [{ pageNumber: 0, text: fallbackText }]
        : [],
      totalPages: 1,
      metadata: {},
    };
  }

  const pages: PdfPage[] = [];
  // pdf-parse provides concatenated text but not per-page. We split on
  // form feed characters (page breaks) if present, or treat as single page.
  const pageTexts = data.text.split('\f').filter((t) => t.trim().length > 0);

  for (let i = 0; i < (pageTexts.length || 1); i++) {
    pages.push({
      pageNumber: i,
      text: pageTexts[i] || data.text,
    });
  }

  return {
    pages,
    totalPages: data.numpages || pages.length || 1,
    metadata: {
      author: data.info?.Author || null,
      creator: data.info?.Creator || null,
      producer: data.info?.Producer || null,
      creationDate: data.info?.CreationDate || null,
      title: data.info?.Title || null,
    },
  };
}

/**
 * Convert a PDF buffer to a list of base64-encoded PNG page images.
 *
 * Since we can't use puppeteer or canvas in this lightweight service,
 * we check for the `pdftoppm` binary on the system. If available, we use
 * it to render each page to a PNG. Otherwise, we extract text directly.
 *
 * @param pdfBuffer - Raw PDF file buffer
 * @returns Array of base64-encoded PNG images (one per page)
 */
export async function pdfToImages(pdfBuffer: Buffer): Promise<
  Array<{
    pageNumber: number;
    base64: string;
    mimeType: string;
  }>
> {
  // Try using pdftoppm (part of poppler-utils) for rendering
  try {
    const { execSync } = await import('child_process');
    const { writeFileSync, unlinkSync, mkdtempSync, readFileSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');

    // Check if pdftoppm is available
    execSync('which pdftoppm', { stdio: 'ignore' });

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdf-ocr-'));
    const pdfPath = join(tmpDir, 'input.pdf');
    writeFileSync(pdfPath, pdfBuffer);

    // Render all pages to PNG
    const outPrefix = join(tmpDir, 'page');
    execSync(`pdftoppm -png -r 200 "${pdfPath}" "${outPrefix}"`, {
      stdio: 'ignore',
      timeout: 30000,
    });

    // Read rendered pages
    const { readdirSync } = await import('fs');
    const files = readdirSync(tmpDir).filter(
      (f: string) => f.startsWith('page-') && f.endsWith('.png')
    );
    files.sort();

    const images: Array<{ pageNumber: number; base64: string; mimeType: string }> = [];

    for (const file of files) {
      const pageNum = parseInt(file.match(/page-(\d+)/)?.[1] || '0', 10);
      const data = readFileSync(join(tmpDir, file));
      images.push({
        pageNumber: pageNum - 1,
        base64: data.toString('base64'),
        mimeType: 'image/png',
      });
    }

    // Cleanup
    for (const f of files) unlinkSync(join(tmpDir, f));
    unlinkSync(pdfPath);
    try {
      const { rmdirSync } = await import('fs');
      rmdirSync(tmpDir);
    } catch {}

    return images;
  } catch {
    // pdftoppm not available — return empty images array, caller falls back to text extraction
    return [];
  }
}

/**
 * Supported image MIME types for OCR.
 */
export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
];

export const SUPPORTED_IMAGE_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.heic',
  '.heif',
  '.gif',
];
