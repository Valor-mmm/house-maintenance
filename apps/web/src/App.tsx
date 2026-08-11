import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation, useNavigate } from "react-router-dom";
import { Analytics } from "@vercel/analytics/react";
import Dashboard from "./routes/Dashboard";
import Meters from "./routes/Meters";
import MeterDetail from "./routes/MeterDetail";
import Tasks from "./routes/Tasks";
import Backups from "./routes/Backups";
import Login from "./routes/Login";
import { startSyncManager } from "./sync/engine";
import { hasSession, logout } from "./auth/token";
import { getStoredTheme, applyTheme, nextTheme, type ThemeChoice } from "./theme";

const navItems = [
  { to: "/", label: "Dashboard" },
  { to: "/meters", label: "Meters" },
  { to: "/tasks", label: "Tasks" },
  { to: "/backups", label: "Backups" },
];

const INSTALL_DISMISSED_KEY = "house-maintenance:install-dismissed";

// Not a standard DOM lib type yet — minimal shape we actually use.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

// Minimal guard for now; the PWA-shell/auth feature slice owns the real
// login flow and can replace this with a proper auth context.
function RequireAuth({ children }: { children: React.ReactNode }) {
  return hasSession() ? <>{children}</> : <Navigate to="/login" replace />;
}

/** Small, unobtrusive "you're offline" badge — offline is expected/normal
 * in a local-first app, so this reads as informational, not alarming. */
function OfflineBadge() {
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  if (online) return null;

  return (
    <span className="label-plate flex items-center gap-1.5 text-muted">
      <span className="w-1.5 h-1.5 rounded-full bg-muted" aria-hidden="true" />
      Offline — changes saved locally
    </span>
  );
}

/** Cycles system -> light -> dark -> system. Persists via src/theme.ts,
 * which index.html's inline script also reads on next load to avoid a
 * flash of the wrong theme. */
function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeChoice>(() => getStoredTheme());

  return (
    <button
      type="button"
      onClick={() => {
        const next = nextTheme(theme);
        applyTheme(next);
        setTheme(next);
      }}
      className="label-plate hover:text-accent transition-colors"
    >
      Theme: {theme}
    </button>
  );
}

/** Tiny logout affordance; only shown once a session exists. Re-checks
 * on every navigation (via useLocation) so it appears/disappears promptly
 * around the login/logout redirects. */
function LogoutControl() {
  const navigate = useNavigate();
  useLocation(); // force re-render on route change so hasSession() is re-read
  const [signedIn, setSignedIn] = useState(hasSession());

  useEffect(() => {
    setSignedIn(hasSession());
  });

  if (!signedIn) return null;

  return (
    <button
      type="button"
      onClick={async () => {
        await logout();
        navigate("/login", { replace: true });
      }}
      className="label-plate hover:text-accent transition-colors"
    >
      Log out
    </button>
  );
}

/** Dismissible "install this app" banner, driven by the browser's
 * `beforeinstallprompt` event. Does not touch notification/push permissions
 * — that's a different feature slice. */
function InstallBanner() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(INSTALL_DISMISSED_KEY) === "1");

  useEffect(() => {
    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setDeferredPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  function dismiss() {
    localStorage.setItem(INSTALL_DISMISSED_KEY, "1");
    setDismissed(true);
  }

  if (!deferredPrompt || dismissed) return null;

  return (
    <div className="border-b border-border bg-surface px-4 py-3 flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <div className="label-plate">Install</div>
        <p className="text-sm mt-0.5">Add House Maintenance to your home screen for quick, offline access.</p>
      </div>
      <button
        type="button"
        onClick={async () => {
          await deferredPrompt.prompt();
          await deferredPrompt.userChoice;
          setDeferredPrompt(null);
        }}
        className="border border-accent-strong bg-accent text-surface font-mono text-xs tracking-wide px-3 py-2 hover:bg-accent-strong transition-colors shrink-0"
      >
        Install
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss install prompt"
        className="label-plate text-muted hover:text-ink transition-colors shrink-0"
      >
        Dismiss
      </button>
    </div>
  );
}

export default function App() {
  useEffect(() => {
    const stop = startSyncManager();
    return stop;
  }, []);

  return (
    <BrowserRouter>
      <Analytics />
      <div className="min-h-screen flex flex-col bg-bg text-ink">
        {/* Slim status strip — always shows the theme toggle; the rest
            (offline badge, logout) collapses away with nothing to report,
            e.g. on the login screen. */}
        <div className="flex items-center justify-end gap-4 px-4 py-1.5 border-b border-border">
          <OfflineBadge />
          <ThemeToggle />
          <LogoutControl />
        </div>
        <InstallBanner />
        <main className="flex-1 pb-20 md:pb-0">
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route
              path="/"
              element={
                <RequireAuth>
                  <Dashboard />
                </RequireAuth>
              }
            />
            <Route
              path="/meters"
              element={
                <RequireAuth>
                  <Meters />
                </RequireAuth>
              }
            />
            <Route
              path="/meters/:id"
              element={
                <RequireAuth>
                  <MeterDetail />
                </RequireAuth>
              }
            />
            <Route
              path="/tasks"
              element={
                <RequireAuth>
                  <Tasks />
                </RequireAuth>
              }
            />
            <Route
              path="/backups"
              element={
                <RequireAuth>
                  <Backups />
                </RequireAuth>
              }
            />
          </Routes>
        </main>
        {/* Mobile control strip — tick marks between items reinforce the instrument-panel motif. */}
        <nav className="fixed bottom-0 inset-x-0 flex border-t border-border bg-surface md:hidden">
          {navItems.map((item, i) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                `flex-1 py-3 text-center label-plate transition-colors ${
                  i > 0 ? "border-l border-border" : ""
                } ${isActive ? "text-accent" : "text-muted"}`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </BrowserRouter>
  );
}
