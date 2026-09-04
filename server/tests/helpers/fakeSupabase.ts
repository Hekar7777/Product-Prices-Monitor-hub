import type { SupabaseClient } from '@supabase/supabase-js';
import type { Db } from '../../src/db/index.js';

/**
 * Minimal in-memory stand-in for `@supabase/supabase-js`, used only by tests.
 *
 * It implements just enough of the PostgREST query-builder surface that the
 * repositories in `src/repositories/*` actually call (`.select/.insert/
 * .update/.delete/.upsert`, the filter methods, `.order/.limit/.range`,
 * `.single/.maybeSingle`, and `{ count: 'exact', head: true }`), plus the
 * `ON DELETE CASCADE` behaviour the real schema declares for `products`.
 *
 * This is intentionally not a general-purpose PostgREST emulator - it exists
 * to let the existing 189-test suite keep exercising real repository and
 * service code without a live Supabase project.
 */

type Row = Record<string, unknown>;

interface FilterCond {
  type: 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'or';
  col?: string;
  value?: unknown;
  orConditions?: Array<{ col: string; op: string; value: string }>;
}

interface OrderSpec {
  col: string;
  ascending: boolean;
  nullsFirst?: boolean;
}

type Mode = 'select' | 'insert' | 'update' | 'delete' | 'upsert';

/** Tables whose rows are removed when a referenced `products` row is deleted. */
const CASCADE_FROM_PRODUCTS = ['price_history', 'price_changes', 'notifications', 'check_logs'];

class FakeTable {
  rows: Row[] = [];
  nextId = 1;
}

class FakeSchema {
  private readonly tables = new Map<string, FakeTable>();

  table(name: string): FakeTable {
    let table = this.tables.get(name);
    if (!table) {
      table = new FakeTable();
      this.tables.set(name, table);
    }
    return table;
  }
}

function unescapeOrValue(value: string): string {
  return value.replace(/\\([,()])/g, '$1');
}

/** Splits an `.or()` filter string on commas that are not escaped with `\`. */
function splitOrConditions(spec: string): string[] {
  return spec.split(/(?<!\\),/);
}

function parseOrCondition(condition: string): { col: string; op: string; value: string } {
  const firstDot = condition.indexOf('.');
  const col = condition.slice(0, firstDot);
  const rest = condition.slice(firstDot + 1);
  const secondDot = rest.indexOf('.');
  const op = rest.slice(0, secondDot);
  const value = unescapeOrValue(rest.slice(secondDot + 1));
  return { col, op, value };
}

function compareValues(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function matchesFilter(row: Row, filter: FilterCond): boolean {
  switch (filter.type) {
    case 'eq':
      return row[filter.col!] === filter.value;
    case 'gt':
      return compareValues(row[filter.col!], filter.value) > 0;
    case 'gte':
      return compareValues(row[filter.col!], filter.value) >= 0;
    case 'lt':
      return compareValues(row[filter.col!], filter.value) < 0;
    case 'lte':
      return compareValues(row[filter.col!], filter.value) <= 0;
    case 'in':
      return (filter.value as unknown[]).includes(row[filter.col!]);
    case 'or':
      return filter.orConditions!.some(({ col, op, value }) => {
        const cell = row[col];
        if (op === 'is') return value === 'null' ? cell === null || cell === undefined : false;
        if (op === 'eq') return String(cell) === value;
        if (op === 'lte') return compareValues(cell, value) <= 0;
        if (op === 'gte') return compareValues(cell, value) >= 0;
        if (op === 'ilike') {
          const needle = value.replace(/^%/, '').replace(/%$/, '').toLowerCase();
          return typeof cell === 'string' && cell.toLowerCase().includes(needle);
        }
        return false;
      });
    default:
      return true;
  }
}

class FakeQueryBuilder<T = unknown> implements PromiseLike<{ data: T; error: null; count: number | null }> {
  private mode: Mode = 'select';
  private readonly filters: FilterCond[] = [];
  private readonly orders: OrderSpec[] = [];
  private wantSelect = true;
  private countExact = false;
  private headOnly = false;
  private singleMode: 'single' | 'maybe' | null = null;
  private limitN: number | null = null;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private insertRows: Row[] = [];
  private updateObj: Row = {};
  private upsertRows: Row[] = [];
  private onConflictCol: string | null = null;

  constructor(
    private readonly schema: FakeSchema,
    private readonly tableName: string,
  ) {}

  select(_columns?: string, opts?: { count?: 'exact'; head?: boolean }): this {
    if (this.mode === 'select') {
      if (opts?.count === 'exact') this.countExact = true;
      if (opts?.head) this.headOnly = true;
    } else {
      this.wantSelect = true;
    }
    return this;
  }

  insert(rows: Row | Row[]): this {
    this.mode = 'insert';
    this.insertRows = Array.isArray(rows) ? rows : [rows];
    this.wantSelect = false;
    return this;
  }

  update(obj: Row): this {
    this.mode = 'update';
    this.updateObj = obj;
    this.wantSelect = false;
    return this;
  }

  delete(): this {
    this.mode = 'delete';
    this.wantSelect = false;
    return this;
  }

  upsert(rows: Row | Row[], opts?: { onConflict?: string }): this {
    this.mode = 'upsert';
    this.upsertRows = Array.isArray(rows) ? rows : [rows];
    this.onConflictCol = opts?.onConflict ?? null;
    this.wantSelect = false;
    return this;
  }

  eq(col: string, value: unknown): this {
    this.filters.push({ type: 'eq', col, value });
    return this;
  }

  gt(col: string, value: unknown): this {
    this.filters.push({ type: 'gt', col, value });
    return this;
  }

  gte(col: string, value: unknown): this {
    this.filters.push({ type: 'gte', col, value });
    return this;
  }

  lt(col: string, value: unknown): this {
    this.filters.push({ type: 'lt', col, value });
    return this;
  }

  lte(col: string, value: unknown): this {
    this.filters.push({ type: 'lte', col, value });
    return this;
  }

  in(col: string, values: unknown[]): this {
    this.filters.push({ type: 'in', col, value: values });
    return this;
  }

  or(spec: string): this {
    const orConditions = splitOrConditions(spec).map(parseOrCondition);
    this.filters.push({ type: 'or', orConditions });
    return this;
  }

  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): this {
    this.orders.push({ col, ascending: opts?.ascending ?? true, nullsFirst: opts?.nullsFirst });
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  maybeSingle(): this {
    this.singleMode = 'maybe';
    return this;
  }

  single(): this {
    this.singleMode = 'single';
    return this;
  }

  private applyFiltersOrdersLimits(rows: Row[]): Row[] {
    let result = rows.filter((row) => this.filters.every((f) => matchesFilter(row, f)));

    for (const order of [...this.orders].reverse()) {
      result = [...result].sort((a, b) => {
        const av = a[order.col];
        const bv = b[order.col];
        const aNull = av === null || av === undefined;
        const bNull = bv === null || bv === undefined;
        if (aNull || bNull) {
          if (aNull && bNull) return 0;
          const nullsFirst = order.nullsFirst ?? !order.ascending;
          if (aNull) return nullsFirst ? -1 : 1;
          return nullsFirst ? 1 : -1;
        }
        const cmp = compareValues(av, bv);
        return order.ascending ? cmp : -cmp;
      });
    }

    if (this.rangeFrom !== null && this.rangeTo !== null) {
      result = result.slice(this.rangeFrom, this.rangeTo + 1);
    } else if (this.limitN !== null) {
      result = result.slice(0, this.limitN);
    }

    return result;
  }

  private execute(): { data: unknown; error: null; count: number | null } {
    const table = this.schema.table(this.tableName);

    if (this.mode === 'select') {
      const matching = table.rows.filter((row) => this.filters.every((f) => matchesFilter(row, f)));
      const count = this.countExact ? matching.length : null;

      if (this.headOnly) return { data: null, error: null, count };

      const result = this.applyFiltersOrdersLimits(table.rows);

      if (this.singleMode) {
        return { data: result[0] ?? null, error: null, count };
      }
      return { data: result, error: null, count };
    }

    if (this.mode === 'insert') {
      const inserted = this.insertRows.map((row) => {
        const withId = { id: table.nextId++, ...row };
        table.rows.push(withId);
        return withId;
      });
      if (!this.wantSelect) return { data: null, error: null, count: null };
      return {
        data: this.singleMode ? inserted[0] ?? null : inserted,
        error: null,
        count: null,
      };
    }

    if (this.mode === 'update') {
      const matching = table.rows.filter((row) => this.filters.every((f) => matchesFilter(row, f)));
      for (const row of matching) Object.assign(row, this.updateObj);
      if (!this.wantSelect) return { data: null, error: null, count: null };
      return {
        data: this.singleMode ? matching[0] ?? null : matching,
        error: null,
        count: null,
      };
    }

    if (this.mode === 'delete') {
      const matching = table.rows.filter((row) => this.filters.every((f) => matchesFilter(row, f)));
      const matchingIds = new Set(matching.map((row) => row.id));
      table.rows = table.rows.filter((row) => !matchingIds.has(row.id));

      if (this.tableName === 'products' && matchingIds.size > 0) {
        for (const depTable of CASCADE_FROM_PRODUCTS) {
          const dep = this.schema.table(depTable);
          dep.rows = dep.rows.filter((row) => !matchingIds.has(row.product_id));
        }
      }

      if (!this.wantSelect) return { data: null, error: null, count: null };
      return {
        data: this.singleMode ? matching[0] ?? null : matching,
        error: null,
        count: null,
      };
    }

    if (this.mode === 'upsert') {
      const conflictCol = this.onConflictCol ?? 'id';
      const upserted: Row[] = [];
      for (const row of this.upsertRows) {
        const existing = table.rows.find((r) => r[conflictCol] === row[conflictCol]);
        if (existing) {
          Object.assign(existing, row);
          upserted.push(existing);
        } else {
          const withId = conflictCol === 'id' ? { id: table.nextId++, ...row } : { ...row };
          table.rows.push(withId);
          upserted.push(withId);
        }
      }
      return { data: upserted, error: null, count: null };
    }

    return { data: null, error: null, count: null };
  }

  then<TResult1 = { data: T; error: null; count: number | null }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: T; error: null; count: number | null }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const result = this.execute() as { data: T; error: null; count: number | null };
    return Promise.resolve(result).then(onfulfilled, onrejected);
  }
}

class FakeSupabaseClient {
  private readonly schema = new FakeSchema();

  from(table: string): FakeQueryBuilder {
    return new FakeQueryBuilder(this.schema, table);
  }
}

class FakeDb implements Db {
  readonly client: SupabaseClient;

  constructor() {
    // The repositories only ever call `.from(...)`, which the fake client
    // implements; everything else about `SupabaseClient` is irrelevant to
    // them, so the cast is safe for test purposes.
    this.client = new FakeSupabaseClient() as unknown as SupabaseClient;
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

/** Creates a fresh in-memory fake database for one test file/harness. */
export function createFakeSupabaseDb(): Db {
  return new FakeDb();
}
