// Vercel Function entry point.
//
// This file exists solely so Vercel has something under /api to deploy as a
// Function - it does not define any routes itself. It imports the *existing*
// compiled Express app (server/dist, produced by `npm run build`) and hands
// every request straight to it, so every route continues to live in
// `server/src/api/**` exactly as before, including
// POST /api/cron/check-prices (CRON_SECRET-protected) and the Web Push
// routes. Nothing here duplicates or changes that logic.
//
// The container (Supabase client, notification providers, scheduler, etc.)
// is expensive to build - it does an async settings read from Supabase - so
// it is created once per warm function instance and reused across
// invocations, matching Vercel's Fluid compute model. If construction fails
// (e.g. missing SUPABASE_URL), the cached promise is cleared so the next
// invocation retries instead of failing forever on a stale error.
import { createContainer } from '../server/dist/app/container.js';
import { createApp } from '../server/dist/app/createApp.js';

let appPromise = null;

function getApp() {
  if (!appPromise) {
    appPromise = createContainer()
      .then((container) => createApp(container))
      .catch((err) => {
        appPromise = null;
        throw err;
      });
  }
  return appPromise;
}

export default async function handler(req, res) {
  const app = await getApp();
  app(req, res);
}
