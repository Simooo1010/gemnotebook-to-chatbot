// Test helpers: scripted fake fetch and synthetic fixtures. No real network. Not imported by app code.
import type { CookieJar } from "@/lib/vault/jar";
import type { FetchInit, FetchLike } from "./http";

export interface Call {
  url: string;
  init: FetchInit;
}
export type Handler = (url: string, init: FetchInit) => Response | Promise<Response>;

export const SYN_SID = "SYNTHETIC_SID_VALUE_x1";
export const SYN_TS = "SYNTHETIC_PSIDTS_VALUE_x2";
export const SYN_AT = "SYNTHETIC_AT_TOKEN";

export function synthJar(): CookieJar {
  return {
    cookies: [
      { name: "SID", value: SYN_SID, domain: ".google.com", path: "/", secure: true, httpOnly: true },
      { name: "__Secure-1PSIDTS", value: SYN_TS, domain: ".google.com", path: "/", secure: true, httpOnly: true },
    ],
  };
}

export function res(
  status: number,
  o: { body?: string | null; headers?: Record<string, string>; setCookie?: string[]; location?: string } = {},
): Response {
  const h = new Headers(o.headers ?? {});
  for (const c of o.setCookie ?? []) h.append("set-cookie", c);
  if (o.location) h.set("location", o.location);
  return new Response(o.body ?? null, { status, headers: h });
}

/** Handlers are consumed in order; an unexpected extra call fails the test. */
export function scriptedFetch(handlers: Handler[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...handlers];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const h = queue.shift();
    if (!h) throw new Error(`unexpected fetch #${calls.length} to ${new URL(url).hostname}`);
    return h(url, init);
  };
  return { fetch, calls };
}

export const homepageHtml = (at = SYN_AT) =>
  `<html><script>window.WIZ_global_data={"SNlM0e":"${at}","FdrFJe":"-1234567890123456789","cfb2h":"boq_labs-tailwind-frontend_20260802.02_p0"};</script></html>`;

export function batchBody(rpcId: string, payload: unknown): string {
  const line = JSON.stringify([["wrb.fr", rpcId, JSON.stringify(payload), null, null, null, "generic"]]);
  return `)]}'\n\n${line.length}\n${line}\n`;
}
export function batchStatusBody(rpcId: string, code: number): string {
  const line = JSON.stringify([["wrb.fr", rpcId, null, null, null, [code], "generic"]]);
  return `)]}'\n\n${line.length}\n${line}\n`;
}

export function fakeClock(start = Date.UTC(2026, 9, 30, 12, 0, 0)) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}
