# Supabase

`migrations/0001_vault.sql`, `0002_oauth.sql` and `0003_hardening.sql` (login attempt limiter) were applied in the final manual run.

`migrations/0004_hardening2.sql` (OAuth hardening fix loop) **must be applied BEFORE the matching app code is deployed**: it adds `oauth_clients.ip_hash` / `has_token`, `oauth_tokens.rotated` (with a backfill so existing sessions keep working), indexes, and the SQL function `public.prune_expired()` (called daily by `/api/cron/keepalive`; EXECUTE granted to `service_role` only, explicitly revoked from `public`, `anon`, `authenticated`). It is idempotent.

All tables have row-level security enabled with no policies and no grants to `anon`/`authenticated`:
only the server's service-role key can touch them.
