"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

interface ApiError {
  error?: { message?: string; missing?: string[] };
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiError;
    const base = body.error?.message ?? "Something went wrong.";
    const missing = body.error?.missing;
    return missing?.length ? `${base} Missing: ${missing.join(", ")}.` : base;
  } catch {
    return "Something went wrong.";
  }
}

const post = (url: string, body?: unknown) =>
  fetch(url, {
    method: "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export function ImportForm() {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [ok, setOk] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage("");
    const pasted = text;
    setText(""); // never keep (or echo) the pasted cookies on screen
    try {
      const res = await post("/api/vault/accounts", { label, json: pasted });
      if (res.ok) {
        setOk(true);
        setLabel("");
        setMessage("Account connected.");
        router.refresh();
      } else {
        setOk(false);
        setMessage(`${await errorText(res)} The box was cleared; paste the export again.`);
      }
    } catch {
      setOk(false);
      setMessage("Could not reach the server. Paste the export again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="stack">
      <label htmlFor="label">Account name</label>
      <input id="label" name="label" maxLength={60} required value={label} onChange={(e) => setLabel(e.target.value)} autoComplete="off" />
      <label htmlFor="cookies">Paste the cookie JSON export</label>
      <textarea
        id="cookies"
        name="cookies"
        rows={6}
        required
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <button type="submit" disabled={busy}>
        {busy ? "Connecting…" : "Connect account"}
      </button>
      <p role="status" aria-live="polite" className={ok ? "msg okmsg" : "msg"}>
        {message}
      </p>
    </form>
  );
}

function Confirm({ prompt, action, onConfirm, busy, label }: { prompt: string; action: string; onConfirm: () => void; busy: boolean; label: string }) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className="danger" onClick={() => setAsking(true)} aria-label={label}>
        {action}
      </button>
    );
  }
  return (
    <span className="confirm" role="group" aria-label={`Confirm: ${label}`}>
      <span>{prompt}</span>
      <button type="button" className="danger" disabled={busy} onClick={onConfirm}>
        {busy ? "Working…" : "Yes, do it"}
      </button>
      <button type="button" className="plain" disabled={busy} onClick={() => setAsking(false)}>
        Cancel
      </button>
    </span>
  );
}

export function KillButton({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function kill() {
    setBusy(true);
    setMessage("");
    try {
      const res = await post(`/api/vault/accounts/${id}/kill`);
      if (res.ok) router.refresh();
      else setMessage(await errorText(res));
    } catch {
      setMessage("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Confirm prompt="Disable and erase the stored session?" action="Kill" label={`Kill ${name}`} onConfirm={kill} busy={busy} />
      <span role="status" aria-live="polite" className="msg">
        {message}
      </span>
    </>
  );
}

export function RevokeAllButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function revoke() {
    setBusy(true);
    setMessage("");
    try {
      const res = await post("/api/vault/revoke-all");
      if (res.ok) router.refresh();
      else setMessage(await errorText(res));
    } catch {
      setMessage("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <Confirm prompt="Disable every account and erase all stored sessions?" action="Revoke all" label="Revoke all accounts" onConfirm={revoke} busy={busy} />
      <p role="status" aria-live="polite" className="msg">
        {message}
      </p>
    </div>
  );
}

export function SignOutButton() {
  const router = useRouter();
  async function out() {
    try {
      await post("/api/owner/logout");
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }
  return (
    <button type="button" className="plain" onClick={out}>
      Sign out
    </button>
  );
}

/** Generic owner action button for the Connected apps section. */
export function AppActionButton({ url, prompt, action, label }: { url: string; prompt: string; action: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function run() {
    setBusy(true);
    setMessage("");
    try {
      const res = await post(url);
      if (res.ok) router.refresh();
      else setMessage(await errorText(res));
    } catch {
      setMessage("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Confirm prompt={prompt} action={action} label={label} onConfirm={run} busy={busy} />
      <span role="status" aria-live="polite" className="msg">
        {message}
      </span>
    </>
  );
}
