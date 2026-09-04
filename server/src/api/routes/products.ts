import { Router } from 'express';
import { z } from 'zod';
import type { AppContainer } from '../../app/container.js';
import { AppError } from '../../errors.js';
import { HISTORY_RANGES, type HistoryRange } from '../../services/productService.js';
import type { ProductSort } from '../../repositories/productRepository.js';
import {
  asyncHandler,
  enumQuery,
  intQuery,
  requireIdParam,
} from '../middleware.js';
import {
  serializeCheckLog,
  serializeHistoryPoint,
  serializePriceChange,
  serializeProduct,
  serializeProductRow,
  serializeStats,
} from '../serializers.js';

const addProductSchema = z.object({
  url: z.string().trim().min(1, 'A Flipkart product URL is required.'),
});

const patchProductSchema = z
  .object({
    monitoringEnabled: z.boolean(),
  })
  .strict();

const SORTS: readonly ProductSort[] = [
  'created_desc',
  'created_asc',
  'name_asc',
  'change_desc',
  'price_asc',
];

const STATUSES = ['all', 'monitoring', 'paused'] as const;

export function createProductsRouter(container: AppContainer): Router {
  const router = Router();

  // --- list -------------------------------------------------------------
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const status = enumQuery(req, 'status', STATUSES, 'all');
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;

      const rows = await container.products.list({
        sort: enumQuery(req, 'sort', SORTS, 'created_desc'),
        ...(status === 'all' ? {} : { monitoringEnabled: status === 'monitoring' }),
        ...(search ? { search } : {}),
      });

      res.json({
        products: rows.map(serializeProductRow),
        overview: await container.products.overview(container.monitor.runningCount()),
        checkingProductIds: container.monitor.runningProductIds(),
      });
    }),
  );

  // --- add --------------------------------------------------------------
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const parsed = addProductSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw AppError.badRequest(
          parsed.error.issues[0]?.message ?? 'A Flipkart product URL is required.',
        );
      }

      // The baseline price is captured here. It is explicitly not a price
      // change, so no notification is produced.
      const product = await container.products.addProduct(parsed.data.url);
      res.status(201).json({ product: serializeProduct(product) });
    }),
  );

  // --- detail -----------------------------------------------------------
  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = requireIdParam(req);
      const detail = await container.products.getDetail(id);

      res.json({
        product: serializeProduct(detail.product, detail.latestChange),
        stats: serializeStats(detail.stats),
        checking: container.monitor.isChecking(id),
      });
    }),
  );

  // --- pause / resume ---------------------------------------------------
  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = requireIdParam(req);
      const parsed = patchProductSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw AppError.badRequest('Expected a boolean "monitoringEnabled" field.');
      }

      const product = await container.products.setMonitoring(id, parsed.data.monitoringEnabled);
      res.json({ product: serializeProduct(product) });
    }),
  );

  // --- delete -----------------------------------------------------------
  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = requireIdParam(req);
      await container.products.remove(id);
      res.status(204).end();
    }),
  );

  // --- manual check -----------------------------------------------------
  router.post(
    '/:id/check',
    asyncHandler(async (req, res) => {
      const id = requireIdParam(req);
      // Confirm existence first so a missing product is a clean 404.
      await container.products.getById(id);

      const result = await container.monitor.checkProduct(id, { trigger: 'manual' });

      // A skipped check means one was already running - that is a conflict, not
      // a failure, and the caller should simply wait.
      const statusCode = result.kind === 'skipped' ? 409 : 200;

      res.status(statusCode).json({
        outcome: result.kind,
        ...(result.skipReason ? { skipReason: result.skipReason } : {}),
        product: result.product
          ? serializeProduct(result.product, result.change ?? null)
          : null,
        change: result.change ? serializePriceChange(result.change) : null,
        notifications: result.notifications.length,
        error:
          result.errorCode === null
            ? null
            : { code: result.errorCode, message: result.errorMessage },
      });
    }),
  );

  // --- price history ----------------------------------------------------
  router.get(
    '/:id/history',
    asyncHandler(async (req, res) => {
      const id = requireIdParam(req);
      const range = enumQuery<HistoryRange>(req, 'range', HISTORY_RANGES, 'all');
      const points = await container.products.getHistory(id, range);

      res.json({
        range,
        points: points.map(serializeHistoryPoint),
      });
    }),
  );

  // --- detected changes -------------------------------------------------
  router.get(
    '/:id/changes',
    asyncHandler(async (req, res) => {
      const id = requireIdParam(req);
      const limit = intQuery(req, 'limit', 100, 1, 500);
      const changes = await container.products.getChanges(id, limit);
      res.json({ changes: changes.map(serializePriceChange) });
    }),
  );

  // --- per-product check log --------------------------------------------
  router.get(
    '/:id/logs',
    asyncHandler(async (req, res) => {
      const id = requireIdParam(req);
      const product = await container.products.getById(id);
      const limit = intQuery(req, 'limit', 50, 1, 500);

      const logs = await container.repositories.checkLogs.list({ productId: id, limit });
      res.json({ logs: logs.map((entry) => serializeCheckLog(entry, product.productName)) });
    }),
  );

  return router;
}
