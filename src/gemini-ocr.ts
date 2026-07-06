/**
 * Gemini Flash Vision OCR — shared logic for text extraction from images.
 *
 * Supports English + Sinhala text extraction from receipt, document, and
 * chat-screenshot images. Used by both the HTTP server and direct callers.
 *
 * Environment:
 *   GEMINI_API_KEY — required
 */

const GEMINI_MODEL = process.env.GEMINI_OCR_MODEL || 'gemini-3.5-flash';
const GEMINI_API_BASE =
  process.env.GEMINI_API_BASE ||
  'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_TIMEOUT_MS = (() => {
  const raw = process.env.GEMINI_OCR_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
})();

export interface OcrRequest {
  imageBase64: string;
  mimeType?: string;
  /** If 'receipt', uses a structured JSON extraction prompt. Otherwise plain text. */
  mode?: 'receipt' | 'text';
}

export interface OcrResponse {
  text: string;
  confidence: number;
}

/**
 * Extract text from a base64-encoded image using Gemini Flash Vision.
 *
 * @param params - OcrRequest with image data
 * @returns Extracted text and confidence score
 */
export async function extractText(params: OcrRequest): Promise<OcrResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Gemini OCR: GEMINI_API_KEY is not set in environment variables.');
  }

  const url = `${GEMINI_API_BASE}/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  // Strip data URI prefix if present
  const cleanBase64 = params.imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');

  // Detect MIME type from base64 header bytes or use the one provided
  const mimeType = params.mimeType || sniffMimeType(cleanBase64);

  const isReceipt = params.mode === 'receipt';
  const systemPrompt = isReceipt
    ? `You are a receipt OCR assistant. Extract the following fields from the receipt image and return ONLY valid JSON (no markdown fences, no extra text):

{
  "vendorName": "Store or business name",
  "date": "YYYY-MM-DD format date from the receipt (empty string if no date visible)",
  "totalAmount": 0.00,
  "categorySuggestion": "One of: Groceries, Dining, Utilities, Transport, Office Supplies, Accommodation, Healthcare, Entertainment, Other",
  "confidence": 0.95
}

Rules:
- Receipts may contain a mix of English and Sinhala text.
- If a vendor name is in Sinhala, transliterate it to Latin characters.
- If the date is NOT visible or ambiguous, leave date as an empty string ("").
- totalAmount must be a number (not a string).
- confidence should reflect how certain you are about the overall extraction (0.0 = unsure, 1.0 = completely certain).
- If you cannot read any text, set confidence to 0 and vendorName to "Unknown".
- categorySuggestion must be exactly one of the listed categories.`
    : `You are an OCR assistant for WhatHappen, a chat analysis application used in Sri Lanka.

Extract ALL visible text from this image and return ONLY the raw text content.

Rules:
- Images may contain a mix of English and Sinhala text. Extract ALL text you can read.
- Preserve the original language: do not translate Sinhala to English.
- If a word or phrase is in Sinhala, return it in the original Sinhala script (not transliterated).
- Do not add any commentary, explanations, markdown formatting, or JSON wrapping.
- Return ONLY the raw extracted text, exactly as it appears in the image.
- If you cannot read any text in the image, return an empty string.`;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: systemPrompt },
          {
            inlineData: {
              mimeType,
              data: cleanBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: isReceipt ? 1024 : 2048,
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Gemini OCR API Error: ${response.status} ${response.statusText}${
          errorText ? ` — ${errorText.slice(0, 500)}` : ''
        }`
      );
    }

    const data: any = await response.json();

    const textResponse =
      data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!textResponse) {
      const blockReason = data?.promptFeedback?.blockReason;
      if (blockReason) {
        throw new Error(`Gemini OCR: Content blocked — ${blockReason}`);
      }
      // Empty result — no text in the image
      if (isReceipt) {
        return {
          text: JSON.stringify({
            vendorName: 'Unknown',
            date: '',
            totalAmount: 0,
            categorySuggestion: 'Other',
            confidence: 0,
          }),
          confidence: 0,
        };
      }
      return { text: '', confidence: 0 };
    }

    const trimmed = textResponse.trim();

    if (isReceipt) {
      // Clean JSON response and validate
      const cleaned = cleanJsonResponse(trimmed);
      return { text: cleaned, confidence: 0.9 };
    }

    return { text: trimmed, confidence: 0.95 };
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new Error(`Gemini OCR: Request timed out after ${GEMINI_TIMEOUT_MS}ms.`);
    }
    if (err instanceof Error) {
      throw err;
    }
    throw new Error(`Gemini OCR: Unexpected error — ${String(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sniffMimeType(base64: string): string {
  const raw = atob(base64.slice(0, 30));
  const byte0 = raw.charCodeAt(0);
  const byte1 = raw.charCodeAt(1);

  if (byte0 === 0xff && byte1 === 0xd8) return 'image/jpeg';
  if (byte0 === 0x89 && byte1 === 0x50) return 'image/png';
  if (byte0 === 0x52 && raw.slice(0, 4) === 'RIFF') return 'image/webp';
  if (byte0 === 0x00 && byte1 === 0x00) return 'image/heic';

  return 'image/jpeg';
}

function cleanJsonResponse(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }
  return cleaned.trim();
}
