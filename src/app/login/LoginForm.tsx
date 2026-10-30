"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export function LoginForm() {
  const router = useRouter();
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
        router.replace("/vault");
        router.refresh();
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
