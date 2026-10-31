// Request handling for owner login and the vault API. Pure functions with injected deps, so every
// auth / CSRF / limiter path is unit-testable. Never logs or echoes passphrases, cookies or pasted JSON.
import { createHash } from "node:crypto";
import type { LoginLimiter } from "@/lib/auth/login-limiter";
import { verifyOwnerPassphrase } from "@/lib/auth/passphrase";
import {
  checkOrigin,
  clearedCookie,
  createSessionToken,
  isOwnerRequest,
  isSecureEnv,
  sessionCookie,
} from "@/lib/auth/session";
import { isJarError, jarSummary } from "@/lib/vault/jar";
import { isVaultError, type Vault } from "@/lib/vault/vault";
import type { Account } from "@/lib/vault/storage";

type Env = Record<string, string | undefined>;

export interface OwnerDeps {
  env: Env;
  limiter: LoginLimiter;
  /** Lazy: may throw when storage is not configured (→ 503). */
  getVault: () => Vault;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const MAX_LOGIN_BODY = 4 * 1024;
const MAX_IMPORT_BODY = 512 * 1024;
const MAX_LABEL = 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}
const err = (status: number, code: string, message: string, extra?: Record<string, unknown>, headers?: Record<string, string>) =>
  json(status, { error: { code, message, ...extra } }, headers);

/** Origin (CSRF) then owner session. Returns a Response to send, or null if allowed. */
function guard(request: Request, deps: OwnerDeps, stateChanging: boolean): Response | null {
  if (stateChanging && !checkOrigin(request, deps.env.PUBLIC_BASE_URL)) {
    return err(403, "forbidden", "Cross-origin request refused.");
  }
  const now = deps.now?.() ?? Date.now();
  if (!isOwnerRequest(request, deps.env, now)) return err(401, "unauthorized", "Sign in first.");
  return null;
}

async function readJson(request: Request, maxBytes: number): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (text.length > maxBytes) return null;
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function clientKey(request: Request): string {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip")?.trim() || "unknown";
  return createHash("sha256").update(ip, "utf8").digest("hex");
}

// ---- Login / logout --------------------------------------------------------

export async function handleLogin(request: Request, deps: OwnerDeps): Promise<Response> {
  if (!checkOrigin(request, deps.env.PUBLIC_BASE_URL)) return err(403, "forbidden", "Cross-origin request refused.");
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  const key = clientKey(request);

  // The attempt is registered before the passphrase is checked, so parallel guesses are counted too.
  const gate = await deps.limiter.attempt(key);
  if (!gate.allowed) {
    return err(429, "too_many_attempts", "Too many attempts. Try again later.", undefined, {
      "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)),
    });
  }

  const body = await readJson(request, MAX_LOGIN_BODY);
  const ok = body !== null && verifyOwnerPassphrase(body.passphrase, deps.env);
  if (!ok) {
    await sleep(600 + Math.floor(random() * 400)); // constant-ish delay on failure
    return err(401, "invalid_credentials", "That did not work.");
  }

  let token: string;
  try {
    token = createSessionToken(deps.env, now()).token;
  } catch {
    return err(503, "not_configured", "Sign-in is not configured on the server.");
  }
  await deps.limiter.recordSuccess(key);
  return json(200, { ok: true }, { "Set-Cookie": sessionCookie(token, isSecureEnv(deps.env)) });
}

export function handleLogout(request: Request, deps: OwnerDeps): Response {
  if (!checkOrigin(request, deps.env.PUBLIC_BASE_URL)) return err(403, "forbidden", "Cross-origin request refused.");
  return json(200, { ok: true }, { "Set-Cookie": clearedCookie(isSecureEnv(deps.env)) });
}

// ---- Vault -----------------------------------------------------------------

export interface AccountView {
  id: string;
  label: string;
  status: Account["status"];
  createdAt: string;
  /** Number of distinct cookie NAMES in the stored session (null when none/unreadable). Never values. */
  cookieNameCount: number | null;
}

export async function listAccountViews(vault: Vault): Promise<AccountView[]> {
  const accounts = await vault.listAccounts();
  return Promise.all(
    accounts.map(async (a) => {
      let cookieNameCount: number | null = null;
      if (a.status === "active") {
        try {
          cookieNameCount = jarSummary(await vault.getJar(a.id)).names.length;
        } catch {
          cookieNameCount = null;
        }
      }
      return { id: a.id, label: a.label, status: a.status, createdAt: a.createdAt.toISOString(), cookieNameCount };
    }),
  );
}

function vaultFailure(e: unknown): Response {
  if (isVaultError(e)) {
    return e.code === "not_found" ? err(404, "not_found", "Account not found.") : err(409, e.code, "Not available.");
  }
  return err(500, "server_error", "Something went wrong. Nothing was changed.");
}

function withVault(deps: OwnerDeps): Vault | Response {
  try {
    return deps.getVault();
  } catch {
    return err(503, "vault_unavailable", "The vault is not configured on the server.");
  }
}

export async function handleListAccounts(request: Request, deps: OwnerDeps): Promise<Response> {
  const denied = guard(request, deps, false);
  if (denied) return denied;
  const vault = withVault(deps);
  if (vault instanceof Response) return vault;
  try {
    return json(200, { accounts: await listAccountViews(vault) });
  } catch (e) {
    return vaultFailure(e);
  }
}

const IMPORT_MESSAGES: Record<string, string> = {
  invalid_format: "That is not a cookie export. Paste the JSON exactly as the extension exported it.",
  too_many_cookies: "That export has too many cookies.",
  missing_required: "The export is missing required cookies.",
};

export async function handleImport(request: Request, deps: OwnerDeps): Promise<Response> {
  const denied = guard(request, deps, true);
  if (denied) return denied;
  const vault = withVault(deps);
  if (vault instanceof Response) return vault;

  const body = await readJson(request, MAX_IMPORT_BODY);
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  if (!label || label.length > MAX_LABEL || /[\u0000-\u001f\u007f]/.test(label)) {
    return err(400, "invalid_label", `Give the account a short name (1 to ${MAX_LABEL} characters).`);
  }
  const text = body?.json;
  if (typeof text !== "string" || !text.trim()) {
    return err(400, "invalid_format", IMPORT_MESSAGES.invalid_format!);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err(400, "invalid_format", IMPORT_MESSAGES.invalid_format!);
  }
  try {
    const { account, summary } = await vault.connectAccount(label, parsed);
    return json(201, {
      account: { id: account.id, label: account.label, status: account.status, createdAt: account.createdAt.toISOString(), cookieNameCount: summary.names.length },
    });
  } catch (e) {
    if (isJarError(e)) {
      // Cookie NAMES only, never values (copied as plain strings; nothing else from the error is echoed).
      const missing = (e.missing ?? []).map(String);
      return err(400, e.code, IMPORT_MESSAGES[e.code] ?? "Import failed.", e.code === "missing_required" ? { missing } : undefined);
    }
    return vaultFailure(e);
  }
}

export async function handleKill(request: Request, id: string, deps: OwnerDeps): Promise<Response> {
  const denied = guard(request, deps, true);
  if (denied) return denied;
  if (!UUID_RE.test(id)) return err(404, "not_found", "Account not found.");
  const vault = withVault(deps);
  if (vault instanceof Response) return vault;
  try {
    await vault.killAccount(id);
    return json(200, { ok: true });
  } catch (e) {
    return vaultFailure(e);
  }
}

export async function handleRevokeAll(request: Request, deps: OwnerDeps): Promise<Response> {
  const denied = guard(request, deps, true);
  if (denied) return denied;
  const vault = withVault(deps);
  if (vault instanceof Response) return vault;
  try {
    return json(200, { ok: true, disabled: await vault.revokeAll() });
  } catch (e) {
    return vaultFailure(e);
  }
}
