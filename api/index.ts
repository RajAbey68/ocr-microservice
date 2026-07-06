/**
 * Vercel Serverless Function — wraps the Express app for Vercel deployment.
 *
 * Uses serverless-http to convert Express to a Vercel-compatible handler.
 */

import serverless from 'serverless-http';
import app from '../src/app';

export const handler = serverless(app);
