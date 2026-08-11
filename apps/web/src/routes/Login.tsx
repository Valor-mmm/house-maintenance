import { useState, type FormEvent } from "react";
import { useNavigate, Navigate } from "react-router-dom";
import { loginResponseSchema } from "@house/shared";
import { setToken, getToken } from "../auth/token";

// Owned by the "PWA shell, offline sync wiring, auth screens" feature
// slice. See the approved plan, Feature Scope #7.
export default function Login() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // If already logged in, there's nothing to do here. Declarative
  // redirect (not an imperative navigate() call during render — React
  // Router's own contract requires navigate() to run from an effect or
  // event handler, not the render body).
  if (getToken()) {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Login failed. Check your credentials and try again.");
        return;
      }

      const parsed = loginResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        setError("Unexpected response from server.");
        return;
      }

      setToken(parsed.data.token);
      navigate("/", { replace: true });
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-sm mx-auto px-4 pt-16 md:pt-24">
      <header className="mb-8 text-center">
        <div className="label-plate">House Maintenance</div>
        <h1 className="font-display italic text-3xl mt-1">Sign in</h1>
      </header>

      <div className="tick-rule mb-8" />

      <form onSubmit={handleSubmit} className="border border-border bg-surface p-6 flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="username" className="label-plate">
            Username
          </label>
          <input
            id="username"
            name="username"
            type="text"
            autoComplete="username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="bg-bg border border-border px-3 py-2 font-mono text-sm focus-visible:outline-2 focus-visible:outline-accent"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="password" className="label-plate">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="bg-bg border border-border px-3 py-2 font-mono text-sm focus-visible:outline-2 focus-visible:outline-accent"
          />
        </div>

        {error && (
          <div role="alert" className="text-sm text-danger border border-danger bg-bg px-3 py-2">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="mt-1 border border-accent-strong bg-accent text-surface font-mono text-sm tracking-wide py-2.5 hover:bg-accent-strong transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
