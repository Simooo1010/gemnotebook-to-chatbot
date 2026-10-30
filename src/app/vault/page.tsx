import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cookieName, isSecureEnv, verifySessionToken } from "@/lib/auth/session";
import { listAccountViews, type AccountView } from "@/lib/owner/handlers";
import { getVault } from "@/lib/vault";
import { ImportForm, KillButton, RevokeAllButton, SignOutButton } from "./VaultClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Vault · NotebookLM connector" };

const STATUS_LABEL: Record<AccountView["status"], string> = {
  active: "Active",
  needs_reauth: "Needs sign-in again",
  disabled: "Disabled",
};

export default async function VaultPage() {
  const jar = await cookies();
  if (!verifySessionToken(jar.get(cookieName(isSecureEnv(process.env)))?.value, process.env)) redirect("/login");

  let accounts: AccountView[] | null = null;
  try {
    accounts = await listAccountViews(getVault());
  } catch {
    accounts = null; // storage not configured or unreachable; details are never shown
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
            <li key={a.id} className="card">
              <div className="row">
                <strong>{a.label}</strong>
                <span className={`badge ${a.status}`}>{STATUS_LABEL[a.status]}</span>
              </div>
              <p className="meta">
                Added {a.createdAt.slice(0, 10)}
                {a.cookieNameCount !== null ? ` · ${a.cookieNameCount} cookie names stored` : ""}
              </p>
              {a.status !== "disabled" ? <KillButton id={a.id} name={a.label} /> : null}
            </li>
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

      <section aria-labelledby="danger">
        <h2 id="danger">Emergency</h2>
        <p className="meta">Disables every account and erases all stored sessions.</p>
        <RevokeAllButton />
      </section>
    </main>
  );
}
