/**
 * Vercel Serverless Function — wraps Express for Vercel deployment.
 *
 * Vercel's @vercel/node builder supports Express natively.
 * The app must export a handler matching the Vercel (req, res) signature.
 */

import app from '../src/app';

export default app;
