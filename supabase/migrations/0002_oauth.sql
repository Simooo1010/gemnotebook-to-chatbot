-- Step 4a: OAuth 2.1 authorization server tables. Server-side only: RLS on, no policies,
-- no grants to API roles. Codes and tokens are stored ONLY as sha256 hashes (hex).

create table if not exists public.oauth_clients (
  client_id      text primary key,
  redirect_uris  text[] not null check (cardinality(redirect_uris) between 1 and 5),
  client_name    text not null check (char_length(client_name) between 1 and 100),
  created_at     timestamptz not null default now()
);

create table if not exists public.oauth_codes (
  code_hash       text primary key,
  client_id       text not null references public.oauth_clients (client_id) on delete cascade,
  redirect_uri    text not null,
  code_challenge  text not null,
  scope           text not null,
  resource        text,
  family_id       text not null,
  expires_at      timestamptz not null,
  used            boolean not null default false
);
create index if not exists oauth_codes_client_idx on public.oauth_codes (client_id);

create table if not exists public.oauth_tokens (
  token_hash  text primary key,
  kind        text not null check (kind in ('access', 'refresh')),
  client_id   text not null references public.oauth_clients (client_id) on delete cascade,
  scope       text not null,
  expires_at  timestamptz not null,
  family_id   text not null,
  revoked     boolean not null default false,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists oauth_tokens_family_idx on public.oauth_tokens (family_id);
create index if not exists oauth_tokens_client_idx on public.oauth_tokens (client_id);
create index if not exists oauth_tokens_live_idx on public.oauth_tokens (revoked) where revoked = false;

alter table public.oauth_clients enable row level security;
alter table public.oauth_codes   enable row level security;
alter table public.oauth_tokens  enable row level security;

revoke all on public.oauth_clients, public.oauth_codes, public.oauth_tokens from anon, authenticated;
