import type { Db } from '../db/index.js';
import { roundMoney } from '../domain/money.js';
import type {
  CheckLogEntry,
  CheckLogStatus,
  CheckOutcome,
  CheckTrigger,
} from '../domain/types.js';
import { mapCheckLog, toInt } from './mappers.js';
import { assertNoError } from './supabaseHelpers.js';

export interface CreateCheckLogInput {
  productId: number | null;
  status: CheckLogStatus;
  outcome: CheckOutcome | null;
  price: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  durationMs: number | null;
  strategy: string | null;
  triggerSource: CheckTrigger;
  startedAt: string;
  finishedAt: string;
}

export interface ListCheckLogsOptions {
  productId?: number;
  status?: CheckLogStatus;
  since?: string;
  limit?: number;
  offset?: number;
}

/**
 * Audit trail for every check attempt.
 *
 * Failures are recorded here so they are visible in the UI and in logs without
 * ever touching the product's stored price.
 */
export class CheckLogRepository {
  constructor(private readonly db: Db) {}

  async create(input: CreateCheckLogInput): Promise<CheckLogEntry> {
    const { data, error } = await this.db.client
      .from('check_logs')
      .insert({
        product_id: input.productId,
        status: input.status,
        outcome: input.outcome,
        price: input.price === null ? null : roundMoney(input.price),
        error_code: input.errorCode,
        error_message: input.errorMessage === null ? null : input.errorMessage.slice(0, 500),
        attempts: input.attempts,
        duration_ms: input.durationMs,
        strategy: input.strategy,
        trigger_source: input.triggerSource,
        started_at: input.startedAt,
        finished_at: input.finishedAt,
      })
      .select()
      .single();

    assertNoError(error, 'checkLogs.create');
    return mapCheckLog(data as Record<string, unknown>);
  }

  async findById(id: number): Promise<CheckLogEntry | null> {
    const { data, error } = await this.db.client
      .from('check_logs')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    assertNoError(error, 'checkLogs.findById');
    return data ? mapCheckLog(data as Record<string, unknown>) : null;
  }

  async list(options: ListCheckLogsOptions = {}): Promise<CheckLogEntry[]> {
    let query = this.db.client.from('check_logs').select('*');

    if (options.productId !== undefined) query = query.eq('product_id', options.productId);
    if (options.status) query = query.eq('status', options.status);
    if (options.since) query = query.gte('finished_at', options.since);

    query = query.order('finished_at', { ascending: false }).order('id', { ascending: false });

    if (options.limit !== undefined) {
      const offset = options.offset ?? 0;
      query = query.range(offset, offset + options.limit - 1);
    }

    const { data, error } = await query;
    assertNoError(error, 'checkLogs.list');
    return (data ?? []).map((row) => mapCheckLog(row as Record<string, unknown>));
  }

  async countByStatus(status: CheckLogStatus, since?: string): Promise<number> {
    let query = this.db.client
      .from('check_logs')
      .select('*', { count: 'exact', head: true })
      .eq('status', status);
    if (since) query = query.gte('finished_at', since);

    const { count, error } = await query;
    assertNoError(error, 'checkLogs.countByStatus');
    return toInt(count ?? 0);
  }

  /** Trims the audit trail so it cannot grow without bound. */
  async pruneOlderThan(cutoffIso: string): Promise<number> {
    const { data, error } = await this.db.client
      .from('check_logs')
      .delete()
      .lt('finished_at', cutoffIso)
      .select('id');

    assertNoError(error, 'checkLogs.pruneOlderThan');
    return data?.length ?? 0;
  }
}
