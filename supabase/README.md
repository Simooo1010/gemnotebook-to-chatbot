# Supabase

`migrations/0001_vault.sql`, `0002_oauth.sql` and `0003_hardening.sql` (login attempt limiter) are written but **not applied yet**. It is applied in the final manual run
(after the owner names the Supabase project). OAuth tables come in Step 4.

All tables have row-level security enabled with no policies and no grants to `anon`/`authenticated`:
only the server's service-role key can touch them.
