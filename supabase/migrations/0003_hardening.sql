-- Step 8a: persistent owner-login attempt limiter. Server-side only: RLS on, no policies,
-- no grants to API roles. One row per login attempt, keyed by a SHA-256 hash of the client IP
-- (never the IP itself). Rows older than 24 h are pruned by the app.

create table if not exists public.login_attempts (
  id            bigint generated always as identity primary key,
  key_hash      text not null check (char_length(key_hash) = 64),
  attempted_at  timestamptz not null default now()
);
create index if not exists login_attempts_key_at_idx on public.login_attempts (key_hash, attempted_at);
create index if not exists login_attempts_at_idx on public.login_attempts (attempted_at);

alter table public.login_attempts enable row level security;

-- Deliberately NO policies: anon/authenticated can never read or write this table.
revoke all on public.login_attempts from anon, authenticated;
revoke all on sequence public.login_attempts_id_seq from anon, authenticated;
