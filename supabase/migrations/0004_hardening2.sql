-- Fix loop (OAuth hardening). Apply BEFORE deploying the matching app code.
--  * oauth_clients.ip_hash       per-IP registration rate limit (SHA-256/HMAC of the client IP, never the IP itself)
--  * oauth_clients.has_token     set when the app first receives a token; the 200-app cap counts only live apps
--  * oauth_tokens.rotated        true when a refresh token was revoked BY ROTATION (grace window for retried refreshes);
--                                a revoked row with rotated = false marks a revoked family (theft/replay/owner revoke)
--  * public.prune_expired()      daily clean-up called by the keep-alive route
-- Every object is revoked from public/anon/authenticated explicitly: the live database has default ACLs that grant
-- new functions and tables to those roles.

alter table public.oauth_clients add column if not exists ip_hash text check (ip_hash is null or char_length(ip_hash) = 64);
alter table public.oauth_clients add column if not exists has_token boolean not null default false;
alter table public.oauth_tokens  add column if not exists rotated boolean not null default false;

-- Backfill so existing sessions keep working: every already-revoked token counts as rotated (not as a revoked family),
-- every client that already has a token counts as authorized.
update public.oauth_tokens set rotated = true where revoked and not rotated;
update public.oauth_clients c set has_token = true
  where not has_token and exists (select 1 from public.oauth_tokens t where t.client_id = c.client_id);

create index if not exists oauth_clients_ip_created_idx on public.oauth_clients (ip_hash, created_at);
create index if not exists oauth_clients_created_idx on public.oauth_clients (created_at);
create index if not exists oauth_codes_expires_idx on public.oauth_codes (expires_at);
create index if not exists oauth_tokens_expires_idx on public.oauth_tokens (expires_at);
create index if not exists audit_log_at_idx on public.audit_log (at);

-- Re-assert: the new columns/indexes live on tables that must stay closed to the API roles.
revoke all on public.oauth_clients, public.oauth_codes, public.oauth_tokens, public.audit_log, public.login_attempts from public, anon, authenticated;

create or replace function public.prune_expired() returns jsonb
language sql security invoker set search_path = public as $$
  with c as (
    -- codes live 60 s; expired (and therefore also used) ones are kept 1 h for replay detection
    delete from public.oauth_codes where expires_at < now() - interval '1 hour' returning 1
  ), t as (
    delete from public.oauth_tokens
      where expires_at < now() - interval '7 days'
         or (revoked and coalesce(revoked_at, created_at) < now() - interval '7 days')
      returning 1
  ), cl as (
    -- abandoned registrations: no token ever issued, older than 1 h (a client with any token row is kept)
    delete from public.oauth_clients k
      where k.created_at < now() - interval '1 hour'
        and not exists (select 1 from public.oauth_tokens x where x.client_id = k.client_id)
      returning 1
  ), a as (
    delete from public.audit_log where at < now() - interval '90 days' returning 1
  ), l as (
    delete from public.login_attempts where attempted_at < now() - interval '24 hours' returning 1
  )
  select jsonb_build_object(
    'codes', (select count(*) from c), 'tokens', (select count(*) from t), 'clients', (select count(*) from cl),
    'audit', (select count(*) from a), 'login', (select count(*) from l))
$$;
revoke all on function public.prune_expired() from public, anon, authenticated;
grant execute on function public.prune_expired() to service_role;

-- Make the new columns and the RPC visible to PostgREST without waiting for a schema-cache refresh.
notify pgrst, 'reload schema';
