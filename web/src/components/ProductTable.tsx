import { Link } from 'react-router-dom';
import type { ProductDto } from '../types';
import { formatMoney, timeAgo } from '../lib/format';
import { ChangeBadge, ProductThumb, StatusPill } from './indicators';

export interface ProductRowActions {
  onCheck: (product: ProductDto) => void;
  onToggleMonitoring: (product: ProductDto) => void;
  onDelete: (product: ProductDto) => void;
  busyIds: Set<number>;
  checkingIds: Set<number>;
}

/**
 * Dashboard table.
 *
 * PRODUCT | CURRENT | CHANGE | LOWEST | STATUS | LAST CHECK | actions
 */
export function ProductTable({
  products,
  actions,
}: {
  products: ProductDto[];
  actions: ProductRowActions;
}) {
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[54rem] border-collapse">
          <caption className="sr-only">
            Monitored Flipkart products with their current price, latest change, lowest recorded
            price, monitoring status and last successful check.
          </caption>
          <thead className="border-b border-border bg-surfaceAlt/50">
            <tr>
              <th scope="col" className="th">
                Product
              </th>
              <th scope="col" className="th text-right">
                Current
              </th>
              <th scope="col" className="th">
                Latest change
              </th>
              <th scope="col" className="th text-right">
                Lowest
              </th>
              <th scope="col" className="th">
                Status
              </th>
              <th scope="col" className="th">
                Last check
              </th>
              <th scope="col" className="th text-right">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {products.map((product) => {
              const busy = actions.busyIds.has(product.id);
              const checking = actions.checkingIds.has(product.id);

              return (
                <tr key={product.id} className="hover:bg-surfaceAlt/40">
                  <td className="td">
                    <div className="flex items-center gap-3">
                      <ProductThumb product={product} />
                      <div className="min-w-0">
                        <Link
                          to={`/products/${product.id}`}
                          className="block truncate font-medium text-ink hover:text-accent"
                          title={product.productName}
                        >
                          {product.productName}
                        </Link>
                        <div className="truncate text-xs text-muted">
                          {product.seller ? product.seller : 'Seller unknown'}
                          {product.availability && product.availability !== 'In Stock' && (
                            <span className="ml-2 text-up">{product.availability}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </td>

                  <td className="td text-right">
                    <div className="font-semibold tabular-nums">
                      {formatMoney(product.currentPrice, product.currency)}
                    </div>
                    {product.previousPrice !== null && (
                      <div className="text-xs text-muted tabular-nums">
                        was {formatMoney(product.previousPrice, product.currency)}
                      </div>
                    )}
                  </td>

                  <td className="td">
                    <ChangeBadge change={product.latestChange} size="sm" />
                    {product.lastPriceChangeAt && (
                      <div className="mt-1 text-xs text-muted">
                        {timeAgo(product.lastPriceChangeAt)}
                      </div>
                    )}
                  </td>

                  <td className="td text-right tabular-nums">
                    <div>{formatMoney(product.lowestPrice, product.currency)}</div>
                    <div className="text-xs text-muted">
                      high {formatMoney(product.highestPrice, product.currency)}
                    </div>
                  </td>

                  <td className="td">
                    <StatusPill product={product} checking={checking} />
                    {product.lastStatus === 'failed' && product.lastErrorCode && (
                      <div className="mt-1 max-w-[12rem] truncate text-xs text-muted" title={product.lastErrorMessage ?? ''}>
                        {product.lastErrorCode}
                      </div>
                    )}
                  </td>

                  <td className="td">
                    <div className="text-sm">{timeAgo(product.lastCheckedAt)}</div>
                    <div className="text-xs text-muted">
                      {product.priceChangeCount} change{product.priceChangeCount === 1 ? '' : 's'}
                    </div>
                  </td>

                  <td className="td">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => actions.onCheck(product)}
                        disabled={busy || checking}
                        title="Check this product's price now"
                      >
                        {busy || checking ? 'Checking…' : 'Check now'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => actions.onToggleMonitoring(product)}
                        disabled={busy}
                        title={product.monitoringEnabled ? 'Pause monitoring' : 'Resume monitoring'}
                      >
                        {product.monitoringEnabled ? 'Pause' : 'Resume'}
                      </button>
                      <a
                        className="btn btn-sm"
                        href={product.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        title="Open on Flipkart"
                      >
                        Open
                      </a>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => actions.onDelete(product)}
                        disabled={busy}
                        title="Stop monitoring and delete history"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
