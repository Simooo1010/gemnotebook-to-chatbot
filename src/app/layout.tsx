import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "NotebookLM connector",
  description: "Remote MCP server for NotebookLM",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
};

const css = `
:root{--bg:#ffffff;--fg:#1a1a1a;--muted:#5c5c5c;--ok:#1a7f37;--card:#f5f5f5;--border:#c4c4c4;--accent:#0b57d0;--accent-fg:#ffffff;--danger:#b3261e;--warn:#8a5a00}
@media (prefers-color-scheme: dark){:root{--bg:#121212;--fg:#ededed;--muted:#a0a0a0;--ok:#4ac26b;--card:#1e1e1e;--border:#4a4a4a;--accent:#8ab4f8;--accent-fg:#101010;--danger:#f2b8b5;--warn:#f0c36a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.5}
main{max-width:40rem;margin:0 auto;padding:2rem 16px}
h1{font-size:1.5rem;margin:0 0 .5rem}
p{margin:.25rem 0;color:var(--muted)}
.ok{color:var(--ok);font-weight:600}
code{overflow-wrap:anywhere}
h2{font-size:1.15rem;margin:2rem 0 .5rem}
.stack{display:flex;flex-direction:column;gap:.5rem;align-items:flex-start}
.stack input,.stack textarea{width:100%}
label{font-weight:600}
input,textarea{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:.6rem}
textarea{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.85rem}
button{font:inherit;min-height:44px;padding:.5rem 1rem;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg);cursor:pointer}
button.plain{background:transparent;color:var(--fg);border-color:var(--border)}
button.danger{background:transparent;color:var(--danger);border-color:var(--danger)}
button:disabled{opacity:.6;cursor:default}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.msg{min-height:1.5em;overflow-wrap:anywhere}
.okmsg{color:var(--ok)}
.bar{display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap}
.list{list-style:none;margin:1rem 0;padding:0;display:flex;flex-direction:column;gap:.75rem}
.card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:.75rem 1rem}
.row{display:flex;justify-content:space-between;align-items:center;gap:.5rem;flex-wrap:wrap}
.meta{font-size:.9rem;color:var(--muted)}
.badge{font-size:.8rem;font-weight:600;padding:.1rem .6rem;border:1px solid currentColor;border-radius:999px}
.badge.active{color:var(--ok)}.badge.needs_reauth{color:var(--warn)}.badge.disabled{color:var(--muted)}
.confirm{display:inline-flex;flex-wrap:wrap;gap:.5rem;align-items:center}
.steps{padding-left:1.25rem;color:var(--muted)}
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style>{css}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
