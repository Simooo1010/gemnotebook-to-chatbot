-- Step 2b: vault tables (SPEC §2). Server-side only: RLS on, no policies, no grants to API roles.
-- The service role bypasses RLS. Nothing here stores request/response bodies or plaintext cookies.

create table if not exists public.accounts (
  id          uuid primary key default gen_random_uuid(),
  label       text not null check (char_length(label) between 1 and 60),
  email_hash  text,
  status      text not null default 'active' check (status in ('active', 'needs_reauth', 'disabled')),
  created_at  timestamptz not null default now()
);

-- AES-256-GCM envelope (version, key id, nonce, ciphertext, tag) as one text value.
create table if not exists public.sessions (
  account_id  uuid primary key references public.accounts (id) on delete cascade,
  envelope    text not null,
  rotated_at  timestamptz not null default now()
);

-- Metadata only: no bodies, no cookies.
create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  account_id  uuid references public.accounts (id) on delete set null,
  tool        text not null,
  rpc_id      text,
  outcome     text not null,
  at          timestamptz not null default now()
);
create index if not exists audit_log_account_at_idx on public.audit_log (account_id, at desc);

create table if not exists public.usage_counters (
  account_id  uuid not null references public.accounts (id) on delete cascade,
  day         date not null,
  kind        text not null,
  count       integer not null default 0 check (count >= 0),
  primary key (account_id, day, kind)
);

-- Write allow-list: notebook / artifact ids this app created.
create table if not exists public.created_objects (
  account_id  uuid not null references public.accounts (id) on delete cascade,
  kind        text not null,
  object_id   text not null,
  created_at  timestamptz not null default now(),
  primary key (account_id, kind, object_id)
);

alter table public.accounts       enable row level security;
alter table public.sessions       enable row level security;
alter table public.audit_log      enable row level security;
alter table public.usage_counters enable row level security;
alter table public.created_objects enable row level security;

-- Deliberately NO policies: anon/authenticated can never read or write these tables.
revoke all on public.accounts, public.sessions, public.audit_log, public.usage_counters, public.created_objects
  from anon, authenticated;
revoke all on sequence public.audit_log_id_seq from anon, authenticated;
