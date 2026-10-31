// SYNTHETIC fixture built from docs/PROTOCOL.md; replace with real capture in the real-data run
import { describe, expect, it } from "vitest";
import { buildBatchUrl, buildChatUrl, encodeBatchBody, encodeChatBody, nextReqId } from "./batchexecute";
import { decodeBatchResponse } from "./decode";
import { RpcAuthError, RpcDriftError, RpcNoFramesError, RpcQuotaError, RpcStatusError, errorForHttpStatus } from "./errors";
import { RPC_IDS, resolveRpcId, sourcePathFor } from "./ids";
import { classifyHomepage, extractPageTokens } from "./page";

/** Build a batchexecute body: anti-XSSI + (bogus) length line + JSON chunk per chunk. */
export function wire(...chunks: unknown[][]): string {
  return ")]}'\n" + chunks.map((c) => `999\n${JSON.stringify(c)}\n`).join("");
}
export const frame = (id: string | null, payload: unknown, status: unknown = null) => [
  "wrb.fr",
  id,
  payload === undefined ? null : JSON.stringify(payload),
  null,
  null,
  status,
  "generic",
];

describe("ids", () => {
  it("has the v1 ids", () => {
    expect(Object.values(RPC_IDS).sort()).toEqual(
      ["wXbhsf", "CCqFvf", "s0tc2d", "rLM1Ne", "VfAZjd", "izAoDd", "ozz5Z", "hizoJc", "tr032e", "hPTbtc", "R7cb6c", "gArtLc", "ZwVcOc", "EylDcb", "SatQRc"].sort(),
    );
  });
  it("source paths", () => {
    expect(sourcePathFor("LIST_NOTEBOOKS")).toBe("/");
    expect(sourcePathFor("GET_NOTEBOOK", "abc-1")).toBe("/notebook/abc-1");
    expect(() => sourcePathFor("GET_NOTEBOOK")).toThrow();
    expect(() => sourcePathFor("GET_NOTEBOOK", "../x")).toThrow();
  });
  it("overrides", () => {
    expect(resolveRpcId("LIST_NOTEBOOKS", undefined)).toBe("wXbhsf");
    expect(resolveRpcId("LIST_NOTEBOOKS", '{"LIST_NOTEBOOKS":"abcD12"}')).toBe("abcD12");
    expect(resolveRpcId("LIST_NOTEBOOKS", '{"LIST_NOTEBOOKS":"bad id!"}')).toBe("wXbhsf");
    expect(resolveRpcId("LIST_NOTEBOOKS", '{"LIST_NOTEBOOKS":"ab"}')).toBe("wXbhsf");
    expect(resolveRpcId("LIST_NOTEBOOKS", '{"NOPE":"abcD12"}')).toBe("wXbhsf");
    expect(resolveRpcId("LIST_NOTEBOOKS", "not json")).toBe("wXbhsf");
    expect(resolveRpcId("LIST_NOTEBOOKS", "[1]")).toBe("wXbhsf");
  });
});

describe("batchexecute encoding", () => {
  it("builds the URL", () => {
    expect(
      buildBatchUrl({ base: "https://notebook.google.com/", rpcId: "rLM1Ne", sourcePath: "/notebook/nb1", fsid: "123", bl: "boq_x", authuser: "a@b.c" }),
    ).toBe(
      "https://notebook.google.com/_/LabsTailwindUi/data/batchexecute?rpcids=rLM1Ne&source-path=%2Fnotebook%2Fnb1&f.sid=123&hl=en&rt=c&bl=boq_x&authuser=a%40b.c",
    );
    expect(buildBatchUrl({ base: "https://h", rpcId: "x", sourcePath: "/", fsid: "1" })).toBe(
      "https://h/_/LabsTailwindUi/data/batchexecute?rpcids=x&source-path=%2F&f.sid=1&hl=en&rt=c",
    );
  });
  it("encodes the body exactly", () => {
    const body = encodeBatchBody({ rpcId: "wXbhsf", params: [null, 1, null, [2]], at: "AB:c/d=" });
    expect(body).toBe(
      "f.req=" + encodeURIComponent('[[["wXbhsf","[null,1,null,[2]]",null,"generic"]]]') + "&at=AB%3Ac%2Fd%3D&",
    );
    expect(body).toContain("%5B%5B%5B%22wXbhsf%22");
  });
  it("chat URL/body and reqid", () => {
    expect(nextReqId()).toBe(100000);
    expect(nextReqId(100000)).toBe(200000);
    expect(buildChatUrl({ base: "https://h", bl: "b", reqId: 100000, fsid: "9" })).toBe(
      "https://h/_/LabsTailwindUi/data/google.internal.labs.tailwind.orchestration.v1.LabsTailwindOrchestrationService/GenerateFreeFormStreamed?bl=b&hl=en&_reqid=100000&rt=c&f.sid=9",
    );
    // T3-11: no bare `bl=` when the homepage had no cfb2h
    for (const bl of [undefined, ""]) {
      const u = buildChatUrl({ base: "https://h", bl, reqId: 100000, fsid: "9" });
      expect(u).not.toMatch(/[?&]bl=/);
      expect(u).toContain("hl=en&_reqid=100000&rt=c&f.sid=9");
    }
    expect(encodeChatBody({ params: ["q"], at: "t" })).toBe("f.req=" + encodeURIComponent('[null,"[\\"q\\"]"]') + "&at=t&");
  });
});

describe("decodeBatchResponse", () => {
  it("strips XSSI, ignores length lines, takes last non-null across chunks", () => {
    const t = wire([frame("wXbhsf", [1]), ["di", 5]], [frame("wXbhsf", [2]), frame("wXbhsf", null)], [["e", 4, null, null, 10]]);
    expect(decodeBatchResponse(t, "wXbhsf")).toEqual([2]);
  });
  it("CRLF and no length lines", () => {
    expect(decodeBatchResponse(")]}'\r\n" + JSON.stringify([frame("a1b2", "x")]), "a1b2")).toBe("x");
  });
  it("drift when frames exist for other ids", () => {
    try {
      decodeBatchResponse(wire([frame("other1", [1])]), "wXbhsf", { allowNull: true });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RpcDriftError);
      expect((e as RpcDriftError).kind).toBe("drift");
      expect((e as RpcDriftError).foundIds).toEqual(["other1"]);
    }
  });
  it("no frames (HTML)", () => {
    expect(() => decodeBatchResponse("<html>sign in</html>", "x1y2")).toThrow(RpcNoFramesError);
    expect(() => decodeBatchResponse(wire([["di", 1]]), "x1y2")).toThrow(RpcNoFramesError);
  });
  it("status mapping", () => {
    const d = (s: unknown) => () => decodeBatchResponse(wire([frame("R7cb6c", undefined, s)]), "R7cb6c");
    expect(d([3])).toThrow(RpcStatusError);
    expect(d([5])).toThrow(/NOT_FOUND/);
    expect(d([7])).toThrow(/PERMISSION_DENIED/);
    expect(d([8])).toThrow(RpcQuotaError);
    expect(d([16])).toThrow(RpcAuthError);
    expect(d([3, null, [["type.googleapis.com/google.internal.labs.tailwind.UserDisplayableError", []]]])).toThrow(RpcQuotaError);
    expect(() => decodeBatchResponse(wire([["er", "R7cb6c", 7]]), "R7cb6c")).toThrow(RpcStatusError);
  });
  it("null frame: ok only with allowNull", () => {
    const t = wire([frame("fejl7e", null)]);
    expect(decodeBatchResponse(t, "fejl7e", { allowNull: true })).toBeNull();
    expect(() => decodeBatchResponse(t, "fejl7e")).toThrow(RpcDriftError);
  });
  it("http status mapping", () => {
    expect(errorForHttpStatus("x", 401)).toBeInstanceOf(RpcAuthError);
    expect(errorForHttpStatus("x", 403)?.kind).toBe("auth");
    const q = errorForHttpStatus("x", 429, "30") as RpcQuotaError;
    expect(q.kind).toBe("quota");
    expect(q.retryAfterSec).toBe(30);
    expect(errorForHttpStatus("x", 500)).toBeNull();
  });
});

describe("page", () => {
  it("extracts token variants", () => {
    expect(extractPageTokens(`{"SNlM0e":"AT1","FdrFJe":"-123","cfb2h":"boq_labs-tailwind-frontend_20260802.02_p0"}`)).toEqual({
      at: "AT1",
      fsid: "-123",
      bl: "boq_labs-tailwind-frontend_20260802.02_p0",
    });
    expect(extractPageTokens(`{'SNlM0e':'AT2'}`).at).toBe("AT2");
    expect(extractPageTokens(`&quot;SNlM0e&quot;:&quot;AT3&quot;`).at).toBe("AT3");
    expect(extractPageTokens(`"SNlM0e":""`).at).toBe("");
    expect(extractPageTokens(`nothing`)).toEqual({ at: null, fsid: null, bl: null });
  });
  it("classifies", () => {
    const ok = { finalUrl: "https://notebook.google.com/", status: 200, html: '"SNlM0e":"x"' };
    expect(classifyHomepage(ok)).toBe("ok");
    expect(classifyHomepage({ ...ok, finalUrl: "https://accounts.google.com/v3/signin" })).toBe("signed_out");
    expect(classifyHomepage({ ...ok, html: '<a class="landing-header-signin">' })).toBe("signed_out");
    expect(classifyHomepage({ ...ok, html: "<html></html>" })).toBe("signed_out");
    expect(classifyHomepage({ ...ok, finalUrl: "https://accounts.google.com/CookieMismatch?x=1" })).toBe("cookie_mismatch");
    expect(classifyHomepage({ ...ok, finalUrl: "https://notebooklm.google/?location=unsupported" })).toBe("region_gate");
    expect(classifyHomepage({ ...ok, finalUrl: "https://notebook.google/" })).toBe("region_gate");
    expect(classifyHomepage({ ...ok, status: 500 })).toBe("unknown");
  });
});
