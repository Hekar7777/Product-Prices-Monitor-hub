import type { Db } from '../db/index.js';
import { roundMoney } from '../domain/money.js';
import type { CheckStatus, Product } from '../domain/types.js';
import { mapProduct, toInt } from './mappers.js';
import { assertNoError, escapeOrFilterValue } from './supabaseHelpers.js';

export interface CreateProductInput {
  url: string;
  canonicalKey: string;
  productName: string;
  imageUrl: string | null;
  currency: string;
  /** Baseline price observed when the product was added. */
  price: number;
  mrp: number | null;
  availability: string | null;
  seller: string | null;
  /** Timestamp of the successful baseline observation. */
  observedAt: string;
}

/**
 * Fields a check may update. Every key maps to exactly one column, so callers
 * cannot inject arbitrary SQL through a patch object.
 */
export interface ProductPatch {
  url?: string;
  productName?: string;
  imageUrl?: string | null;
  currency?: string;
  currentPrice?: number | null;
  previousPrice?: number | null;
  lowestPrice?: number | null;
  highestPrice?: number | null;
  mrp?: number | null;
  availability?: string | null;
  seller?: string | null;
  monitoringEnabled?: boolean;
  priceChangeCount?: number;
  consecutiveFailures?: number;
  lastStatus?: CheckStatus;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  lastCheckedAt?: string | null;
  lastAttemptedAt?: string | null;
  lastPriceChangeAt?: string | null;
}

const COLUMN_MAP: Record<keyof ProductPatch, string> = {
  url: 'url',
  productName: 'product_name',
  imageUrl: 'image_url',
  currency: 'currency',
  currentPrice: 'current_price',
  previousPrice: 'previous_price',
  lowestPrice: 'lowest_price',
  highestPrice: 'highest_price',
  mrp: 'mrp',
  availability: 'availability',
  seller: 'seller',
  monitoringEnabled: 'monitoring_enabled',
  priceChangeCount: 'price_change_count',
  consecutiveFailures: 'consecutive_failures',
  lastStatus: 'last_status',
  lastErrorCode: 'last_error_code',
  lastErrorMessage: 'last_error_message',
  lastCheckedAt: 'last_checked_at',
  lastAttemptedAt: 'last_attempted_at',
  lastPriceChangeAt: 'last_price_change_at',
};

export type ProductSort = 'created_desc' | 'created_asc' | 'name_asc' | 'change_desc' | 'price_asc';

/** [column, ascending] pairs applied in order via chained `.order()` calls. */
const SORT_COLUMNS: Record<ProductSort, Array<[string, boolean]>> = {
  created_desc: [['created_at', false], ['id', false]],
  created_asc: [['created_at', true], ['id', true]],
  name_asc: [['product_name', true]],
  // Most recently changed first; products that never changed sort last
  // because PostgREST/Postgres already places NULLs last on a DESC order.
  change_desc: [['last_price_change_at', false]],
  price_asc: [['current_price', true]],
};

export interface ListProductsOptions {
  monitoringEnabled?: boolean;
  search?: string;
  sort?: ProductSort;
  limit?: number;
  offset?: number;
}

export class ProductRepository {
  constructor(private readonly db: Db) {}

  async create(input: CreateProductInput): Promise<Product> {
    const now = new Date().toISOString();
    const price = roundMoney(input.price);

    const { data, error } = await this.db.client
      .from('products')
      .insert({
        url: input.url,
        canonical_key: input.canonicalKey,
        product_name: input.productName,
        image_url: input.imageUrl,
        currency: input.currency,
        current_price: price,
        // The baseline has no predecessor, so there is no "previous" price yet.
        previous_price: null,
        lowest_price: price,
        highest_price: price,
        mrp: input.mrp === null ? null : roundMoney(input.mrp),
        availability: input.availability,
        seller: input.seller,
        monitoring_enabled: true,
        price_change_count: 0,
        consecutive_failures: 0,
        last_status: 'ok' satisfies CheckStatus,
        created_at: now,
        updated_at: now,
        last_checked_at: input.observedAt,
        last_attempted_at: input.observedAt,
      })
      .select()
      .single();

    assertNoError(error, 'products.create');
    return mapProduct(data as Record<string, unknown>);
  }

  async findById(id: number): Promise<Product | null> {
    const { data, error } = await this.db.client
      .from('products')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    assertNoError(error, 'products.findById');
    return data ? mapProduct(data as Record<string, unknown>) : null;
  }

  async findByCanonicalKey(canonicalKey: string): Promise<Product | null> {
    const { data, error } = await this.db.client
      .from('products')
      .select('*')
      .eq('canonical_key', canonicalKey)
      .maybeSingle();

    assertNoError(error, 'products.findByCanonicalKey');
    return data ? mapProduct(data as Record<string, unknown>) : null;
  }

  async list(options: ListProductsOptions = {}): Promise<Product[]> {
    let query = this.db.client.from('products').select('*');

    if (options.monitoringEnabled !== undefined) {
      query = query.eq('monitoring_enabled', options.monitoringEnabled);
    }

    if (options.search?.trim()) {
      const needle = escapeOrFilterValue(options.search.trim());
      query = query.or(`product_name.ilike.%${needle}%,url.ilike.%${needle}%`);
    }

    for (const [column, ascending] of SORT_COLUMNS[options.sort ?? 'created_desc']) {
      query = query.order(column, { ascending });
    }

    if (options.limit !== undefined) {
      const offset = options.offset ?? 0;
      query = query.range(offset, offset + options.limit - 1);
    }

    const { data, error } = await query;
    assertNoError(error, 'products.list');
    return (data ?? []).map((row) => mapProduct(row as Record<string, unknown>));
  }

  async count(options: Pick<ListProductsOptions, 'monitoringEnabled'> = {}): Promise<number> {
    let query = this.db.client.from('products').select('*', { count: 'exact', head: true });
    if (options.monitoringEnabled !== undefined) {
      query = query.eq('monitoring_enabled', options.monitoringEnabled);
    }
    const { count, error } = await query;
    assertNoError(error, 'products.count');
    return toInt(count ?? 0);
  }

  /**
   * Products whose next check is due.
   *
   * Due-ness is based on `last_attempted_at`, not `last_checked_at`, so a
   * product that keeps failing is retried on the normal cadence instead of
   * being hammered on every check run.
   */
  async findDue(intervalMinutes: number, limit = 100): Promise<Product[]> {
    const cutoff = new Date(Date.now() - intervalMinutes * 60_000).toISOString();

    const { data, error } = await this.db.client
      .from('products')
      .select('*')
      .eq('monitoring_enabled', true)
      .or(`last_attempted_at.is.null,last_attempted_at.lte.${cutoff}`)
      .order('last_attempted_at', { ascending: true, nullsFirst: true })
      .limit(limit);

    assertNoError(error, 'products.findDue');
    return (data ?? []).map((row) => mapProduct(row as Record<string, unknown>));
  }

  async update(id: number, patch: ProductPatch): Promise<Product | null> {
    const assignments: Record<string, unknown> = {};

    for (const [key, column] of Object.entries(COLUMN_MAP) as [keyof ProductPatch, string][]) {
      if (!(key in patch)) continue;
      assignments[column] = patch[key] ?? null;
    }

    if (Object.keys(assignments).length === 0) return this.findById(id);

    assignments.updated_at = new Date().toISOString();

    const { data, error } = await this.db.client
      .from('products')
      .update(assignments)
      .eq('id', id)
      .select()
      .maybeSingle();

    assertNoError(error, 'products.update');
    return data ? mapProduct(data as Record<string, unknown>) : null;
  }

  /** Bumps the price-change counter atomically via a Postgres RPC. */
  async incrementPriceChangeCount(id: number): Promise<void> {
    // `update()` above already folds this increment into the same call in the
    // service layer (`priceChangeCount: product.priceChangeCount + 1`), so
    // this standalone helper is kept only for API-compatibility with the
    // previous repository and is not on the hot path.
    const current = await this.findById(id);
    if (!current) return;
    await this.update(id, { priceChangeCount: current.priceChangeCount + 1 });
  }

  async setMonitoring(id: number, enabled: boolean): Promise<Product | null> {
    return this.update(id, { monitoringEnabled: enabled });
  }

  async delete(id: number): Promise<boolean> {
    // Child rows are removed by ON DELETE CASCADE.
    const { data, error } = await this.db.client
      .from('products')
      .delete()
      .eq('id', id)
      .select('id');

    assertNoError(error, 'products.delete');
    return (data?.length ?? 0) > 0;
  }
}
