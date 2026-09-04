import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { HistoryRange, PriceHistoryPointDto } from '../types';
import { formatDateTime, formatMoney } from '../lib/format';

/**
 * Price movement over time.
 *
 * A step line is used deliberately: a listed price holds steady until it
 * changes, so interpolating between observations would imply prices that were
 * never actually listed.
 */
export function PriceChart({
  points,
  range,
  currency,
}: {
  points: PriceHistoryPointDto[];
  range: HistoryRange;
  currency: string;
}) {
  if (points.length === 0) {
    return (
      <div className="flex h-72 items-center justify-center text-sm text-muted">
        No price observations in this range yet.
      </div>
    );
  }

  const data = points.map((point) => ({
    t: new Date(point.timestamp).getTime(),
    price: point.price,
    direction: point.direction,
  }));

  // Extend the series to "now" so a flat current price is visible as a line
  // rather than a single dot at the last change.
  const last = data[data.length - 1];
  if (last && Date.now() - last.t > 60_000) {
    data.push({ t: Date.now(), price: last.price, direction: null });
  }

  const prices = data.map((d) => d.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  // A visible band even when the price never moved.
  const pad = Math.max((max - min) * 0.12, Math.max(max * 0.01, 1));

  const showTimeOnly = range === '24h';

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
          <CartesianGrid stroke="#243044" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tick={{ fill: '#8b9ab3', fontSize: 12 }}
            stroke="#243044"
            tickFormatter={(value: number) =>
              showTimeOnly
                ? new Date(value).toLocaleTimeString('en-IN', {
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: true,
                  })
                : new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
            }
            minTickGap={32}
          />
          <YAxis
            domain={[Math.max(0, min - pad), max + pad]}
            tick={{ fill: '#8b9ab3', fontSize: 12 }}
            stroke="#243044"
            width={78}
            tickFormatter={(value: number) => formatMoney(value, currency)}
          />
          <Tooltip
            contentStyle={{
              background: '#121826',
              border: '1px solid #243044',
              borderRadius: 8,
              color: '#e8edf6',
              fontSize: 13,
            }}
            labelFormatter={(value) => formatDateTime(new Date(Number(value)).toISOString())}
            formatter={(value) => [formatMoney(Number(value), currency), 'Price']}
          />
          <Line
            type="stepAfter"
            dataKey="price"
            stroke="#4c8dff"
            strokeWidth={2}
            dot={{ r: 3, fill: '#4c8dff', strokeWidth: 0 }}
            activeDot={{ r: 5 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
