// Minimal PostgREST (Supabase REST) emulator for production-mode QA. node:http only, no dependencies.
//
// It implements exactly what the app's adapters call through @supabase/supabase-js / postgrest-js 2.x:
//   GET    select (select=*, eq/neq/gt/gte/lt/lte/is/in/like/ilike filters, order, limit, offset, Prefer count=exact)
//   POST   insert (+ Prefer return=representation|minimal) and upsert (on_conflict + resolution=merge-duplicates|ignore-duplicates)
//   PATCH  update with filters (representation or 204)
//   DELETE with filters
//   Accept: application/vnd.pgrst.object+json  (single-object mode, 406 PGRST116 on 0 / many rows)
// Tables mirror supabase/migrations/0001..0003 (types, defaults, NOT NULL, CHECK, PK, FK with cascade / set null, identity).
// Errors use the PostgREST JSON shape {code,message,details,hint} with PostgREST/Postgres status codes
// (409 / 23505 unique, 409 / 23503 FK, 400 / 23502 not null, 400 / 23514 check, 400 / 22P02 bad uuid/bool/int, 406 / PGRST116 ...).
// Like Supabase: apikey header required, pg-safeupdate (PATCH/DELETE without a filter -> 400 21000), max-rows 1000.
//
// Usage:  FAKE_SB_PORT=3410 FAKE_SB_KEY=<service key> [FAKE_SB_ANON_KEY=<anon key>] node docs/qa/fake-supabase.mjs
// QA endpoints (not part of PostgREST; under /__qa/):  GET /__qa/tables, GET /__qa/log, POST /__qa/reset,
//   POST /__qa/fault {table?,method?,status,times}  -> next matching requests fail with that HTTP status (storage outage test).
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.FAKE_SB_PORT ?? 3410);
const SERVICE_KEY = process.env.FAKE_SB_KEY ?? "fake-service-role-key";
const ANON_KEY = process.env.FAKE_SB_ANON_KEY ?? "";
const MAX_ROWS = 1000;

// ---- schema (mirrors the migrations) ----------------------------------------------------------
const col = (t, o = {}) => ({ t, ...o });
const SCHEMA = {
  accounts: {
    cols: {
      id: col("uuid", { nn: true, def: "uuid" }),
      label: col("text", { nn: true, check: (r) => r.label.length >= 1 && r.label.length <= 60, checkName: "accounts_label_check" }),
      email_hash: col("text"),
      status: col("text", { nn: true, def: "active", check: (r) => ["active", "needs_reauth", "disabled"].includes(r.status), checkName: "accounts_status_check" }),
      created_at: col("timestamptz", { nn: true, def: "now" }),
    },
    pk: ["id"],
  },
  sessions: {
    cols: { account_id: col("uuid", { nn: true }), envelope: col("text", { nn: true }), rotated_at: col("timestamptz", { nn: true, def: "now" }) },
    pk: ["account_id"],
    fks: [{ cols: ["account_id"], ref: "accounts", refCols: ["id"], onDelete: "cascade" }],
  },
  audit_log: {
    cols: {
      id: col("bigint", { nn: true, def: "identity", always: true }),
      account_id: col("uuid"),
      tool: col("text", { nn: true }),
      rpc_id: col("text"),
      outcome: col("text", { nn: true }),
      at: col("timestamptz", { nn: true, def: "now" }),
    },
    pk: ["id"],
    fks: [{ cols: ["account_id"], ref: "accounts", refCols: ["id"], onDelete: "setnull" }],
  },
  usage_counters: {
    cols: {
      account_id: col("uuid", { nn: true }),
      day: col("date", { nn: true }),
      kind: col("text", { nn: true }),
      count: col("integer", { nn: true, def: 0, check: (r) => r.count >= 0, checkName: "usage_counters_count_check" }),
    },
    pk: ["account_id", "day", "kind"],
    fks: [{ cols: ["account_id"], ref: "accounts", refCols: ["id"], onDelete: "cascade" }],
  },
  created_objects: {
    cols: {
      account_id: col("uuid", { nn: true }),
      kind: col("text", { nn: true }),
      object_id: col("text", { nn: true }),
      created_at: col("timestamptz", { nn: true, def: "now" }),
    },
    pk: ["account_id", "kind", "object_id"],
    fks: [{ cols: ["account_id"], ref: "accounts", refCols: ["id"], onDelete: "cascade" }],
  },
  oauth_clients: {
    cols: {
      client_id: col("text", { nn: true }),
      redirect_uris: col("text[]", { nn: true, check: (r) => r.redirect_uris.length >= 1 && r.redirect_uris.length <= 5, checkName: "oauth_clients_redirect_uris_check" }),
      client_name: col("text", { nn: true, check: (r) => r.client_name.length >= 1 && r.client_name.length <= 100, checkName: "oauth_clients_client_name_check" }),
      created_at: col("timestamptz", { nn: true, def: "now" }),
    },
    pk: ["client_id"],
  },
  oauth_codes: {
    cols: {
      code_hash: col("text", { nn: true }),
      client_id: col("text", { nn: true }),
      redirect_uri: col("text", { nn: true }),
      code_challenge: col("text", { nn: true }),
      scope: col("text", { nn: true }),
      resource: col("text"),
      family_id: col("text", { nn: true }),
      expires_at: col("timestamptz", { nn: true }),
      used: col("boolean", { nn: true, def: false }),
    },
    pk: ["code_hash"],
    fks: [{ cols: ["client_id"], ref: "oauth_clients", refCols: ["client_id"], onDelete: "cascade" }],
  },
  oauth_tokens: {
    cols: {
      token_hash: col("text", { nn: true }),
      kind: col("text", { nn: true, check: (r) => ["access", "refresh"].includes(r.kind), checkName: "oauth_tokens_kind_check" }),
      client_id: col("text", { nn: true }),
      scope: col("text", { nn: true }),
      expires_at: col("timestamptz", { nn: true }),
      family_id: col("text", { nn: true }),
      revoked: col("boolean", { nn: true, def: false }),
      revoked_at: col("timestamptz"),
      created_at: col("timestamptz", { nn: true, def: "now" }),
    },
    pk: ["token_hash"],
    fks: [{ cols: ["client_id"], ref: "oauth_clients", refCols: ["client_id"], onDelete: "cascade" }],
  },
  login_attempts: {
    cols: {
      id: col("bigint", { nn: true, def: "identity", always: true }),
      key_hash: col("text", { nn: true, check: (r) => r.key_hash.length === 64, checkName: "login_attempts_key_hash_check" }),
      attempted_at: col("timestamptz", { nn: true, def: "now" }),
    },
    pk: ["id"],
  },
};

// ---- state ---------------------------------------------------------------------------------------
let db, identity, requestLog, faults;
function reset() {
  db = Object.fromEntries(Object.keys(SCHEMA).map((t) => [t, []]));
  identity = { audit_log: 0, login_attempts: 0 };
  requestLog = [];
  faults = [];
}
reset();

// ---- errors --------------------------------------------------------------------------------------
class PgError extends Error {
  constructor(status, code, message, details = null, hint = null) {
    super(message);
    this.status = status;
    this.body = { code, message, details, hint };
  }
}

// ---- value typing (mimics Postgres input coercion) --------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TS_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}(:?\d{2})?)?$/;
const bad = (type, v) => new PgError(400, "22P02", `invalid input syntax for type ${type}: "${v}"`);

function fmtTs(ms) {
  // Postgres/PostgREST JSON style: 2026-10-31T12:00:00.123456+00:00 (trailing zeros trimmed)
  const d = new Date(ms);
  const frac = String(d.getUTCMilliseconds()).padStart(3, "0").replace(/0+$/, "");
  return d.toISOString().slice(0, 19) + (frac ? "." + frac : "") + "+00:00";
}
function parseTs(v) {
  const s = String(v);
  if (!TS_RE.test(s)) throw new PgError(400, "22007", `invalid input syntax for type timestamp with time zone: "${s}"`);
  const ms = Date.parse(/[zZ]|[+-]\d{2}(:?\d{2})?$/.test(s.replace(/^\d{4}-\d{2}-\d{2}/, "")) ? s : s + "Z");
  if (Number.isNaN(ms)) throw new PgError(400, "22008", `date/time field value out of range: "${s}"`);
  return ms;
}

/** Coerce a JSON body value to the column's stored representation. */
function coerceStored(type, v) {
  if (v === null || v === undefined) return null;
  switch (type) {
    case "uuid":
      if (typeof v !== "string" || !UUID_RE.test(v)) throw bad("uuid", v);
      return v.toLowerCase();
    case "text":
      if (typeof v === "object") return JSON.stringify(v);
      return String(v);
    case "text[]":
      if (!Array.isArray(v)) throw new PgError(400, "22P02", `malformed array literal: "${String(v)}"`, "Array value must start with \"{\" or dimension information.");
      return v.map(String);
    case "boolean":
      if (typeof v === "boolean") return v;
      if (["true", "t", "1", "yes", "on"].includes(String(v).toLowerCase())) return true;
      if (["false", "f", "0", "no", "off"].includes(String(v).toLowerCase())) return false;
      throw bad("boolean", v);
    case "integer":
    case "bigint":
      if (typeof v === "number" && Number.isInteger(v)) return v;
      if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v);
      throw bad(type, v);
    case "date":
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw bad("date", v);
      return v;
    case "timestamptz":
      return fmtTs(parseTs(v));
    default:
      throw new Error("unknown type " + type);
  }
}
/** Filter literal (always a string in the query) coerced for comparison. */
function coerceFilter(type, s) {
  if (type === "timestamptz") return parseTs(s);
  if (type === "text[]") return s;
  const v = coerceStored(type, s);
  return v;
}
const cmpVal = (type, v) => (type === "timestamptz" ? parseTs(v) : v);
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---- filters ----------------------------------------------------------------------------------------
const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

function parseFilters(table, params) {
  const spec = SCHEMA[table];
  const out = [];
  for (const [k, raw] of params) {
    if (RESERVED.has(k)) continue;
    if (k === "or" || k === "and" || k === "not.or") throw new PgError(400, "PGRST100", "logical filters are not implemented by the QA emulator");
    const c = spec.cols[k];
    if (!c) throw new PgError(400, "42703", `column ${table}.${k} does not exist`);
    const dot = raw.indexOf(".");
    if (dot < 0) throw new PgError(400, "PGRST100", `"failed to parse filter (${raw})"`, `unexpected "${raw[0]}" expecting operator`);
    let op = raw.slice(0, dot);
    let val = raw.slice(dot + 1);
    let neg = false;
    if (op === "not") {
      neg = true;
      const d2 = val.indexOf(".");
      op = val.slice(0, d2);
      val = val.slice(d2 + 1);
    }
    out.push({ k, c, op, val, neg });
  }
  return out;
}
function splitIn(val) {
  const m = /^\((.*)\)$/s.exec(val);
  if (!m) throw new PgError(400, "PGRST100", `failed to parse filter (in.${val})`);
  const items = [];
  let cur = "", q = false;
  for (const ch of m[1]) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { items.push(cur); cur = ""; }
    else cur += ch;
  }
  if (m[1] !== "") items.push(cur);
  return items;
}
function matches(row, filters) {
  for (const f of filters) {
    const cell = row[f.k];
    let ok;
    switch (f.op) {
      case "is": {
        const v = f.val.toLowerCase();
        if (!["null", "true", "false", "unknown"].includes(v)) throw new PgError(400, "22P02", `invalid input syntax for type boolean: "${f.val}"`);
        ok = v === "null" ? cell === null : v === "unknown" ? cell === null : cell === (v === "true");
        break;
      }
      case "in":
        ok = cell !== null && splitIn(f.val).some((x) => cmpVal(f.c.t, cell) === coerceFilter(f.c.t, x));
        break;
      case "like":
      case "ilike": {
        const re = new RegExp("^" + f.val.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", f.op === "ilike" ? "is" : "s");
        ok = cell !== null && re.test(String(cell));
        break;
      }
      case "eq": case "neq": case "gt": case "gte": case "lt": case "lte": {
        const lit = coerceFilter(f.c.t, f.val);
        if (cell === null) { ok = false; break; }
        const c = cmp(cmpVal(f.c.t, cell), lit);
        ok = f.op === "eq" ? c === 0 : f.op === "neq" ? c !== 0 : f.op === "gt" ? c > 0 : f.op === "gte" ? c >= 0 : f.op === "lt" ? c < 0 : c <= 0;
        break;
      }
      default:
        throw new PgError(400, "PGRST100", `unsupported operator "${f.op}" in the QA emulator`);
    }
    if (f.neg) ok = !ok;
    if (!ok) return false;
  }
  return true;
}

// ---- row construction + constraints ---------------------------------------------------------------------
function defaultFor(table, name, c) {
  if (c.def === "uuid") return crypto.randomUUID();
  if (c.def === "now") return fmtTs(Date.now());
  if (c.def === "identity") return ++identity[table];
  return c.def === undefined ? null : c.def;
}
function checkRow(table, row) {
  const spec = SCHEMA[table];
  for (const [name, c] of Object.entries(spec.cols)) {
    if (c.nn && (row[name] === null || row[name] === undefined)) {
      throw new PgError(400, "23502", `null value in column "${name}" of relation "${table}" violates not-null constraint`, `Failing row contains (${Object.values(row).map((x) => x ?? "null").join(", ")}).`);
    }
  }
  for (const c of Object.values(spec.cols)) {
    if (c.check && !c.check(row)) {
      throw new PgError(400, "23514", `new row for relation "${table}" violates check constraint "${c.checkName}"`, `Failing row contains (${Object.values(row).map((x) => x ?? "null").join(", ")}).`);
    }
  }
  for (const fk of spec.fks ?? []) {
    if (fk.cols.every((k) => row[k] !== null) && !db[fk.ref].some((r) => fk.cols.every((k, i) => r[fk.refCols[i]] === row[k]))) {
      throw new PgError(409, "23503", `insert or update on table "${table}" violates foreign key constraint "${table}_${fk.cols[0]}_fkey"`, `Key (${fk.cols[0]})=(${row[fk.cols[0]]}) is not present in table "${fk.ref}".`);
    }
  }
}
function pkOf(spec, row) {
  return spec.pk.map((k) => String(row[k])).join("\u0000");
}
function assertUnique(table, row, ignoreRow) {
  const spec = SCHEMA[table];
  const key = pkOf(spec, row);
  if (db[table].some((r) => r !== ignoreRow && pkOf(spec, r) === key)) {
    throw new PgError(409, "23505", `duplicate key value violates unique constraint "${table}_pkey"`, `Key (${spec.pk.join(", ")})=(${spec.pk.map((k) => row[k]).join(", ")}) already exists.`);
  }
}
function buildRow(table, input, { partial = false } = {}) {
  const spec = SCHEMA[table];
  for (const k of Object.keys(input)) {
    if (!spec.cols[k]) throw new PgError(400, "PGRST204", `Could not find the '${k}' column of '${table}' in the schema cache`);
    if (spec.cols[k].always) throw new PgError(400, "428C9", `cannot insert a non-DEFAULT value into column "${k}"`, `Column "${k}" is an identity column defined as GENERATED ALWAYS.`, "Use OVERRIDING SYSTEM VALUE to override.");
  }
  const row = {};
  for (const [name, c] of Object.entries(spec.cols)) {
    if (name in input) row[name] = coerceStored(c.t, input[name]);
    else if (!partial) row[name] = defaultFor(table, name, c);
  }
  return row;
}
function deleteRow(table, row) {
  db[table] = db[table].filter((r) => r !== row);
  // referential actions
  for (const [t2, s2] of Object.entries(SCHEMA)) {
    for (const fk of s2.fks ?? []) {
      if (fk.ref !== table) continue;
      const children = db[t2].filter((r) => fk.cols.every((k, i) => r[k] === row[fk.refCols[i]]));
      for (const ch of children) {
        if (fk.onDelete === "cascade") deleteRow(t2, ch);
        else if (fk.onDelete === "setnull") fk.cols.forEach((k) => (ch[k] = null));
      }
    }
  }
}

// ---- request handling ---------------------------------------------------------------------------------------
function orderRows(table, rows, orderParam) {
  if (!orderParam) return rows;
  const spec = SCHEMA[table];
  const keys = orderParam.split(",").map((s) => {
    const [name, ...mods] = s.split(".");
    if (!spec.cols[name]) throw new PgError(400, "42703", `column ${table}.${name} does not exist`);
    return { name, t: spec.cols[name].t, desc: mods.includes("desc"), nullsFirst: mods.includes("nullsfirst") ? true : mods.includes("nullslast") ? false : mods.includes("desc") };
  });
  return [...rows].sort((a, b) => {
    for (const k of keys) {
      const x = a[k.name], y = b[k.name];
      if (x === null || y === null) {
        if (x === y) continue;
        return (x === null) === k.nullsFirst ? -1 : 1;
      }
      const c = cmp(cmpVal(k.t, x), cmpVal(k.t, y));
      if (c) return k.desc ? -c : c;
    }
    return 0;
  });
}
function project(rows, select, table) {
  const spec = SCHEMA[table];
  if (select === undefined || select === "*") return rows.map((r) => ({ ...r }));
  const names = select.split(",").map((s) => s.trim()).filter(Boolean);
  for (const n of names) if (!spec.cols[n]) throw new PgError(400, "42703", `column ${table}.${n} does not exist`);
  return rows.map((r) => Object.fromEntries(names.map((n) => [n, r[n]])));
}
const prefers = (h) => String(h ?? "").split(",").map((s) => s.trim()).filter(Boolean);

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(payload);
}

function handleRest(req, res, url, bodyText) {
  const table = decodeURIComponent(url.pathname.slice("/rest/v1/".length));
  const spec = SCHEMA[table];
  const method = req.method;
  const pref = prefers(req.headers["prefer"]);
  const accept = String(req.headers["accept"] ?? "application/json");
  const single = accept.includes("application/vnd.pgrst.object+json");
  const wantRep = pref.includes("return=representation");
  const wantCount = pref.find((p) => p.startsWith("count="));
  const anon = ANON_KEY && req.__key === ANON_KEY;

  if (!spec) throw new PgError(404, "PGRST205", `Could not find the table 'public.${table}' in the schema cache`, null, "Perhaps you meant one of the existing tables.");
  if (anon) throw new PgError(401, "42501", `permission denied for table ${table}`); // RLS + REVOKE: anon/authenticated have no access
  const profile = req.headers[method === "GET" || method === "HEAD" ? "accept-profile" : "content-profile"];
  if (profile && profile !== "public") throw new PgError(406, "PGRST106", `The schema must be one of the following: public`);

  let body;
  if (method === "POST" || method === "PATCH") {
    if (!/application\/json/i.test(String(req.headers["content-type"] ?? ""))) throw new PgError(415, "PGRST102", "Content-Type not acceptable: " + (req.headers["content-type"] ?? ""));
    try { body = JSON.parse(bodyText); } catch { throw new PgError(400, "PGRST102", "Empty or invalid json"); }
    if (body === null || typeof body !== "object") throw new PgError(400, "PGRST102", "Empty or invalid json");
  }
  const selectParam = url.searchParams.get("select") ?? undefined;
  const filters = parseFilters(table, url.searchParams);

  if (method === "GET") {
    let rows = db[table].filter((r) => matches(r, filters));
    rows = orderRows(table, rows, url.searchParams.get("order"));
    const total = rows.length;
    const off = url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0;
    const lim = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : Infinity;
    if (!Number.isInteger(off) || off < 0 || (lim !== Infinity && (!Number.isInteger(lim) || lim < 0))) throw new PgError(400, "PGRST100", "invalid limit/offset");
    rows = rows.slice(off, off + Math.min(lim, MAX_ROWS));
    const out = project(rows, selectParam, table);
    const range = rows.length ? `${off}-${off + rows.length - 1}` : "*";
    const headers = { "content-range": `${range}/${wantCount ? total : "*"}` };
    let status = 200;
    if (wantCount && rows.length < total) status = 206;
    if (single) {
      if (out.length !== 1) throw new PgError(406, "PGRST116", "JSON object requested, multiple (or no) rows returned", `The result contains ${out.length} rows`);
      return send(res, status, out[0], { ...headers, "content-type": "application/vnd.pgrst.object+json; charset=utf-8" });
    }
    return send(res, status, out, headers);
  }

  // ---- writes run on a snapshot; any error rolls back (like a transaction)
  const snap = structuredClone({ db, identity });
  try {
    if (method === "POST") {
      const items = Array.isArray(body) ? body : [body];
      const upsertMode = pref.find((p) => p.startsWith("resolution="));
      const onConflictCols = url.searchParams.get("on_conflict")?.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
      if (upsertMode) {
        const target = onConflictCols ?? spec.pk;
        if ([...target].sort().join() !== [...spec.pk].sort().join()) {
          throw new PgError(400, "42P10", "there is no unique or exclusion constraint matching the ON CONFLICT specification");
        }
      } else if (onConflictCols) {
        // on_conflict without a resolution preference is ignored by PostgREST
      }
      const touched = [];
      for (const item of items) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) throw new PgError(400, "22023", "invalid body element");
        const row = buildRow(table, item);
        const existing = upsertMode ? db[table].find((r) => pkOf(spec, r) === pkOf(spec, row)) : undefined;
        if (existing) {
          if (upsertMode.endsWith("merge-duplicates")) {
            const next = { ...existing };
            for (const k of Object.keys(item)) next[k] = row[k];
            checkRow(table, next);
            Object.assign(existing, next);
            touched.push(existing);
          }
          continue;
        }
        checkRow(table, row);
        assertUnique(table, row);
        db[table].push(row);
        touched.push(row);
      }
      if (single && wantRep && touched.length !== 1) throw new PgError(406, "PGRST116", "JSON object requested, multiple (or no) rows returned", `The result contains ${touched.length} rows`);
      if (wantRep) {
        const out = project(touched, selectParam, table);
        return send(res, 201, single ? out[0] : out, single ? { "content-type": "application/vnd.pgrst.object+json; charset=utf-8" } : {});
      }
      return send(res, 201, undefined, { "content-range": "*/*" });
    }

    if (method === "PATCH" || method === "DELETE") {
      if (filters.length === 0) throw new PgError(400, "21000", `${method === "PATCH" ? "UPDATE" : "DELETE"} requires a WHERE clause`);
      const targets = db[table].filter((r) => matches(r, filters));
      if (method === "PATCH") {
        if (Array.isArray(body)) throw new PgError(400, "22023", "invalid body for PATCH");
        const patch = buildRow(table, body, { partial: true });
        for (const t of targets) {
          const next = { ...t };
          for (const k of Object.keys(body)) next[k] = patch[k];
          checkRow(table, next);
          assertUnique(table, next, t);
          Object.assign(t, next);
        }
      } else {
        for (const t of targets) deleteRow(table, t);
      }
      if (single && wantRep && targets.length !== 1) throw new PgError(406, "PGRST116", "JSON object requested, multiple (or no) rows returned", `The result contains ${targets.length} rows`);
      if (wantRep) {
        const out = project(targets, selectParam, table);
        return send(res, 200, single ? out[0] : out, { "content-range": `${targets.length ? `0-${targets.length - 1}` : "*"}/*`, ...(single ? { "content-type": "application/vnd.pgrst.object+json; charset=utf-8" } : {}) });
      }
      return send(res, 204, undefined, { "content-range": `*/${wantCount ? targets.length : "*"}` });
    }
    throw new PgError(405, "PGRST117", `Unsupported HTTP method: ${method}`);
  } catch (e) {
    db = snap.db;
    identity = snap.identity; // note: real sequences do NOT roll back; harmless for the app
    throw e;
  }
}

// ---- server -------------------------------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url, "http://x");

    // QA control plane
    if (url.pathname.startsWith("/__qa/")) {
      if (url.pathname === "/__qa/tables") return send(res, 200, db);
      if (url.pathname === "/__qa/log") return send(res, 200, requestLog);
      if (url.pathname === "/__qa/reset" && req.method === "POST") { reset(); return send(res, 200, { ok: true }); }
      if (url.pathname === "/__qa/fault" && req.method === "POST") { faults.push({ ...JSON.parse(bodyText || "{}") }); return send(res, 200, { ok: true, faults: faults.length }); }
      return send(res, 404, { message: "no such QA endpoint" });
    }

    const entry = {
      at: new Date().toISOString(),
      method: req.method,
      path: url.pathname,
      query: url.search,
      headers: { ...req.headers, apikey: req.headers.apikey ? "<present>" : undefined, authorization: req.headers.authorization ? "<present>" : undefined },
      body: bodyText,
      status: 0,
    };
    requestLog.push(entry);
    const origWrite = res.writeHead.bind(res);
    res.writeHead = (status, ...a) => { entry.status = status; return origWrite(status, ...a); };

    try {
      if (!url.pathname.startsWith("/rest/v1/")) throw new PgError(404, "PGRST125", `Invalid path specified in request URL`);
      // gateway: apikey header (or query param) is mandatory; Authorization must carry a valid key too
      const apikey = req.headers["apikey"] ?? url.searchParams.get("apikey");
      if (!apikey) return send(res, 401, { message: "No API key found in request", hint: "No `apikey` request header or url param was found." });
      const auth = String(req.headers["authorization"] ?? `Bearer ${apikey}`).replace(/^Bearer\s+/i, "");
      const valid = (k) => k === SERVICE_KEY || (ANON_KEY && k === ANON_KEY);
      if (!valid(apikey)) return send(res, 401, { message: "Invalid API key", hint: "Double check your Supabase `anon` or `service_role` API key." });
      if (!valid(auth)) return send(res, 401, { code: "PGRST301", message: "JWSError JWSInvalidSignature", details: null, hint: null });
      req.__key = auth;

      const fi = faults.findIndex((f) => (!f.table || url.pathname.endsWith("/" + f.table)) && (!f.method || f.method === req.method) && f.times > 0);
      if (fi >= 0) {
        faults[fi].times--;
        return send(res, faults[fi].status ?? 503, { code: "PGRST000", message: "Could not connect to the database (QA injected fault)", details: null, hint: null });
      }
      handleRest(req, res, url, bodyText);
    } catch (e) {
      if (e instanceof PgError) return send(res, e.status, e.body);
      console.error("emulator internal error", e);
      send(res, 500, { code: "XX000", message: "emulator internal error", details: String(e?.message), hint: null });
    }
  });
});
server.listen(PORT, "127.0.0.1", () => console.log(`fake-supabase listening on http://127.0.0.1:${PORT}`));
