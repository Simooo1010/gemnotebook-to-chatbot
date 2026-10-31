import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cookieName, isSecureEnv, verifySessionToken } from "@/lib/auth/session";
import { listAccountViews, type AccountView } from "@/lib/owner/handlers";
import { getVault } from "@/lib/vault";
import { getOAuthDeps } from "@/lib/oauth";
import type { OAuthClient } from "@/lib/oauth/store";
import { AccountCard } from "./AccountCard";
import { AppActionButton, ImportForm, RevokeAllButton, SignOutButton } from "./VaultClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Vault · NotebookLM connector" };

export default async function VaultPage() {
  const jar = await cookies();
  if (!verifySessionToken(jar.get(cookieName(isSecureEnv(process.env)))?.value, process.env)) redirect("/login");

  let accounts: AccountView[] | null = null;
  try {
    accounts = await listAccountViews(getVault());
  } catch {
    accounts = null; // storage not configured or unreachable; details are never shown
  }
  let apps: OAuthClient[] | null = null;
  try {
    apps = await getOAuthDeps().store.clients.list();
  } catch {
    apps = null;
  }

  return (
    <main>
      <header className="bar">
        <h1>Connected Google accounts</h1>
        <SignOutButton />
      </header>

      {accounts === null ? (
        <p role="alert" className="msg">
          The vault is not available. Check the server settings.
        </p>
      ) : accounts.length === 0 ? (
        <p>No accounts yet. Add one below.</p>
      ) : (
        <ul className="list">
          {accounts.map((a) => (
            <AccountCard key={a.id} a={a} />
          ))}
        </ul>
      )}

      <section aria-labelledby="add">
        <h2 id="add">Add an account</h2>
        <ol className="steps">
          <li>Install a cookie-export extension (for example Cookie-Editor) in a desktop browser.</li>
          <li>Open a private window and sign in at notebook.google.com.</li>
          <li>Export the cookies as JSON with the extension and paste them below.</li>
          <li>Close the private window without signing out.</li>
        </ol>
        <p className="meta">No password is ever typed or stored. The pasted text is encrypted and never shown again.</p>
        <ImportForm />
      </section>

      <section aria-labelledby="apps">
        <h2 id="apps">Connected apps</h2>
        {apps === null ? (
          <p role="alert" className="msg">
            The app list is not available.
          </p>
        ) : apps.length === 0 ? (
          <p>No apps connected.</p>
        ) : (
          <>
            <ul className="list">
              {apps.map((c) => (
                <li key={c.clientId} className="card">
                  <div className="row">
                    <strong>{c.clientName}</strong>
                    <span className="meta">Registered {c.createdAt.toISOString().slice(0, 10)}</span>
                  </div>
                  <p className="meta">Returns to {[...new Set(c.redirectUris.map((u) => new URL(u).host))].join(", ")}</p>
                  <AppActionButton
                    url={`/api/vault/apps/${encodeURIComponent(c.clientId)}/revoke`}
                    prompt="Revoke this app's access and remove it?"
                    action="Revoke"
                    label={`Revoke ${c.clientName}`}
                  />
                </li>
              ))}
            </ul>
            <AppActionButton url="/api/vault/apps/revoke-all" prompt="Revoke access for every connected app?" action="Revoke all connector access" label="Revoke all connector access" />
          </>
        )}
      </section>

      <section aria-labelledby="danger">
        <h2 id="danger">Emergency</h2>
        <p className="meta">Disables every account and erases all stored sessions.</p>
        <RevokeAllButton />
      </section>
    </main>
  );
}
