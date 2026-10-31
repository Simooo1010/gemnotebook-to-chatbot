/** v1 RPC ids, copied exactly from docs/SPEC.md §2 / docs/PROTOCOL.md §3. */
export const RPC_IDS = {
  LIST_NOTEBOOKS: "wXbhsf",
  CREATE_NOTEBOOK: "CCqFvf",
  RENAME_NOTEBOOK: "s0tc2d",
  GET_NOTEBOOK: "rLM1Ne",
  NOTEBOOK_SUMMARY: "VfAZjd",
  ADD_SOURCE: "izAoDd",
  ADD_SOURCE_URL_FALLBACK: "ozz5Z",
  SOURCE_TEXT: "hizoJc",
  SOURCE_GUIDE: "tr032e",
  GET_LAST_CONVERSATION_ID: "hPTbtc",
  CREATE_ARTIFACT: "R7cb6c",
  LIST_ARTIFACTS: "gArtLc",
  GET_USER_SETTINGS: "ZwVcOc",
  LIST_QUOTA_SUMMARY: "EylDcb",
  GET_ACCOUNT: "SatQRc",
} as const;

export type RpcName = keyof typeof RPC_IDS;

/** Source-path scope per RPC: "root" => "/", "notebook" => "/notebook/{id}". */
export const RPC_SCOPE: Record<RpcName, "root" | "notebook"> = {
  LIST_NOTEBOOKS: "root",
  CREATE_NOTEBOOK: "root",
  RENAME_NOTEBOOK: "root", // real captures (notebooklm-py notebooks_rename.yaml): "Home page context", source-path=/
  GET_NOTEBOOK: "notebook",
  NOTEBOOK_SUMMARY: "notebook",
  ADD_SOURCE: "notebook",
  ADD_SOURCE_URL_FALLBACK: "notebook",
  SOURCE_TEXT: "notebook",
  SOURCE_GUIDE: "notebook",
  GET_LAST_CONVERSATION_ID: "notebook",
  CREATE_ARTIFACT: "notebook",
  LIST_ARTIFACTS: "notebook",
  GET_USER_SETTINGS: "root",
  LIST_QUOTA_SUMMARY: "root",
  GET_ACCOUNT: "root",
};

export const CHAT_STREAM_PATH =
  "/_/LabsTailwindUi/data/google.internal.labs.tailwind.orchestration.v1.LabsTailwindOrchestrationService/GenerateFreeFormStreamed";
export const BATCH_PATH = "/_/LabsTailwindUi/data/batchexecute";

const NOTEBOOK_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export function sourcePathFor(name: RpcName, notebookId?: string): string {
  if (RPC_SCOPE[name] === "root") return "/";
  if (!notebookId || !NOTEBOOK_ID_RE.test(notebookId)) {
    throw new Error(`notebook id required for ${name}`);
  }
  return `/notebook/${notebookId}`;
}

const RPC_ID_RE = /^[A-Za-z0-9_]{4,12}$/;

/**
 * NOTEBOOKLM_RPC_OVERRIDES hot-patch. `overridesJson` is the raw env value,
 * passed in by the caller. Invalid JSON or entries are ignored.
 */
export function parseRpcOverrides(overridesJson: string | undefined | null): Partial<Record<RpcName, string>> {
  if (!overridesJson) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(overridesJson);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Partial<Record<RpcName, string>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k in RPC_IDS && typeof v === "string" && RPC_ID_RE.test(v)) out[k as RpcName] = v;
  }
  return out;
}

export function resolveRpcId(name: RpcName, overridesJson?: string | null): string {
  return parseRpcOverrides(overridesJson)[name] ?? RPC_IDS[name];
}
