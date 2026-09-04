import { useState } from 'react';
import { ApiError, api } from '../lib/api';
import { errorMessage } from '../lib/format';
import { useToast } from './Toaster';

/**
 * Adds a product by URL.
 *
 * The only input the user ever provides is a Flipkart URL. There is no target
 * price or threshold field, because every price change is reported.
 */
export function AddProductForm({ onAdded }: { onAdded: () => void }) {
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const toast = useToast();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = url.trim();
    if (!trimmed || submitting) return;

    setSubmitting(true);
    setProblem(null);

    try {
      const { product } = await api.addProduct(trimmed);
      toast.success(
        `Now monitoring ${product.productName}\nBaseline price ${product.currentPriceDisplay ?? '—'}`,
      );
      setUrl('');
      onAdded();
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 409
          ? 'That product is already being monitored.'
          : errorMessage(err);
      setProblem(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="card p-4">
      <label htmlFor="product-url" className="label">
        Add a Flipkart product
      </label>
      <p className="hint">
        Paste the product URL. The first price becomes the baseline, and you are notified whenever
        it changes.
      </p>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          id="product-url"
          type="url"
          inputMode="url"
          className="input flex-1"
          placeholder="https://www.flipkart.com/…/p/itm…?pid=…"
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            setProblem(null);
          }}
          disabled={submitting}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? 'product-url-error' : undefined}
        />
        <button type="submit" className="btn btn-primary sm:w-40" disabled={submitting || !url.trim()}>
          {submitting ? 'Reading page…' : 'Start monitoring'}
        </button>
      </div>

      {problem && (
        <p id="product-url-error" role="alert" className="mt-2 text-sm text-up">
          {problem}
        </p>
      )}
    </form>
  );
}
