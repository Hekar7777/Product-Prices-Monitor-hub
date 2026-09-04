import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

/**
 * Server-side Supabase client.
 *
 * Always constructed with the **service role** key, never the anon key -
 * this process is the only thing that talks to the database, and it must
 * bypass Row Level Security to read/write the shared product list. This key
 * must never reach the frontend; it is only read from the server's own
 * environment (`SUPABASE_SERVICE_ROLE_KEY`).
 */
export function createSupabaseClient(): SupabaseClient {
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set. ' +
        'Create a Supabase project, run server/supabase/migrations/*.sql against it, ' +
        'and put its URL and service_role key into your .env file.',
    );
  }

  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: {
      // This is a server process with a single privileged key, not a user
      // session - there is nothing to persist or refresh.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
