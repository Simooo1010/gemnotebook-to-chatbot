# NotebookLM ("Gemini Notebook") unofficial protocol notes for a TypeScript client

Compiled 2026-10-30 from source code actually read (shallow `git clone` worked; github.com is reachable via git).

| Short name | Repo @ commit | Notes |
|---|---|---|
| **PY** (primary) | teng-lin/notebooklm-py @ `0fcc842` (v0.8.6, 2026-10-28) | Most thorough. `docs/rpc-reference.md` + `src/notebooklm/**`. Wire shapes pinned by golden tests and live captures (dates in the docs). |
| **CLI** | jacob-bd/notebooklm-mcp-cli @ `8ac9728` (2026-10-27) | Python. `src/notebooklm_tools/core/*.py`. Some constants are stale (see conflicts). |
| **TS** | roomi-fields/notebooklm-mcp @ `f3939d6` (v4.5.0, 2026-10-30) | **TypeScript** batchexecute client in `src/rpc/*.ts`, a direct template. Many shapes are copied from PY. |

Conventions: paths are relative to each repo. `[ ]` indices are 0-based positions in the decoded JSON arrays. **UNVERIFIED** means not confirmed from source or contradicted between sources.

Network note: the git clones worked. The GitHub **issues/search REST and GraphQL APIs are blocked** by the proxy ("sessions are bound to their configured repositories"). Issue threads (#1630, #2127, #2283 and so on) were therefore not read directly. Only what the repos' docs and changelogs say about them is used.

---

## 0. Big-picture facts that affect design

- The product was renamed from NotebookLM to **Gemini Notebook** on 2026-07-16 (PY `docs/adr/0028-gemini-notebook-rename.md`). The wire protocol did not change.
  - The app shell is on `https://notebook.google.com`. `https://notebooklm.google.com` 302-redirects to it.
  - `batchexecute` is **dual-served** on both hosts.
  - PY defaults to `notebook.google.com` (`src/notebooklm/_env.py`). CLI and TS default to `notebooklm.google.com`.
  - TS notes that some Workspace tenants resolve to `notebook.google.com` (`src/utils/notebook-domain.ts`).
  - Recommendation: make the base host configurable and follow the homepage redirect.
- Enterprise hosts exist (`notebook.cloud.google.com`, with a different RPC service) and are out of scope.
- Everything else here is an undocumented web-app protocol, not an API.

---

## 1. Auth

### 1.1 Cookies (Google browser session)

There is no OAuth or API-key path for the consumer web backend. The session is a Google cookie jar from a signed-in browser. Both the app host and `accounts.google.com` must receive their own cookies.

| Source | Required names | Reference |
|---|---|---|
| PY | **`SID`** and **`__Secure-1PSIDTS`** (hard requirement). Secondary binding is warned about but non-fatal: `OSID`, or (`APISID` + `SAPISID` + `LSID`). | `docs/auth-cookie-lifecycle.md`, `src/notebooklm/_auth/cookie_policy.py` (`MINIMUM_REQUIRED_COOKIES = {"SID","__Secure-1PSIDTS"}`) |
| CLI | `SID`, `HSID`, `SSID`, `APISID`, `SAPISID` | `core/auth.py:438` (`REQUIRED_COOKIES`) |
| TS | same five as CLI as "critical". It also keeps `OSID`, `__Secure-OSID`, `__Secure-1PSID`, `__Secure-3PSID`. | `src/auth/auth-manager.ts:34-42`, `src/startup/startup-manager.ts:425` |

- Practical advice: capture and replay the **entire** Google cookie jar and preserve each cookie's domain and path. PY's `docs/troubleshooting.md` says flattening domains causes `accounts.google.com/CookieMismatch`.
- Allowed domains (PY `_auth/cookie_policy.py`): `.google.com`, the app hosts, `accounts.google.com`, `.googleusercontent.com`, `drive.google.com`, and regional Google ccTLDs.
- Also persist `__Secure-3PSIDTS`.
- Multi-account: PY adds `authuser=<index or email>` to the homepage GET, to batchexecute and chat URLs, and to the upload start URL, plus an `x-goog-authuser` header on uploads (`_auth/account.py::format_authuser_value`). The email is preferred because indices shift.

### 1.2 Page tokens (per session)

`GET {base}/` (or `{base}/?authuser=N`, TS uses `/?hl=en`) with the cookie jar, following redirects, and a real browser User-Agent.

- CLI uses a Chrome UA plus `Accept`, `Accept-Language` and `Sec-Fetch-*` headers (`core/base.py:432`).
- PY's `_auth/account.py` notes that without a browser UA, Google omits the `WIZ_global_data` block on some pages.

Extract from the HTML (`WIZ_global_data` JS object):

| Token | Key | Regex used | Use |
|---|---|---|---|
| CSRF `at` | `SNlM0e` | `"SNlM0e":"([^"]+)"` (CLI `core/auth.py:385`, TS `batchexecute.ts`). PY also accepts single-quoted and HTML-escaped (`&quot;`) forms and an empty value (`_auth/extraction.py::extract_wiz_field`). | POST body `at=` |
| Session id `f.sid` | `FdrFJe` | `"FdrFJe":"([^"]+)"` (PY value is ~19 digits) | URL param `f.sid` |
| Build label `bl` | `cfb2h` | `"cfb2h":"([^"]+)"` (CLI `base.py:1346`, TS `batchexecute.ts`) | URL param `bl` |

PY's build-label pattern: `boq_labs-tailwind-frontend_(\d{8})\.(\d{2})_p(\d+)` (`_env.py::BUILD_LABEL_RE`). Current PY pin: `boq_labs-tailwind-frontend_20260802.02_p0`.

Notes on `bl`:
- **PY omits `bl` from batchexecute URLs entirely.** It sends it only on the chat stream endpoint.
- PY measured on 2026-08-04 that the server does **not validate `bl`**. A fabricated `…_19700101.00_p0` still returned a full cited answer (`_env.py` comment).
- CLI and TS send `bl` on both.
- Safe approach: send the scraped `cfb2h` value, with a fallback constant.

### 1.3 Keep-alive and rotation

- Endpoint: `POST https://accounts.google.com/RotateCookies` (PY `_auth/mint_service.py`, CLI `core/cookie_rotation.py`).
  - Headers: `Content-Type: application/json`, `Origin: https://accounts.google.com`.
  - Body, literally: `[000,"-0000000000000000000"]`.
  - Follow redirects; 15 s timeout.
  - Merge returned `Set-Cookie` values into the jar and persist them.
- Cadence:
  - PY fires it before every token fetch, and optionally on a periodic loop. `keepalive=600` s for long-lived servers, minimum floor 60 s (`_runtime/config.py`). The comment says Google's response advertises a 600 s next-rotation cadence.
  - PY also recommends an external scheduler every 15-20 min for idle profiles (`docs/troubleshooting.md`).
  - Both PY and CLI rate-limit their own calls to once per 60 s per profile.
  - PY's CHANGELOG says plain NotebookLM RPC traffic does **not** trigger rotation, so a keepalive must hit `accounts.google.com`.
- **Conflict:** PY says RotateCookies mints `__Secure-1PSIDTS` and `__Secure-3PSIDTS` (`_auth/psidts_recovery.py`, CHANGELOG ~L1635). CLI says it refreshes only the `*SIDCC` cookies, "does NOT rotate `*PSIDTS` from a plain HTTP client", and that only a headless real-browser pass revives an aged-out PSIDTS (`core/cookie_rotation.py` docstring, issue #316). UNVERIFIED which holds today. Plan for a browser-based re-login fallback.
- Other recovery rungs in PY (not needed for a first client):
  - headless Playwright re-auth;
  - a master-token re-mint via `gpsoauth` (Android Chromecast OAuth app, then MergeSession);
  - an external refresh command.

### 1.4 Lifetime and failure signals

Lifetime is **not deterministic**. The sources disagree and none is a guarantee:
- PY `docs/configuration.md`: "several days to weeks"; "rate limiting or suspicious activity can trigger earlier expiration".
- CLI `docs/KNOWN_ISSUES.md`: "typically 2-4 weeks".
- PY `docs/auth-cookie-lifecycle.md`: in competing-client tests an exported snapshot was superseded within ~10 min and could fail within ~30 min. This applies when two clients share one cookie snapshot.
- **Don't let two consumers actively use copies of one cookie session.** They can sign each other out.
- Don't trust cookie `expires` timestamps as a health check.

Expiry or failure signals to detect:

| Signal | Meaning | Source |
|---|---|---|
| Homepage GET final URL on `accounts.google.com` | cookies expired | PY `_auth/refresh.py::_fetch_tokens_with_jar`, TS, CLI |
| HTTP 200 landing page containing `landing-header-signin`, or no `SNlM0e` | signed-out landing page | CLI `base.py:1305`; PY `_probe_signed_out_session` |
| Redirect hop through `accounts.google.com/CookieMismatch` | cookie scoping problem (valid creds possible) | PY `docs/troubleshooting.md` |
| Redirect to `notebooklm.google/?location=unsupported` or `notebook.google/` | region / anti-abuse gate, see section 4 | PY `docs/troubleshooting.md` |
| RPC HTTP 401/403 | auth expired | TS, PY |
| `wrb.fr` frame with `item[5] = [16, ...]` | gRPC `UNAUTHENTICATED` | CLI `base.py:788`; TS `STATUS_ADVICE[16]` |

Recovery pattern (PY and TS): on an auth failure, re-fetch the homepage for new `SNlM0e`/`FdrFJe`, then retry **once**. Coalesce concurrent refreshes into a single task.

---

## 2. Transport

### 2.1 batchexecute

```
POST {base}/_/LabsTailwindUi/data/batchexecute
     ?rpcids={rpcId}&source-path={path}&f.sid={FdrFJe}&hl=en&rt=c[&bl={cfb2h}][&authuser={n|email}]
Content-Type: application/x-www-form-urlencoded;charset=UTF-8
Cookie: <jar>
body: f.req=<urlencode([[[rpcId, JSON.stringify(params), null, "generic"]]])>&at=<urlencode(SNlM0e)>&
```

- `source-path` is `/` for account-level calls and `/notebook/{notebookId}` for notebook-scoped calls. Several RPCs carry the notebook id **only** in `source-path`, not in params (see section 3).
- JSON is compact (`separators=(",",":")`). Encode with `encodeURIComponent` semantics (`quote(safe='')`). A trailing `&` is sent.
- One RPC per request is what all three clients do.
- PY batchexecute sends only `Content-Type` plus cookies (`_web/transport/kernel.py:155`). TS additionally sends `Origin`, `Referer: {base}/`, `X-Same-Domain: 1`, `X-Goog-Csrf-Token: <at>` and a Chrome UA. Whether those are required is UNVERIFIED (PY works without them).
- Sources: PY `_web/wire/encoder.py`, `_web/transport/executor.py::build_url` (L606-628); CLI `core/base.py::_build_url`; TS `src/rpc/batchexecute.ts::callOnce`.

### 2.2 Response parsing

1. Strip the anti-XSSI prefix `)]}'` plus the newline (`\r?\n`) (PY `strip_anti_xssi`).
2. The rest is lines. Normally a decimal byte/length count line, then one JSON line, repeated. **Don't validate the counts.** PY found they mismatch on healthy live streams, probably because they count UTF-16 code units. A robust approach (TS) is to skip non-JSON lines and `JSON.parse` any line starting with `[`.
3. Each chunk is an array of envelopes. Envelope kinds:
   - `["wrb.fr", rpcId, "<json-string>", null, null, <status|null>, "generic"]`
   - `["di", n]`, `["af.httprm", ...]`, `["e", seq, ...]` (bookkeeping, ignore)
   - `["er", rpcId, code]` (RPC error)
4. Result = `JSON.parse(envelope[2])`. If an RPC emits several `wrb.fr` frames, take the **last non-null** one (PY `extract_rpc_result`).
5. If `envelope[2]` is null:
   - `envelope[5]` = `[grpcCode, ...]` is a `google.rpc.Status`. Code 3 = INVALID_ARGUMENT, 5 = NOT_FOUND, 7 = PERMISSION_DENIED, 8 = RESOURCE_EXHAUSTED, 16 = UNAUTHENTICATED (PY `_types/enums.py::GrpcStatusCode`; TS `GRPC_STATUS`).
   - If `envelope[5]` contains a `UserDisplayableError` detail (`type.googleapis.com/...UserDisplayableError`), PY maps it to a **rate-limit/quota** error (`extract_rpc_result`). CLI maps code 8 to `ResourceExhaustedError`.
   - A present-but-null frame with no error status is a legitimate empty result for some RPCs (e.g. `REMOVE_RECENTLY_VIEWED`, `DELETE_*`).
6. HTTP 429 maps to a rate-limit error (honor `Retry-After`). HTTP 5xx is a server error.

### 2.3 Streaming chat endpoint (not batchexecute)

```
POST {base}/_/LabsTailwindUi/data/google.internal.labs.tailwind.orchestration.v1.LabsTailwindOrchestrationService/GenerateFreeFormStreamed
     ?bl={bl}&hl=en&_reqid={n}&rt=c[&f.sid={FdrFJe}][&authuser=...]
body: f.req=<urlencode([null, JSON.stringify(params)])>&at=<csrf>&
```

- `_reqid` is a monotonically increasing integer. PY: baseline 100000, +100000 per request (`_web/transport/reqid_counter.py`). TS starts at `100000 + Date.now()%800000` and adds 100000 each time.
- TS also sends `X-Same-Domain: 1` and `X-Goog-Csrf-Token`. PY doesn't.
- The response is the same `)]}'` + length/JSON-line format. PY and TS read the whole body, then parse. It is not consumed incrementally.
- Details are in section 3.3.

---

## 3. RPC IDs and shapes

All `params` below are JSON arrays. `W` denotes the shared "request-options wrapper":

`W = [2, null, null, [1, null,null,null,null,null,null,null,null,null, [1]]]` (PY `_web/params/sources.py::build_template_block`)

`CA = [2, null, null, [1,null×9,[1]], [[1,4,8,2,3,6]]]` is the **CREATE_ARTIFACT / LIST_ARTIFACTS options block** (PY `_web/params/artifacts.py:57`).

**Wrapper drift to be aware of** (PY CHANGELOG 0.7.2 and 0.8.0): Google migrated several payloads from the old short tails (`[2]` plus separate `[1,…,[1]]`) to `W` or `CA`.
- Un-migrated and migrated accounts both accept `W` for create-notebook and add-URL (PY says "verified live").
- **Video generation with the old `[2]` first param is created and then immediately marked failed** on some accounts. Use `CA`.
- CLI and TS still send the old short forms in places, so treat those as potentially stale.
- GET_NOTEBOOK and the other read paths accept both `[2]` and `W`, per PY docs and TS.

### 3.1 Notebooks

| Op | RPC id | source-path | params | Response / notes |
|---|---|---|---|---|
| List | `wXbhsf` | `/` | `[null,1,null,[2]]` (accepted); UI sends `[null,1,null,[2,null,null,[1,…,[1]]],null,[[null,null,[]],[[]],[null,[]]]]` | `result[0]` = rows. Row: `[0]` title, `[2]` notebook id (uuid), `[3]` emoji, `[5]` metadata (`[5][0]` role 1 owner/2 editor/3 viewer, `[5][5][0]` last-viewed secs, `[5][8][0]` created secs). Ordered most-recently-viewed first (live RPC is `ListRecentlyViewedProjects`). Titles may contain a `"thought\n"` prefix that PY strips. Source: PY `_web/rows/notebooks.py::decode_notebook`, TS `notebooks-rpc.ts`. |
| Create | `CCqFvf` | `/` | PY: `[title,null,null,W]`. CLI/TS older: `[title,null,null,[2],[1,null×9,[1]]]` | Response row; **id at `result[2]`**. `result[11]` = chat sessions `[[chatSessionId]]`. |
| Rename | `s0tc2d` | `/notebook/{id}` | `[notebookId, [[null,null,null,[null,newTitle]]]]` | The same RPC is the generic notebook mutator (chat config at `[[null×7, chatSettings]]`, share access). PY `_web/notebooks.py`, TS `renameNotebook`. |
| Get (+ sources) | `rLM1Ne` | `/notebook/{id}` | PY: `[notebookId,null,W,null,0]`; TS/CLI: `[notebookId,null,[2],null,0]` | `result[0]` = notebook row; **`result[0][1]` = sources list** (null for an empty notebook). Chat settings at `result[0][7]` = `[[goal,prompt?],[length]]`. |
| Delete | `WWINqb` | `/` | `[[notebookId],[2]]` | Single id only. |
| Copy | `te3DCe` | `/` | `[W, sourceNotebookId, newTitle]` | |
| Remove from recents | `fejl7e` | `/` | `[notebookId]` | Response null (OK). |
| Summary + suggested questions | `VfAZjd` | `/notebook/{id}` | `[notebookId,[2]]` | `result[0][0][0]` summary text; `result[0][1][0]` = `[[question,prompt],...]`. Null on a source-less notebook. |

### 3.2 Sources

Source row (from GET_NOTEBOOK `result[0][1][i]`; PY `_web/rows/sources.py::SourceRow`):
- `[0]` id envelope (typically `["<uuid>"]`; Drive-backed can be `[null,true,["<uuid>"]]`).
- `[1]` title.
- `[2]` metadata:
  - `[2][1]` word/size count;
  - `[2][2][0]` creation secs;
  - `[2][4]` **type code**;
  - `[2][5][0]` YouTube URL;
  - `[2][7][0]` URL.
- `[3]` settings: **`[3][1]` = ingestion status** (-1 unknown, 1 processing, 2 ready, 3 error, 5 preparing; `_types/enums.py::SourceStatus`).
- `[5]` direct download URL for uploaded files.

Type codes: 1 Google Docs, 2 Slides, 3 PDF, 4 pasted text, 5 web page, 6 PPTX, 7 Google Sheet, 8 Markdown, 9 YouTube, 10 audio/video media, 11 DOCX, 13 image, 14 generic Drive, 16 CSV, 17 EPUB, 18 Gemini chat, 20 Play Books (`docs/rpc-reference.md`, "Source Type Codes").

Poll sources by re-listing via GET_NOTEBOOK until `status == 2`. PY's defaults are `initial_interval=1.0`, `max_interval=10.0`, backoff 1.5, `timeout=120`. A file or audio source can report `ERROR` briefly while it is being processed.

**ADD_SOURCE `izAoDd`**, source-path `/notebook/{id}`:

| Kind | params | Notes |
|---|---|---|
| URL | `[[[null,null,[url],null,null,null,null,null,null,null,1]], notebookId, W]` | URL at spec index 2. Multiple specs in the first array = batch (per-item, not atomic). |
| YouTube | `[[[null,null,null,null,null,null,null,[url],null,null,1]], notebookId, W]` | URL at spec index 7. TS/CLI pick this when the URL matches `youtube.com\|youtu.be`. |
| Pasted text | `[[[null,[title,content],null,2,null,null,null,null,null,null,1]], notebookId, W]` | `[3]=2` is the text type. |
| Google Drive | `[[[ [fileId,mimeType,1,title], null×4, null×4, 1 ]], notebookId, [2], [1,null×9,[1]]]` | PY says this variant is still on the older tail, pending a fresh live capture. Drive mime types: `application/vnd.google-apps.document\|presentation\|spreadsheet`, `application/pdf`. |

- Response: `result[0][0]` = `[[sourceId], title, ...]` (parse as in TS `parseSourceResult`). Treat it as unconfirmed until the source reaches ready.
- **Alternative URL RPC `ozz5Z`** (CLI `core/sources.py`, TS): the params are `[[[ [null,url,627], [null×9,[null,null,1]], 1 ]]]` and the notebook goes only in source-path. CLI/TS try `izAoDd` first and fall back to `ozz5Z`. CLI notes `ozz5Z` is dual-mapped (it also returns the subscription tier for homepage params). PY does not use it. UNVERIFIED whether it is needed now.
- Other source RPCs:
  - **Delete** `tGMBJ`: PY `[[[sourceId]]]` with source-path; TS `[[[sourceId]],[2]]`.
  - **Rename** `b7Wfje`: `[null,[sourceId],[[[newTitle]]]]`.
  - **Freshness** `yR9Yof`: `[null,[sourceId],[2]]`.
  - **Refresh** `FLmJqe`.
  - **Search passages** `ASU5Oe`: `[notebookId, query, null, [1], [[[sid],…]]?]`.
  - **Async add** `X1snv`: `[urlSpecs, notebookId, W]`.

**File upload (two-step, Scotty resumable)** (PY `_web/params/sources.py`, `_web/sources/upload.py`):
1. `o4cbdc` via batchexecute, source-path `/notebook/{id}`, params `[[filename]]` doubly wrapped: `[[[filename]], notebookId, W]`. The response contains the new **SOURCE_ID** (uuid; found in a nested singleton envelope such as `[[id]]` or `[[[[id]]]]`). PY sends this mutation once, without retry.
2. Start the resumable session: `POST {base}/upload/_/?authuser=N` (PY `get_upload_url()`), cookies attached.
   - Headers:
     ```
     Accept: */*
     Content-Type: application/x-www-form-urlencoded;charset=UTF-8
     Origin: {base}
     Referer: {base}/
     x-goog-authuser: N-or-email
     x-goog-upload-command: start
     x-goog-upload-header-content-length: <bytes>
     x-goog-upload-header-content-type: <mime>
     x-goog-upload-protocol: resumable
     ```
   - Body: `{"PROJECT_ID":"<nb>","SOURCE_NAME":"<filename>","SOURCE_ID":"<id from step 1>"}`.
   - The response header **`x-goog-upload-url`** is the session URL. PY validates it is https, on the same upload endpoint host, with no credentials.
3. `POST` the bytes to that URL with `Content-Type: application/x-www-form-urlencoded;charset=utf-8`, `x-goog-authuser`, `Origin`, `Referer`, `x-goog-upload-command: upload, finalize`, `x-goog-upload-offset: 0` (streaming body).
4. Best-effort cancel: same URL with `x-goog-upload-command: cancel`.
5. Then poll the source status as above.
- UNVERIFIED: whether `/upload/_/` is served on `notebook.google.com`. PY's ADR-0028 says the rebrand host's Scotty path was never probed, yet PY's default host is `notebook.google.com`.
- Supported extensions per CLI `core/constants.py::SUPPORTED_FILE_EXTENSIONS`: pdf, txt, md, docx, csv, pptx, epub, common image types, and audio/video types (mp3, wav, m4a, mp4, …).

**Source text and summary**

| Op | RPC | params | Response |
|---|---|---|---|
| Full text | `hizoJc`, source-path `/notebook/{id}` | `[[sourceId],[2],[2]]` (plain text); `[[sourceId],[3],[3]]` (HTML) | `result[0]` descriptor (`[1]` title); text = structured doc tree at `result[3][0]` (flatten strings, TS `collectStrings`); HTML string at `result[4][1]`. A bare `[sourceId]` returns metadata only. |
| Source guide (summary + keywords) | `tr032e` | `[[[[sourceId]]]]` (4-nested) | `result[0][0][1][0]` summary; `result[0][0][2][0]` keyword list. |

### 3.3 Chat (ask with citations)

Request `params` (PY `_web/params/chat_stream.py`):
```
[ [[[sid1]],[[sid2]],...],   // 0 sources, each double-wrapped
  question,                  // 1
  history | null,            // 2: [[answer,null,2],[question,null,1],...] per prior turn (newest pair first); null on a new thread
  [2, null, [1], [1]],       // 3 fixed
  conversationId | null,     // 4: null = server uses the notebook's current conversation, creating one
  null, null,                // 5, 6
  notebookId,                // 7
  1 ]                        // 8
```
- TS sends the minimal 5-element form `[sources, question, null, [2,null,[1]], conversationId]` with a client-generated UUID as `conversationId`. It is single-turn only and works as of its release. UNVERIFIED which form is more robust.
- The conversation id is resolved afterwards via `GET_LAST_CONVERSATION_ID` `hPTbtc`:
  - params `[[], null, notebookId, 1]` or `[W, null, notebookId, 20]`;
  - response `[[[convId]]]`.
- `AnswerRow[2][0]` in a chunk is a per-stream identifier and is **not** a reliable conversation id (PY `docs/rpc-reference.md` on `answer_row[2]`).
- Other chat RPCs:
  - **History** `khqZz`: `[[],null,null,convId,limit]`. Turns newest-first; `turn[2]` 1 = user (text `turn[3]`), 2 = assistant (text `turn[4][0][0]`).
  - **Delete history** `J7Gthc`: `[[],convId,null,1]`.
  - **Status** `oXwmh`: `[null,convId]` returns `[null,1]` idle or `[token,2]` generating.
  - **Cancel** `XgrPMd`: `[null,convId]`.
  - **Suggested prompts** `otmP3b`.
  - **Chat config** via `s0tc2d`: goal 1 default / 2 custom `[2,prompt]` / 3 learning guide; length 1 default / 4 longer / 5 shorter.

Response parsing (PY `_web/rows/chat.py`, `_web/rows/chat_stream.py`; TS `query-rpc.ts`):
- Frames are `wrb.fr` with `item[2]` = JSON string `inner`. **Chunks are cumulative**: each carries the answer so far, so don't concatenate.
- `inner[0]` = answer row:
  - `[0]` answer text. Citations appear as literal `[N]` markers in it.
  - `[2][0]` session id, `[2][1]` per-turn id.
  - `[4]` = TailwindDoc:
    - `[4][3]` = citation list;
    - last element, `[4][4]` in PY, equal to `1` marks "this is an answer chunk" rather than thinking text.
- `inner[4]` = **`isFinalResponse`** (true on exactly the last chunk); `inner[5][0]` = next-step suggested questions.
- Selection: pick the chunk with `isFinalResponse` and answer text. Fallback is the longest answer chunk (PY logs a warning). TS uses longest-wins only.
- Citation `[N]` refers to the raw 1-based position in `[4][3]`. Don't re-densify after skipping malformed rows.
- Each citation `cite`:
  - `cite[0][0]` chunk id;
  - `cite[1][2]` relevance score;
  - `cite[1][3]` = `[[null,start,end]]` source-side char range (UTF-16 units);
  - `cite[1][4][0]` fragment elements (the cited text; concatenate their text leaves);
  - **`cite[1][5]` nested source-id structure**. The uuid is found at `[5][0][0][0]` in TS, and PY walks the nested lists for the uuid string.
- Errors:
  - A `wrb.fr` frame with `item[2]=null` and `item[5]=[code,…]`: code 3 seen when rejected; TS maps this to `QueryRejectedError`.
  - **Chat quota exhausted** on web looks like only bookkeeping frames plus a terminal `["e", seq, …]` and **no `wrb.fr` payload at all**. PY raises a rate-limit error for it.

### 3.4 Studio artifacts

Create: **`R7cb6c`**, source-path `/notebook/{nb}`.
- Params: `[CA, notebookId, content]`. `content` is a sparse array with `content[2]` = type code, `content[3]` = sources `[[[sid]],…]` (triple wrapped), and the config at a type-specific index.
- `ids2 = [[sid],…]` (double wrapped) is used inside configs.
- Kickoff response: `result[0]` = `[artifactId, title, typeCode, null, status, …]`.
  - The id is at `[0][0]`, the status at `[0][4]` (1 = pending).
- A source-less notebook gives INVALID_ARGUMENT (status 3). A rate limit or quota gives a null result with a `UserDisplayableError`.

| Type code | Artifact | Config index in `content` |
|---|---|---|
| 1 | Audio overview | `[6]` |
| 2 | Report | `[7]` |
| 3 | Video overview | `[8]` |
| 4 | Quiz or flashcards (variant in options) or interactive mind map | `[9]` |
| 5 | Mind map (note-backed, legacy) | not via `R7cb6c` |
| 6 | Fantasy map | n/a |
| 7 | Infographic | `[14]` |
| 8 | Slide deck | `[16]` |
| 9 | Data table | `[18]` |
| 10 | File (e.g. XLSX export of a data table) | n/a |

**Audio overview** (type 1):
```
content[6] = [null, [ focusPrompt|null, lengthCode, null, ids2, language, null, formatCode ]]
```
- `formatCode`: 1 deep dive, 2 brief, 3 critique, 4 debate.
- `lengthCode`: 1 short, 2 default, 3 long.
- `language`: BCP-47-ish string, e.g. `"en"`.
- A focus or custom prompt is the first element; CLI and TS pass `""` when unset, PY passes `None`.

**Video overview** (type 3):
```
content[8] = [null, null, [ ids2, language, focusPrompt, null, formatCode, styleCode, (stylePrompt) ]]
```
- `formatCode`: 1 explainer, 2 brief, 3 cinematic, 4 short.
  - **Cinematic** omits `styleCode`: `[ids2, language, prompt, null, 3]`. It needs a Google AI Ultra subscription and has its own daily quota.
  - **Short** (vertical): CLI sends `[ids2, null, prompt, null, 4, null, null, 1]` (language slot null, trailing `1` of unknown meaning). Cross-checked against PY only for the format code. UNVERIFIED detail beyond CLI.
- `styleCode` (explainer and brief only), **PY's live-captured values (2026-06-17)**:
  - `1` auto-select;
  - `0` custom, sent as **`null`** with the custom visual-style prompt appended as the 7th element;
  - `2` classic, `3` whiteboard, `4` heritage, `5` paper-craft, `6` watercolor, `7` anime, `8` retro-print, `9` kawaii.
- **Conflict:** CLI's `constants.py` uses a different map (1 auto, 2 custom, 3 classic, 4 whiteboard, 5 kawaii, 6 anime, 7 watercolor, 8 retro, 9 heritage, 10 paper-craft). PY's CHANGELOG 0.7.2 states the older numeric values it used were wrong and "serialized as the wrong style on the wire", then corrected them to live Web-UI captures. **Treat PY's table as authoritative**; CLI's looks stale.
- Use `CA` as the first param for video. The short `[2]` fails on some accounts (PY CHANGELOG 0.7.2).

**Other types** (all `content[2]`=code, `content[3]`=sources; PY `docs/rpc-reference.md`):
- Report (2): `content[7] = [null, [title, description, null, ids2, language, prompt, null, true]]`. Presets are "Briefing Doc", "Study Guide", "Blog Post", or custom text.
- Quiz (4): `content[9] = [null, [2, null, instructions, null, null, null, null, [quantity, difficulty]]]`.
- Flashcards (4): `content[9] = [null, [1, null, instructions, null, null, null, [quantity, difficulty]]]`.
  - quantity 1 fewer, 2 standard, 3 more;
  - difficulty 1 easy, 2 medium, 3 hard.
- Interactive mind map (4, variant 4): `content[9] = [null, [4]]`, or `[null,[4,null,"prompt"]]`.
- Infographic (7): `content[14] = [[instructions, language, null, orientation, detail, style]]`.
  - orientation 1 landscape, 2 portrait, 3 square;
  - detail 1 concise, 2 standard, 3 detailed;
  - style 1 auto, 2 sketch-note, 3 professional, 4 bento-grid, 5 editorial, 6 instructional, 7 bricks, 8 clay, 9 anime, 10 kawaii, 11 scientific.
- Slide deck (8): `content[16] = [[instructions, language, format, length]]`. format 1 detailed deck, 2 presenter slides; length 1 default, 2 short.
- Data table (9): `content[18] = [null, [instructions, language]]`.
- Legacy mind map (5): RPC `yyryJe` with params `[ [[[sid]],…], null,null,null,null, ["interactive_mindmap", [["[CONTEXT]", instructions]], language], null, [2,null,[1]] ]`. Returns JSON that is then saved as a note (`CYK0Xb` + `cYAfTb`).
- Retry a failed artifact: `Rytqqe`. Delete artifact: `V5N4be` with `[[2], artifactId]` (single id only). Rename: `rc3d8d`.

**List / poll**: `gArtLc`, source-path `/notebook/{nb}`.
- Params: `[[2], notebookId, 'NOT artifact.status = "ARTIFACT_STATUS_SUGGESTED"']`. The richer form puts `CA` instead of `[2]`. Both are accepted.
- Response: `result[0]` = rows (or a flat list). Row positions (PY `_web/rows/artifacts.py::ArtifactRow`):
  - `[0]` id, `[1]` title, `[2]` type code;
  - `[3]` source refs;
  - **`[4]` status**;
  - `[6]` audio block, `[7]` report markdown, `[8]` video block;
  - `[9]` options block (`[9][1][0]` variant, `[9][1][2]` prompt);
  - `[10]` last-modified `[sec,nanos]`;
  - `[14]` infographic, `[15][0]` created secs, `[16]` slide deck, `[18]` data table, `[21]` etag.

**Status codes** (`[4]`; PY `_types/enums.py::ArtifactStatus`):

| Code | Backend name | Meaning |
|---|---|---|
| 0 | UNKNOWN | |
| 1 | INITIALIZED | queued, worker not started |
| 2 | PROCESSING | generating |
| 3 | READY | complete |
| 4 | FAILED | |
| 5 | SUGGESTED | filtered out by the list filter |
| 6 | PENDING_REVIEW | semantics unconfirmed |
| 7 | SCHEDULED | deferred generation (`later`) |

- PY says codes 1 and 2 were **transposed** in its own client before #2127. TS and CLI still describe "1 = in progress". Treat 1 and 2 both as "not done", 3 as done, 4 as failed.
- Also require that the media URL is populated before treating audio/video/infographic/slides as complete (PY `ArtifactRow.is_media_ready`).
- Polling cadence in PY: `initial_interval=2s`, `max_interval=10s`, default timeout 300 s. PY's CLI budgets are audio 1200 s, video 1800 s, cinematic 3600 s. "Can take minutes to 30+ minutes" (`docs/cli-reference.md`).
- Timeouts don't prove failure. Keep polling by the same artifact id. Don't substitute a completed sibling.

**Download URLs** (PY `_web/rows/artifacts.py`, `_artifact/downloads.py`, `_artifact/_download_client.py`):

| Artifact | Where | Notes |
|---|---|---|
| Audio | `row[6][5]` = list of `[url, kind, mime]`. Pick `mime == "audio/mp4"` (m4a); TS prefers the URL ending `-dv`. Duration `row[6][6]` = `[sec,nanos]`. | |
| Video | `row[8][4]` = list of `[url, kind, mime]`; kind 1 progressive, 2 HLS, 3 DASH, **4 download**. Prefer `video/mp4` with kind 4. Duration `row[8][5]`. | CLI/TS read an older string at `row[8][3]`. Treat as stale. |
| Infographic | `row[14][2][0][1][0]` (image URL) | |
| Slide deck | `row[16][3]` PDF, `row[16][4]` PPTX | |
| Report | markdown at `row[7]` (`[7][1][0]` in TS/CLI) | |
| Quiz/flashcards HTML | `GET_INTERACTIVE_HTML` `v9rmvd` with params `[artifactId]` (source-path `/notebook/{nb}`); HTML at `result[0][9][0]`. Interactive mind-map tree JSON at `[0][9][3]`. | |
| Data table | parsed from `row[18]` rich text | |

- **Downloads require the Google cookie jar** (no bearer token). PY sends the jar only to trusted hosts (`*.google.com`, `*.googleusercontent.com`, `*.googleapis.com`) on every redirect hop.
- Media URLs 302 from google.com to googleusercontent.com. **Node `fetch` drops `Cookie` on cross-origin redirects**, so TS follows redirects manually and re-adds the cookies on each hop (`BatchExecuteClient.fetchBinary`, up to 6 hops).
- Treat a `text/html` response or a 0-byte body as an expired-auth or missing-file failure (PY `_reject_html_download`).
- Audio arrives as an `audio/mp4` (m4a) file.

### 3.5 Other RPC IDs

All of these come from PY `src/notebooklm/rpc/_identifiers.py`.

| Group | IDs |
|---|---|
| Research | `Es3dTe` discover, `Ljjv0c` fast, `QA9ei` deep, `e3bVqc` poll, `LBwxtb` import, `Zbrupe` cancel |
| Notes | `CYK0Xb` create, `cYAfTb` update, `AH0mwd` delete, `cFji9` list notes + mind maps |
| Labels | `agX4Bc`, `I3xc3c`, `le8sX`, `GyzE7e` |
| Sharing | `QDyure` set visibility, `JFMDGd` status, `RGP97b` share artifact |
| Export | `Krh3pd` export to Docs/Sheets (`[null, artifactId, null, title, 1\|2]`: 1 Docs, 2 Sheets) |
| Settings / account | `ZwVcOc` get, `hT54vc` set (output language), `SatQRc` GetAccount, `EylDcb` ListQuotaSummary |
| Misc | `ciyUvf` suggested reports, `sqTeoe` customization choices, `KmcKPe` revise slide, `OcvKNc` next steps |

---

## 4. Rate limits, quotas, and anti-automation

**Published per-plan limits** (PY `docs/quota-limits.md`, captured from Google's help pages on **2026-07-09**; every Google table is headed "subject to change"):

| Feature | Standard / free | Plus | Pro | Ultra 20TB | Ultra 30TB |
|---|---|---|---|---|---|
| Notebooks | 100 | 200 | 500 | 500 | 500 |
| Sources per notebook | 50 | 100 | 300 | 500 | 600 |
| Chats / day | 50 | 200 | 500 | 2,500 | 5,000 |
| **Audio overviews / day** | **3** | 6 | 20 | 100 | 200 |
| **Video overviews / day** | **3** | 6 | 20 | 100 | 200 |
| Cinematic video / day | no | no | 2 | 10 | 20 |
| Reports, flashcards, quizzes, mind maps / day (each) | 10 | 20 | 100 | 500 | 1,000 |
| Deep research | 10 / month | 3/day | 20/day | 75/day | 200/day |
| Infographic, slide deck, data table | "Limited" (infographic ≈ 3/day observed, unofficial) | "More" | "High" | "Higher" | "Highest" |

- The account's tier is readable from `GET_USER_SETTINGS` (`ZwVcOc`) `limits[4]`: 1 standard, 2 pro, 4 plus, 3 ultra-20TB, 6 ultra-30TB, 5 workspace-expanded. `limits[1]` = notebook limit, `limits[2]` = source limit.
- Counting semantics (PY `quota-limits.md`):
  - Daily quotas are **rolling 24 h** windows from first use, not midnight.
  - Auto-generated first-add artifacts don't count.
  - Notebook caps are per-user; source caps are per-notebook.
- **A newer compute-based meter exists.** TS troubleshooting says allowance has been compute-based since **2 Sep 2026**. It uses a rolling ~5-hour window plus a weekly cap, scaled by plan, with the message "NotebookLM usage limit reached (compute-based, refreshes every 5 hours)". PY ADR-0037 and CLI README agree.
  - It is read with `ListQuotaSummary` `EylDcb`, gated by `GetAccount` `SatQRc` field `5.7` (`computeMeteringEnabled`).
  - PY observed it enabled only on certain cohorts (a free test profile from 2026-09-04).
  - Action codes: 1 audio overview, 2 video overview, 3 breakdowns video, 4 shorts video, 5 infographic, 6 slides, 7 reports, 8 tables, 9 flashcards, 10 quiz, 11 mind map, 15 deep research, 17 fast research, 18 Q&A, …
  - UNVERIFIED how the old per-day counts and the meter interact today. Whether free audio overviews are still "3/day" is UNVERIFIED.
- Older figures in TS/CLI docs ("~50 chat queries/day free") are the pre-meter numbers.
- Quota failures on the wire:
  - batchexecute: null result plus a `UserDisplayableError`, or status `[8]` (RESOURCE_EXHAUSTED), or `[3]`;
  - HTTP 429 with `Retry-After`;
  - chat: terminal frame with no `wrb.fr` payload.
- PY's mitigations: `rate_limit_max_retries=3`, `max_concurrent_rpcs=16`, and an exponential backoff retry for generation. CLI also advises "wait 1-2 min after a Studio rate limit, create videos sequentially, avoid tight polling loops".
- Ambiguity: `[3]` / INVALID_ARGUMENT can mean quota, notebook-limit, rate limiting, **or a wrong payload shape** (PY `docs/troubleshooting.md`). CLI notes code 3 on source-add can mean "accepted for async processing", so it reconciles against the source list before retrying (avoids double add).

**Account flagging / anti-automation** (documentation only, since issue threads were unreadable):
- No source documents an account ban or suspension for API-style use. Everything below is the extent of what is documented.
- PY docs describe a **region / anti-abuse access gate**: a redirect to `notebooklm.google/?location=unsupported`. Reported triggers are VPN/datacenter/shared IPs, IP vs timezone/language mismatch, or a non-browser fingerprint. PY offers an opt-in `curl_cffi` browser-TLS-impersonation transport (`NOTEBOOKLM_TRANSPORT=curl_cffi`, issue #1630) as the remedy for fingerprint gating. Advice: use a residential IP in a supported region.
- Google blocks automated **login** ("This browser or app may not be secure" in automated Playwright). PY's workaround is attaching over CDP to the user's real Chrome or a persistent profile (`docs/configuration.md`: "Google blocks automated login attempts").
- PY says rate limiting or suspicious activity can trigger early session expiry.
- CLI README: "May not be aligned with Google's Terms of Service. Use at your own risk."
- TS README and disclaimer: "use a dedicated Google account for automation"; "can't guarantee Google won't detect or flag automated usage".
- PY on 2025-11-25: Infographics and Slide Decks were temporarily rolled back to 0 for free users, and Pro got extra limits. This was a server-side change that the published tables didn't reflect.

---

## 5. Breakage detection and handling when Google changes RPC ids

- **Detection in the client**
  - PY `decode_response`:
    - Frames present but none for the requested id raises `UnknownRPCMethodError` carrying `found_ids`. That is the "id rotated" signal (always raised, even with `allow_null`).
    - No RPC frames at all (an anti-bot or redirect HTML page) raises a plain `RPCError`.
    - `safe_index` raises `UnknownRPCMethodError` on any positional shape drift (strict mode only).
  - TS: `RpcDriftError` when no envelope matches the id. It is **distinct from `RpcStatusError`**: a refusal (an envelope with a gRPC status) must not be reported as "id rotated" (TS CHANGELOG "refused, not rotated" fix). CLI has `RPCDriftError(rpc_id, present)`.
- **Runtime hot-patch**: all three support the env var **`NOTEBOOKLM_RPC_OVERRIDES`**, a JSON map of method name to new id (PY `_web/wire/overrides.py`; TS `rpc-ids.ts::resolveRpcId`; CLI `base.py`). `NOTEBOOKLM_BL` overrides the build label. PY only honors overrides on allowlisted Google hosts.
- **Proactive monitoring (PY)**:
  - `scripts/capture_rpc_registry.py` downloads the authenticated web JS bundle and parses registrations of the form `new _.<helper>("<rpcid>", RespCtor, ReqCtor, [flags, "/Service.Method"])`. It diffs them against the hard-coded ids and reports CONFIRMED, ABSENT (rotation alarm), PRESENT-UNPARSED, LAZY-MODULE (e.g. `ASU5Oe`), and UNMAPPED. It also checks studio enum maps in the bundle.
  - `scripts/check_rpc_health.py` runs nightly. It calls read-only RPCs and exits 1 on a mismatched id, 2 on auth failure, 3 on a non-transient error, 4 on studio option-table drift, and 5 on a stale `bl` (>90 days behind served). Rate limits and ReadTimeouts are filtered out as transient. A bundle-drift monitor files issues labelled `rpc-breakage`.
  - Studio option tables are readable at runtime via `GET_CUSTOMIZATION_CHOICES` `sqTeoe`.
- **Wire-shape drift** is more common than id rotation. Examples: the `W` and `CA` wrapper migrations, status codes 1/2 transposed, video style codes wrong, `ozz5Z` dual-mapped, the Gemini-3.5 rollout, and the `bl` constant going 5 months stale. Mitigations seen: golden payload tests, VCR cassettes (PY), "shape-only" matching, and fallback chains (try the new shape, fall back on INVALID_ARGUMENT, cache the winner; CLI/TS do this for `ozz5Z`).
- Mutating calls are **non-idempotent**. PY disables transport retries for create/add/register because a timeout leaves the committed subset unknown, then reconciles by listing.

---

## 6. Summary of UNVERIFIED / conflicting items

1. Whether `Origin`/`Referer`/`X-Same-Domain`/`X-Goog-Csrf-Token` are required (PY omits them; TS sends them).
2. Whether `bl` is needed on batchexecute (PY omits it; the chat endpoint accepts any value per PY's 2026-08-04 test).
3. Whether RotateCookies refreshes PSIDTS from a non-browser client (PY says yes; CLI says no).
4. Session lifetime (days to 4 weeks, versus 10-30 min when contested by a second client).
5. Which cookies are strictly necessary (PY: `SID` + `__Secure-1PSIDTS`; CLI/TS: five cookies). Send the whole jar.
6. Whether the short `[2]` options block is still accepted for audio, and the old short tails for create/add (PY says migrated cohorts reject them; TS/CLI still use them; video definitely needs `CA`).
7. Video style code table: PY's live-captured table vs CLI's. PY's is treated as correct.
8. Short-video (format 4) payload beyond what CLI sends.
9. Whether `/upload/_/` is served on `notebook.google.com`. PY says never probed.
10. Whether `ozz5Z` is still needed as a URL-add fallback.
11. Free-tier daily quota figures after the 2026-09-02 compute-metering change.
12. Any account suspension or flagging reports: issue threads could not be read (proxy blocks the GitHub issues/search API), and none appear in the READMEs or docs read.
13. Exact conversation-id semantics for continuing a chat thread (TS sends a random UUID; PY sends null and resolves via `hPTbtc`).
14. The exact shape of the `o4cbdc` registration response (PY has a multi-shape extractor).
