import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AccountView } from "@/lib/owner/handlers";
import { AccountCard, UNREADABLE_TEXT } from "./AccountCard";

// The kill button is a client component that needs the app router; a stub is enough for static markup.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const view = (over: Partial<AccountView> = {}): AccountView => ({
  id: "00000000-0000-4000-8000-000000000001",
  label: "Main",
  status: "active",
  createdAt: "2026-10-31T00:00:00.000Z",
  cookieNameCount: 3,
  sessionReadable: true,
  ...over,
});
const html = (a: AccountView) => renderToStaticMarkup(createElement("ul", null, createElement(AccountCard, { a })));

describe("vault account card", () => {
  it("shows the warning badge for an active account whose session is unreadable", () => {
    const out = html(view({ cookieNameCount: null, sessionReadable: false }));
    expect(out).toContain("Session unreadable");
    expect(out).toContain("re-import this account");
    expect(out).toContain('class="badge unreadable"');
    expect(out).toContain("Active"); // the stored status is still shown as-is
  });
  it("shows no warning for a readable session, nor for a disabled account", () => {
    expect(html(view())).not.toContain(UNREADABLE_TEXT);
    expect(html(view({ status: "disabled", cookieNameCount: null, sessionReadable: false }))).not.toContain(UNREADABLE_TEXT);
  });
  it("the warning colour is defined for both themes (danger token in light and dark)", () => {
    const css = readFileSync(path.join(__dirname, "../layout.tsx"), "utf8");
    expect(css).toContain(".badge.unreadable{color:var(--danger)}");
    expect(css).toMatch(/:root\{[^}]*--danger:#b3261e/);
    expect(css).toMatch(/prefers-color-scheme: dark\)\{:root\{[^}]*--danger:#f2b8b5/);
  });
});
