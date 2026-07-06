/**
 * Vercel Serverless Function — wraps the Express app for Vercel deployment.
 *
 * Uses @vercel/node builder to handle Express natively.
 */

import app from '../src/app';

export default app;
