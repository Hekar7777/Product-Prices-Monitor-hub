import type { Db } from '../db/index.js';
import { roundMoney } from '../domain/money.js';
import type { PriceChange, PriceDirection } from '../domain/types.js';
import { mapPriceChange, toInt } from './mappers.js';
import { assertNoError } from './supabaseHelpers.js';

export interface CreatePriceChangeInput {
  productId: number;
  priceHistoryId: number | null;
  oldPrice: number;
  newPrice: number;
  /** Magnitude of the change; the sign lives in `direction`. */
  absoluteChange: number;
  percentageChange: number;
  direction: PriceDirection;
  currency: string;
  detectedAt: string;
}

export interface ListPriceChangesOptions {
  productId?: number;
  since?: string;
  direction?: PriceDirection;
  limit?: number;
  offset?: number;
}

export class PriceChangeRepository {
  constructor(private readonly db: Db) {}

  async create(input: CreatePriceChangeInput): Promise<PriceChange> {
    const { data, error } = await this.db.client
      .from('price_changes')
      .insert({
        product_id: input.productId,
        price_history_id: input.priceHistoryId,
        old_price: roundMoney(input.oldPrice),
        new_price: roundMoney(input.newPrice),
        absolute_change: roundMoney(input.absoluteChange),
        percentage_change: input.percentageChange,
        direction: input.direction,
        currency: input.currency,
        detected_at: input.detectedAt,
      })
      .select()
      .single();

    assertNoError(error, 'priceChanges.create');
    return mapPriceChange(data as Record<string, unknown>);
  }

  async findById(id: number): Promise<PriceChange | null> {
    const { data, error } = await this.db.client
      .from('price_changes')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    assertNoError(error, 'priceChanges.findById');
    return data ? mapPriceChange(data as Record<string, unknown>) : null;
  }

  async list(options: ListPriceChangesOptions = {}): Promise<PriceChange[]> {
    let query = this.db.client.from('price_changes').select('*');

    if (options.productId !== undefined) query = query.eq('product_id', options.productId);
    if (options.since) query = query.gte('detected_at', options.since);
    if (options.direction) query = query.eq('direction', options.direction);

    query = query.order('detected_at', { ascending: false }).order('id', { ascending: false });

    if (options.limit !== undefined) {
      const offset = options.offset ?? 0;
      query = query.range(offset, offset + options.limit - 1);
    }

    const { data, error } = await query;
    assertNoError(error, 'priceChanges.list');
    return (data ?? []).map((row) => mapPriceChange(row as Record<string, unknown>));
  }

  async latestByProduct(productId: number): Promise<PriceChange | null> {
    const { data, error } = await this.db.client
      .from('price_changes')
      .select('*')
      .eq('product_id', productId)
      .order('detected_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();

    assertNoError(error, 'priceChanges.latestByProduct');
    return data ? mapPriceChange(data as Record<string, unknown>) : null;
  }

  async countByProduct(productId: number): Promise<number> {
    const { count, error } = await this.db.client
      .from('price_changes')
      .select('*', { count: 'exact', head: true })
      .eq('product_id', productId);

    assertNoError(error, 'priceChanges.countByProduct');
    return toInt(count ?? 0);
  }

  async countSince(since: string): Promise<number> {
    const { count, error } = await this.db.client
      .from('price_changes')
      .select('*', { count: 'exact', head: true })
      .gte('detected_at', since);

    assertNoError(error, 'priceChanges.countSince');
    return toInt(count ?? 0);
  }

  /** Latest change per product, keyed by product id - used by the dashboard. */
  async latestForProducts(productIds: number[]): Promise<Map<number, PriceChange>> {
    const map = new Map<number, PriceChange>();
    if (productIds.length === 0) return map;

    // PostgREST cannot express "top 1 per group" in a single filtered select,
    // so every change for the requested products is fetched (newest first)
    // and the first row seen per product is kept. Price-change volume per
    // product is small, so this stays cheap for a single shared list.
    const { data, error } = await this.db.client
      .from('price_changes')
      .select('*')
      .in('product_id', productIds)
      .order('detected_at', { ascending: false })
      .order('id', { ascending: false });

    assertNoError(error, 'priceChanges.latestForProducts');

    for (const row of data ?? []) {
      const change = mapPriceChange(row as Record<string, unknown>);
      if (!map.has(change.productId)) map.set(change.productId, change);
    }

    return map;
  }
}
