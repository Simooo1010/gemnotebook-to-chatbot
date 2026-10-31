import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cookieName, isSecureEnv, verifySessionToken } from "@/lib/auth/session";
import { getOAuthDeps } from "@/lib/oauth";
import { checkAuthorizeRequest, type AuthorizeCheck } from "@/lib/oauth/authorize";
import { consentCsrfToken } from "@/lib/oauth/csrf";
import { resolveBaseUrl } from "@/lib/oauth/metadata";

export const dynamic = "force-dynamic";
// The site-wide header says no-referrer, and with that policy browsers send "Origin: null" on a form POST,
// which /oauth/consent rejects (fail closed) -> Approve/Deny would always answer 403. Same-origin keeps the real
// Origin on the form POST and still sends no Referer to any other site (including the redirect back to the client).
export const metadata = { title: "Allow access · NotebookLM connector", referrer: "same-origin" as const };

type SP = Record<string, string | string[] | undefined>;

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  // Repeated parameters are ambiguous: drop them (the check then fails).
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") params.set(k, v);

  const jar = await cookies();
  const session = jar.get(cookieName(isSecureEnv(process.env)))?.value ?? null;
  if (!verifySessionToken(session, process.env) || !session) {
    redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${params.toString()}`)}`);
  }

  const h = await headers();
  const host = h.get("host") ?? "localhost";
  const proto = h.get("x-forwarded-proto") ?? (isSecureEnv(process.env) ? "https" : "http");
  const base = resolveBaseUrl(process.env.PUBLIC_BASE_URL, `${proto}://${host}`);

  let check: AuthorizeCheck;
  try {
    check = await checkAuthorizeRequest(params, getOAuthDeps(), base);
  } catch {
    check = { kind: "fatal", message: "The server storage is not available. Try again later." };
  }
  if (check.kind === "redirect") redirect(check.url);
  const csrf = consentCsrfToken(session, process.env);

  if (check.kind === "fatal" || !csrf) {
    return (
      <main>
        <h1>Cannot connect this app</h1>
        <p role="alert" className="msg">
          {check.kind === "fatal" ? check.message : "The server is not configured."}
        </p>
      </main>
    );
  }

  const { request: r, view } = check;
  return (
    <main>
      <h1>Allow “{view.clientName}” to use NotebookLM?</h1>
      <div className="card stack">
        <p>
          <strong>App:</strong> {view.clientName}
        </p>
        <p>
          <strong>Returns to:</strong> <code>{view.redirectHost}</code>
        </p>
        <p>
          <strong>It will be able to:</strong> {view.scopeText}
        </p>
        <p className="meta">It never sees your Google cookies. You can revoke access any time on the vault page.</p>
      </div>
      <form method="post" action="/oauth/consent" className="confirm" style={{ marginTop: "1rem" }}>
        <input type="hidden" name="csrf" value={csrf} />
        <input type="hidden" name="response_type" value="code" />
        <input type="hidden" name="client_id" value={r.clientId} />
        <input type="hidden" name="redirect_uri" value={r.redirectUri} />
        <input type="hidden" name="code_challenge" value={r.codeChallenge} />
        <input type="hidden" name="code_challenge_method" value="S256" />
        <input type="hidden" name="scope" value={r.scope} />
        {r.state !== null ? <input type="hidden" name="state" value={r.state} /> : null}
        {r.resource !== null ? <input type="hidden" name="resource" value={r.resource} /> : null}
        <button type="submit" name="decision" value="approve">
          Approve
        </button>
        <button type="submit" name="decision" value="deny" className="plain">
          Deny
        </button>
      </form>
    </main>
  );
}
