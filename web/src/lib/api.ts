import type {
  AppLogsResponse,
  AppSettings,
  CheckLogsResponse,
  HealthResponse,
  HistoryRange,
  HistoryResponse,
  ManualCheckResponse,
  NotificationsResponse,
  ProductDetailResponse,
  ProductDto,
  ProductsResponse,
  RunTickResponse,
  SettingsResponse,
} from '../types';

const BASE = '/api';

/** An error carrying the backend's error code so the UI can react to it. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${BASE}${path}`, {
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
      ...init,
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the monitoring server.');
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const err = (body as ErrorBody | null)?.error;
    throw new ApiError(
      response.status,
      err?.code ?? 'UNKNOWN',
      err?.message ?? `Request failed with status ${response.status}.`,
      err?.details,
    );
  }

  return body as T;
}

export const api = {
  // --- system -------------------------------------------------------------
  getHealth() {
    return request<HealthResponse>('/health');
  },

  // --- products ---------------------------------------------------------
  listProducts(params: { search?: string; sort?: string; status?: string } = {}) {
    const query = new URLSearchParams();
    if (params.search) query.set('search', params.search);
    if (params.sort) query.set('sort', params.sort);
    if (params.status && params.status !== 'all') query.set('status', params.status);
    const suffix = query.toString() ? `?${query}` : '';
    return request<ProductsResponse>(`/products${suffix}`);
  },

  addProduct(url: string) {
    return request<{ product: ProductDto }>('/products', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
  },

  getProduct(id: number) {
    return request<ProductDetailResponse>(`/products/${id}`);
  },

  setMonitoring(id: number, monitoringEnabled: boolean) {
    return request<{ product: ProductDto }>(`/products/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ monitoringEnabled }),
    });
  },

  deleteProduct(id: number) {
    return request<void>(`/products/${id}`, { method: 'DELETE' });
  },

  /**
   * Triggers a check now. Resolves normally for a 409 "already running" so the
   * caller can show a gentle message instead of an error.
   */
  async checkProduct(id: number): Promise<ManualCheckResponse> {
    try {
      return await request<ManualCheckResponse>(`/products/${id}/check`, { method: 'POST' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        return {
          outcome: 'skipped',
          skipReason: 'already_running',
          product: null,
          change: null,
          notifications: 0,
          error: null,
        };
      }
      throw err;
    }
  },

  getHistory(id: number, range: HistoryRange) {
    return request<HistoryResponse>(`/products/${id}/history?range=${range}`);
  },

  getProductLogs(id: number, limit = 25) {
    return request<CheckLogsResponse>(`/products/${id}/logs?limit=${limit}`);
  },

  // --- notifications ----------------------------------------------------
  listNotifications(params: { unreadOnly?: boolean; limit?: number } = {}) {
    const query = new URLSearchParams();
    if (params.unreadOnly) query.set('unread', 'true');
    query.set('limit', String(params.limit ?? 50));
    return request<NotificationsResponse>(`/notifications?${query}`);
  },

  markNotificationRead(id: number) {
    return request<unknown>(`/notifications/${id}/read`, { method: 'POST' });
  },

  markAllNotificationsRead() {
    return request<{ updated: number; unreadCount: number }>('/notifications/read-all', {
      method: 'POST',
    });
  },

  deleteNotification(id: number) {
    return request<void>(`/notifications/${id}`, { method: 'DELETE' });
  },

  clearNotifications() {
    return request<{ removed: number }>('/notifications', { method: 'DELETE' });
  },

  // --- settings & system ------------------------------------------------
  getSettings() {
    return request<SettingsResponse>('/settings');
  },

  updateSettings(patch: Partial<AppSettings>) {
    return request<SettingsResponse>('/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },

  runSchedulerNow() {
    return request<RunTickResponse>('/scheduler/run', { method: 'POST' });
  },

  getCheckLogs(params: { status?: string; limit?: number } = {}) {
    const query = new URLSearchParams();
    if (params.status && params.status !== 'all') query.set('status', params.status);
    query.set('limit', String(params.limit ?? 100));
    return request<CheckLogsResponse>(`/logs/checks?${query}`);
  },

  getAppLogs(limit = 200) {
    return request<AppLogsResponse>(`/logs/app?limit=${limit}`);
  },

  // --- web push -----------------------------------------------------------
  getVapidPublicKey() {
    return request<{ publicKey: string }>('/push-subscriptions/vapid-public-key');
  },

  savePushSubscription(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) {
    return request<{ ok: true }>('/push-subscriptions', {
      method: 'POST',
      body: JSON.stringify(subscription),
    });
  },

  deletePushSubscription(endpoint: string) {
    return request<void>('/push-subscriptions', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint }),
    });
  },
};
