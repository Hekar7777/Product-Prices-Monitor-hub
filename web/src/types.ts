/**
 * API response shapes.
 *
 * These mirror the DTOs produced by `server/src/api/serializers.ts`. Money
 * arithmetic and formatting are done server-side, so the UI renders values
 * rather than recomputing them.
 */

export type PriceDirection = 'up' | 'down';
export type CheckStatus = 'pending' | 'ok' | 'failed';
export type CheckOutcome = 'baseline' | 'unchanged' | 'changed';
export type CheckLogStatus = 'success' | 'failed' | 'skipped';
export type CheckTrigger = 'scheduler' | 'manual' | 'initial';
export type NotificationType = 'price_drop' | 'price_increase' | 'system';

export interface PriceChangeDto {
  id: number;
  productId: number;
  oldPrice: number;
  newPrice: number;
  absoluteChange: number;
  percentageChange: number;
  direction: PriceDirection;
  signedChange: number;
  currency: string;
  detectedAt: string;
  display: string;
}

export interface ProductDto {
  id: number;
  url: string;
  productName: string;
  imageUrl: string | null;
  currency: string;

  currentPrice: number | null;
  previousPrice: number | null;
  lowestPrice: number | null;
  highestPrice: number | null;
  mrp: number | null;

  availability: string | null;
  seller: string | null;

  monitoringEnabled: boolean;
  priceChangeCount: number;
  consecutiveFailures: number;

  lastStatus: CheckStatus;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;

  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  lastAttemptedAt: string | null;
  lastPriceChangeAt: string | null;

  currentPriceDisplay: string | null;
  latestChange: PriceChangeDto | null;
}

export interface ProductStatsDto {
  currentPrice: number | null;
  previousPrice: number | null;
  lowestPrice: number | null;
  highestPrice: number | null;
  averagePrice: number | null;
  totalPriceChanges: number;
  totalObservations: number;
  lastPriceChange: PriceChangeDto | null;
  lastCheckedAt: string | null;
  lastPriceChangeAt: string | null;
  firstTrackedAt: string;
}

export interface PriceHistoryPointDto {
  id: number;
  price: number;
  timestamp: string;
  currency: string;
  availability: string | null;
  seller: string | null;
  isBaseline: boolean;
  absoluteChange: number | null;
  percentageChange: number | null;
  direction: PriceDirection | null;
  signedChange: number | null;
  display: string;
}

export interface NotificationPayload {
  productId: number;
  productName: string;
  imageUrl: string | null;
  url: string;
  currency: string;
  oldPrice: number;
  newPrice: number;
  absoluteChange: number;
  percentageChange: number;
  direction: PriceDirection;
  detectedAt: string;
}

export interface NotificationDto {
  id: number;
  productId: number | null;
  priceChangeId: number | null;
  channel: string;
  type: NotificationType;
  title: string;
  message: string;
  payload: NotificationPayload | null;
  read: boolean;
  deliveryStatus: 'delivered' | 'failed';
  deliveryError: string | null;
  createdAt: string;
}

export interface CheckLogDto {
  id: number;
  productId: number | null;
  productName?: string | null;
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

export interface DashboardOverview {
  totalProducts: number;
  monitoredProducts: number;
  pausedProducts: number;
  changesLast24h: number;
  failedChecksLast24h: number;
  unreadNotifications: number;
  productsWithErrors: number;
  checksInProgress: number;
}

export interface TickSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  due: number;
  checked: number;
  baseline: number;
  unchanged: number;
  changed: number;
  failed: number;
  skipped: number;
  notifications: number;
}

export interface SchedulerStatus {
  /** Always true while the process is up - there is no timer to be "armed". */
  running: boolean;
  monitoringEnabled: boolean;
  intervalMinutes: number;
  maxConcurrentChecks: number;
  tickInProgress: boolean;
  activeChecks: number;
  activeProductIds: number[];
  lastTickStartedAt: string | null;
  lastTickFinishedAt: string | null;
  lastTick: TickSummary | null;
  totalTicks: number;
  totalChecks: number;
}

/** Operational settings. Note the deliberate absence of any target price. */
export interface AppSettings {
  monitorIntervalMinutes: number;
  monitoringEnabled: boolean;
  maxConcurrentChecks: number;
  requestTimeoutMs: number;
  fetchMaxRetries: number;
  notifyInApp: boolean;
  checkLogRetentionDays: number;
}

export interface LogRecord {
  time: string;
  level: string;
  msg: string;
  [key: string]: unknown;
}

// --- endpoint response envelopes ------------------------------------------

export interface ProductsResponse {
  products: ProductDto[];
  overview: DashboardOverview;
  checkingProductIds: number[];
}

export interface ProductDetailResponse {
  product: ProductDto;
  stats: ProductStatsDto;
  checking: boolean;
}

export interface HistoryResponse {
  range: HistoryRange;
  points: PriceHistoryPointDto[];
}

export interface NotificationsResponse {
  notifications: NotificationDto[];
  unreadCount: number;
  total: number;
  channels: string[];
}

export interface SettingsResponse {
  settings: AppSettings;
  updatedAt: string | null;
  scheduler: SchedulerStatus;
  notifications: { registeredChannels: string[]; enabledChannels: string[] };
  extraction: { strategy: string; fetcher: string; playwrightHeadless: boolean };
}

export interface CheckLogsResponse {
  logs: CheckLogDto[];
  counts: { success: number; failed: number; skipped: number };
}

export interface AppLogsResponse {
  level: string;
  logs: LogRecord[];
}

export interface ManualCheckResponse {
  outcome: CheckOutcome | 'failed' | 'skipped';
  skipReason?: string;
  product: ProductDto | null;
  change: PriceChangeDto | null;
  notifications: number;
  error: { code: string; message: string | null } | null;
}

export interface RunTickResponse {
  ran: boolean;
  reason: string | null;
  tick: TickSummary | null;
  scheduler: SchedulerStatus;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  database: string;
  scheduler: {
    running: boolean;
    monitoringEnabled: boolean;
    intervalMinutes: number;
    activeChecks: number;
  };
}

export const HISTORY_RANGES = ['24h', '7d', '30d', '3m', 'all'] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];

export const RANGE_LABELS: Record<HistoryRange, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  '3m': '3 months',
  all: 'All time',
};
