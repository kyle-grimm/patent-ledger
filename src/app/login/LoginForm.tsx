"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";

export default function LoginForm() {
  const params = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || `Sign-in failed (${res.status}).`);
      const next = params.get("next");
      // Only same-site paths, never an absolute URL from the query string.
      window.location.assign(next && next.startsWith("/") && !next.startsWith("//") ? next : "/tools/patent-ledger");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const field =
    "w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint transition-colors hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15";

  return (
    <form onSubmit={submit} className="grid gap-4 rounded-xl border border-line bg-surface p-6 shadow-[0_1px_2px_rgba(20,23,28,0.04)]">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-muted">Username</span>
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required className={field} />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-muted">Password</span>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required className={field} />
      </label>
      {error && <div className="rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}
      <button
        type="submit"
        disabled={busy}
        className="inline-flex h-10 items-center justify-center rounded-md bg-accent px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-accent-strong disabled:opacity-50"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
