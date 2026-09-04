import { NavLink, Route, Routes } from 'react-router-dom';
import { ToastProvider } from './components/Toaster';
import { usePoll } from './hooks/usePoll';
import { api } from './lib/api';
import { DashboardPage } from './pages/DashboardPage';
import { LogsPage } from './pages/LogsPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { ProductDetailPage } from './pages/ProductDetailPage';
import { SettingsPage } from './pages/SettingsPage';

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/notifications', label: 'Notifications', badge: true },
  { to: '/logs', label: 'Logs' },
  { to: '/settings', label: 'Settings' },
] as const;

function Nav() {
  // The unread badge polls independently so it stays current on every page.
  const { data } = usePoll(() => api.listNotifications({ unreadOnly: true, limit: 1 }), 20_000, 'unread');
  const unread = data?.unreadCount ?? 0;

  return (
    <nav aria-label="Main" className="flex flex-wrap items-center gap-1">
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={'end' in item ? item.end : false}
          className={({ isActive }) =>
            `rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              isActive ? 'bg-surfaceAlt text-ink' : 'text-muted hover:bg-surfaceAlt/60 hover:text-ink'
            }`
          }
        >
          {item.label}
          {'badge' in item && item.badge && unread > 0 && (
            <span className="ml-2 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-white">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

function HealthDot() {
  // The dedicated /api/health endpoint is used here rather than /api/settings:
  // it is cheaper (no scheduler/settings assembly) and its failure mode is
  // unambiguous, so "Server unreachable" only fires when the API genuinely
  // cannot be reached, not when some other endpoint has a problem.
  const { data, error } = usePoll(() => api.getHealth(), 15_000, 'health');
  const scheduler = data?.scheduler;

  const state =
    error
      ? { colour: 'bg-up', label: 'Server unreachable' }
      : !scheduler
        ? { colour: 'bg-muted', label: 'Connecting' }
        : !scheduler.monitoringEnabled
          ? { colour: 'bg-yellow-400', label: 'Monitoring disabled' }
          : scheduler.running
            ? { colour: 'bg-down', label: `Monitoring every ${scheduler.intervalMinutes} min` }
            : { colour: 'bg-yellow-400', label: 'Scheduler stopped' };

  return (
    <span className="flex items-center gap-2 text-xs text-muted" title={state.label}>
      <span className={`h-2 w-2 rounded-full ${state.colour}`} aria-hidden="true" />
      <span className="hidden sm:inline">{state.label}</span>
    </span>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <div className="min-h-screen">
        <header className="sticky top-0 z-40 border-b border-border bg-canvas/95 backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-3 sm:px-6">
            <div className="flex items-center gap-2">
              <span
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-sm font-bold text-white"
                aria-hidden="true"
              >
                ₹
              </span>
              <div className="leading-tight">
                <div className="text-sm font-semibold">Flipkart Price Monitor</div>
                <div className="text-[11px] text-muted">Alerts on every price change</div>
              </div>
            </div>

            <div className="ml-auto flex items-center gap-4">
              <HealthDot />
              <Nav />
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/products/:id" element={<ProductDetailPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route
              path="*"
              element={
                <div className="card p-10 text-center">
                  <h1 className="text-lg font-semibold">Page not found</h1>
                  <NavLink to="/" className="btn mt-4 inline-flex">
                    Back to dashboard
                  </NavLink>
                </div>
              }
            />
          </Routes>
        </main>

        <footer className="mx-auto max-w-7xl px-4 pb-8 text-xs text-muted sm:px-6">
          Reads only public Flipkart product pages. No Flipkart account is used, and no
          anti-bot protection is bypassed - if a page cannot be read, the check is recorded as failed
          and the last valid price is kept.
        </footer>
      </div>
    </ToastProvider>
  );
}
