// Vercel's zero-config Node builder only turns files under `api/` into
// serverless functions — a top-level `server.js` is never routed to on its
// own. This file is the actual deployed entry point: it re-exports the same
// default handler `server.js` already builds for exactly this purpose (see
// the comment above that export). `vercel.json` rewrites every path to this
// one function, so the app's own router, host guard and login gate — not
// Vercel's routing — decide what each request gets.
export { default } from '../server.js';
