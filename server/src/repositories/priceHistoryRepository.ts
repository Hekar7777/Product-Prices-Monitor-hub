import type { Db } from '../db/index.js';
import { roundMoney } from '../domain/money.js';
import type { PriceHistoryEntry } from '../domain/types.js';
import { mapPriceHistory, toInt, toMoney } from './mappers.js';
import { assertNoError } from './supabaseHelpers.js';

export interface CreatePriceHistoryInput {
  productId: number;
  price: number;
  currency: string;
  mrp: number | null;
  availability: string | null;
  seller: string | null;
  sourceUrl: string;
  /** True only for the very first observation of a product. */
  isBaseline: boolean;
  timestamp: string;
}

export interface HistoryRangeOptions {
  /** Inclusive lower bound as an ISO timestamp. */
  since?: string;
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

export interface HistoryAggregate {
  lowest: number | null;
  highest: number | null;
  average: number | null;
  observations: number;
}

/**
 * Price history holds *meaningful* observations only: the initial baseline plus
 * every subsequent change. Repeated identical prices are deliberately not
 * inserted, so the table stays a record of price movement rather than a log of
 * every check.
 */
export class PriceHistoryRepository {
  constructor(private readonly db: Db) {}

  async create(input: CreatePriceHistoryInput): Promise<PriceHistoryEntry> {
    const { data, error } = await this.db.client
      .from('price_history')
      .insert({
        product_id: input.productId,
        price: roundMoney(input.price),
        currency: input.currency,
        mrp: input.mrp === null ? null : roundMoney(input.mrp),
        availability: input.availability,
        seller: input.seller,
        source_url: input.sourceUrl,
        is_baseline: input.isBaseline,
        timestamp: input.timestamp,
      })
      .select()
      .single();

    assertNoError(error, 'priceHistory.create');
    return mapPriceHistory(data as Record<string, unknown>);
  }

  async findById(id: number): Promise<PriceHistoryEntry | null> {
    const { data, error } = await this.db.client
      .from('price_history')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    assertNoError(error, 'priceHistory.findById');
    return data ? mapPriceHistory(data as Record<string, unknown>) : null;
  }

  async listByProduct(
    productId: number,
    options: HistoryRangeOptions = {},
  ): Promise<PriceHistoryEntry[]> {
    let query = this.db.client.from('price_history').select('*').eq('product_id', productId);

    if (options.since) {
      query = query.gte('timestamp', options.since);
    }

    const ascending = options.order === 'asc';
    query = query.order('timestamp', { ascending }).order('id', { ascending });

    if (options.limit !== undefined) {
      const offset = options.offset ?? 0;
      query = query.range(offset, offset + options.limit - 1);
    }

    const { data, error } = await query;
    assertNoError(error, 'priceHistory.listByProduct');
    return (data ?? []).map((row) => mapPriceHistory(row as Record<string, unknown>));
  }

  /** Most recent observation, used to seed comparisons after a restart. */
  async latestByProduct(productId: number): Promise<PriceHistoryEntry | null> {
    const { data, error } = await this.db.client
      .from('price_history')
      .select('*')
      .eq('product_id', productId)
      .order('timestamp', { ascending: false })
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();

    assertNoError(error, 'priceHistory.latestByProduct');
    return data ? mapPriceHistory(data as Record<string, unknown>) : null;
  }

  async aggregate(productId: number, since?: string): Promise<HistoryAggregate> {
    // PostgREST has no server-side MIN/MAX/AVG aggregate over a REST filter,
    // so the aggregate is computed here from the same rows the history views
    // already page through. Price-history tables are small (one row per
    // meaningful change, not per check), so this is not a scale concern for a
    // single shared list.
    let query = this.db.client
      .from('price_history')
      .select('price')
      .eq('product_id', productId);

    if (since) query = query.gte('timestamp', since);

    const { data, error } = await query;
    assertNoError(error, 'priceHistory.aggregate');

    const prices = (data ?? [])
      .map((row) => toMoney((row as { price: unknown }).price))
      .filter((price): price is number => price !== null);

    if (prices.length === 0) {
      return { lowest: null, highest: null, average: null, observations: 0 };
    }

    const sum = prices.reduce((total, price) => total + price, 0);
    return {
      lowest: Math.min(...prices),
      highest: Math.max(...prices),
      average: roundMoney(sum / prices.length),
      observations: prices.length,
    };
  }

  async countByProduct(productId: number): Promise<number> {
    const { count, error } = await this.db.client
      .from('price_history')
      .select('*', { count: 'exact', head: true })
      .eq('product_id', productId);

    assertNoError(error, 'priceHistory.countByProduct');
    return toInt(count ?? 0);
  }
}
