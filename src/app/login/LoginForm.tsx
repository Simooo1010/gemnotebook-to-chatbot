"use client";

import { useState, type FormEvent } from "react";

export function LoginForm({ next = "/vault" }: { next?: string }) {
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch("/api/owner/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });
      if (res.ok) {
        // `next` was validated server-side as a same-origin path.
        window.location.assign(next);
        return;
      }
      setMessage(res.status === 429 ? "Too many attempts. Wait a while and try again." : "That did not work.");
    } catch {
      setMessage("Could not reach the server. Try again.");
    } finally {
      setPassphrase("");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="stack">
      <label htmlFor="passphrase">Passphrase</label>
      <input
        id="passphrase"
        name="passphrase"
        type="password"
        autoComplete="current-password"
        required
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
      />
      <button type="submit" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      <p role="status" aria-live="polite" className="msg">
        {message}
      </p>
    </form>
  );
}
