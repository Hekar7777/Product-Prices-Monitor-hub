import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../logger.js';
import { createSupabaseClient } from './supabase.js';

/**
 * Thin handle around the Supabase client.
 *
 * `transaction()` exists so the service layer's call sites
 * (`this.deps.db.transaction(async () => { ... })`) did not need to change
 * shape when the storage engine changed. There is an important behavioural
 * difference from the previous SQLite implementation, though:
 *
 *   PostgREST (what @supabase/supabase-js talks to) has no concept of a
 *   client-driven multi-statement transaction. Each `.from(table)...` call is
 *   its own request and commits independently. `transaction()` here is a
 *   plain `await fn()` - it does NOT provide atomicity or rollback across the
 *   several inserts/updates a single price check performs.
 *
 *   In practice this is an acceptable trade-off for a single shared product
 *   list with no concurrent multi-writer contention: a mid-sequence failure
 *   (e.g. the network drops between writing `price_history` and updating
 *   `products`) can leave a partially-applied check, whereas SQLite's local
 *   transaction guaranteed all-or-nothing. If that ever matters, the fix is a
 *   Postgres function (`create function ... language plpgsql`) called via
 *   `.rpc()`, invoked from here - nothing above this file would need to
 *   change again.
 */
export interface Db {
  readonly client: SupabaseClient;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

class SupabaseDb implements Db {
  constructor(readonly client: SupabaseClient) {}

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

/**
 * Creates the database handle. Throws immediately if `SUPABASE_URL` /
 * `SUPABASE_SERVICE_ROLE_KEY` are not configured, so a misconfigured
 * deployment fails at boot rather than on the first request.
 */
export function createDatabase(): Db {
  const client = createSupabaseClient();

  logger.info('Database ready', {
    component: 'db',
    driver: 'supabase-postgres',
  });

  return new SupabaseDb(client);
}
