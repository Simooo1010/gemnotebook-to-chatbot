import type { AccountView } from "@/lib/owner/handlers";
import { KillButton } from "./VaultClient";

export const STATUS_LABEL: Record<AccountView["status"], string> = {
  active: "Active",
  needs_reauth: "Needs sign-in again",
  disabled: "Disabled",
};

export const UNREADABLE_TEXT = "Session unreadable \u2014 re-import this account";

/** Only an ACTIVE account can be flagged: disabled accounts have no stored session by design. */
export const isUnreadable = (a: Pick<AccountView, "status" | "sessionReadable">) => a.status === "active" && !a.sessionReadable;

export function AccountCard({ a }: { a: AccountView }) {
  const unreadable = isUnreadable(a);
  return (
    <li className="card">
      <div className="row">
        <strong>{a.label}</strong>
        <span className={`badge ${a.status}`}>{STATUS_LABEL[a.status]}</span>
        {unreadable ? <span className="badge unreadable">{UNREADABLE_TEXT}</span> : null}
      </div>
      {unreadable ? (
        <p role="alert" className="warn">
          The stored Google session cannot be read (the server keys may have changed). Kill this account and import it again.
        </p>
      ) : null}
      <p className="meta">
        Added {a.createdAt.slice(0, 10)}
        {a.cookieNameCount !== null ? ` \u00b7 ${a.cookieNameCount} cookie names stored` : ""}
      </p>
      {a.status !== "disabled" ? <KillButton id={a.id} name={a.label} /> : null}
    </li>
  );
}
