import type { PostgrestError } from '@supabase/supabase-js';

/** Wraps a PostgREST error with the operation that triggered it. */
export class SupabaseQueryError extends Error {
  constructor(context: string, cause: PostgrestError) {
    super(`Supabase query failed (${context}): ${cause.message}`);
    this.name = 'SupabaseQueryError';
    this.cause = cause;
  }
}

/** Throws a `SupabaseQueryError` when `error` is set; otherwise a no-op. */
export function assertNoError(error: PostgrestError | null, context: string): void {
  if (error) throw new SupabaseQueryError(context, error);
}

/**
 * Escapes the three characters that are structurally significant in a
 * PostgREST `.or()` filter string (`,` separates conditions, `(` `)` group
 * them) so a user-typed search term cannot break the filter grammar.
 */
export function escapeOrFilterValue(value: string): string {
  return value.replace(/([,()])/g, '\\$1');
}
