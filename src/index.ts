/**
 * OCR Microservice — HTTP server entry point.
 *
 * Imports the Express app from app.ts and starts the server.
 * For Vercel serverless, this file also exports the app as the default
 * export so @vercel/node can use it as a serverless handler.
 */

import app from './app';

const PORT = parseInt(process.env.OCR_PORT || '3099', 10);

if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`OCR microservice running on http://localhost:${PORT}`);
    console.log(`Endpoints:`);
    console.log(`  POST /ocr       — Extract text from image`);
    console.log(`  POST /ocr/pdf   — Extract text from PDF`);
    console.log(`  GET  /health    — Health check`);
    console.log(`Gemini model: ${process.env.GEMINI_OCR_MODEL || 'gemini-3.5-flash'}`);
  });
}

export default app;
