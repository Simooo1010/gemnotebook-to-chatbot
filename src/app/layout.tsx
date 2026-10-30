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
:root{--bg:#ffffff;--fg:#1a1a1a;--muted:#5c5c5c;--ok:#1a7f37}
@media (prefers-color-scheme: dark){:root{--bg:#121212;--fg:#ededed;--muted:#a0a0a0;--ok:#4ac26b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.5}
main{max-width:40rem;margin:0 auto;padding:2rem 16px}
h1{font-size:1.5rem;margin:0 0 .5rem}
p{margin:.25rem 0;color:var(--muted)}
.ok{color:var(--ok);font-weight:600}
code{overflow-wrap:anywhere}
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
