/**
 * OCR Microservice — HTTP server for text extraction from images/PDFs.
 *
 * POST /ocr — Accepts { imageBase64: string, mimeType?: string, mode?: 'receipt' | 'text' }
 *             Returns { text: string, confidence: number }
 *
 * POST /ocr/pdf — Accepts { pdfBase64: string } (base64-encoded PDF)
 *                 Returns { text: string, pages: Array<{text: string}> }
 *
 * GET  /health — Returns { status: 'ok' }
 *
 * Reads GEMINI_API_KEY from environment.
 * Supports: JPEG, PNG, WebP, HEIC, HEIF, GIF, PDF
 * Languages: English + Sinhala
 */

import express from 'express';
import { extractText, OcrResponse } from './gemini-ocr';
import { extractPdfText, pdfToImages, SUPPORTED_IMAGE_MIME_TYPES } from './pdf-utils';

const PORT = parseInt(process.env.OCR_PORT || '3099', 10);

const app = express();

// Allow large payloads (base64 of large images/PDFs)
app.use(express.json({ limit: '50mb' }));

// ── Health check ───────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'ocr-microservice', version: '1.0.0' });
});

// ── POST /ocr — image OCR ─────────────────────────────────────────────────

app.post('/ocr', async (req, res) => {
  try {
    const { imageBase64, mimeType, mode } = req.body as {
      imageBase64?: string;
      mimeType?: string;
      mode?: 'receipt' | 'text';
    };

    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return res.status(400).json({
        error: 'Missing required field: imageBase64',
      });
    }

    const result: OcrResponse = await extractText({
      imageBase64,
      mimeType,
      mode: mode || 'text',
    });

    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('OCR error:', message);
    res.status(500).json({ error: message });
  }
});

// ── POST /ocr/pdf — PDF OCR ────────────────────────────────────────────────

app.post('/ocr/pdf', async (req, res) => {
  try {
    const { pdfBase64 } = req.body as { pdfBase64?: string };

    if (!pdfBase64 || typeof pdfBase64 !== 'string') {
      return res.status(400).json({
        error: 'Missing required field: pdfBase64',
      });
    }

    const cleanBase64 = pdfBase64.replace(/^data:application\/pdf;base64,/, '');
    const pdfBuffer = Buffer.from(cleanBase64, 'base64');

    // First try text extraction via pdf-parse
    const { pages, totalPages } = await extractPdfText(pdfBuffer);

    // Check if pages have meaningful text
    const hasTextContent = pages.some(
      (p) => p.text.trim().length > 50 // More than 50 chars = real text
    );

    if (hasTextContent) {
      // Return the extracted text directly
      const combinedText = pages.map((p, i) => `[Page ${i + 1}]\n${p.text}`).join('\n\n');
      return res.json({
        text: combinedText,
        pages: pages.map((p) => ({ text: p.text })),
        confidence: 0.9,
        totalPages,
      });
    }

    // No meaningful text — try rendering to images then OCR each page
    const images = await pdfToImages(pdfBuffer);

    if (images.length === 0) {
      // No renderer available — return text extraction result as-is
      const combinedText = pages.map((p, i) => `[Page ${i + 1}]\n${p.text}`).join('\n\n');
      return res.json({
        text: combinedText,
        pages: pages.map((p) => ({ text: p.text })),
        confidence: 0.5,
        totalPages,
      });
    }

    // OCR each page image
    const ocrResults: string[] = [];
    for (const img of images) {
      try {
        const result = await extractText({
          imageBase64: img.base64,
          mimeType: img.mimeType,
          mode: 'text',
        });
        ocrResults.push(`[Page ${img.pageNumber + 1}]\n${result.text}`);
      } catch (err) {
        console.warn(`Failed to OCR page ${img.pageNumber + 1}:`, err);
        ocrResults.push(`[Page ${img.pageNumber + 1}]\n[OCR failed]`);
      }
    }

    return res.json({
      text: ocrResults.join('\n\n'),
      pages: images.map((img, i) => ({ text: ocrResults[i] })),
      confidence: 0.85,
      totalPages,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('PDF OCR error:', message);
    res.status(500).json({ error: message });
  }
});

// ── Start server ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`OCR microservice running on http://localhost:${PORT}`);
  console.log(`Endpoints:`);
  console.log(`  POST /ocr       — Extract text from image`);
  console.log(`  POST /ocr/pdf   — Extract text from PDF`);
  console.log(`  GET  /health    — Health check`);
  console.log(`Supported formats: ${SUPPORTED_IMAGE_MIME_TYPES.join(', ')}, PDF`);
  console.log(`Gemini model: ${process.env.GEMINI_OCR_MODEL || 'gemini-3.5-flash'}`);
});

export default app;
