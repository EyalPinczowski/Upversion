# 003 – One Supabase project, two schemas, per-environment roles

**Status:** Accepted · built in Phase 0 and v0.1

## Context
There are two environments: Operational (`main`) and R&D (`rnd`). The free Supabase plan allows a limited number of projects (**needs check**), and the user accounts are shared. R&D must never be able to read or write Operational data, even through a bug.

## Options
1. Two Supabase projects. Strongest isolation, but may exceed the free plan and splits user accounts.
2. One project, one schema, a column to tell environments apart. Weak: one bug leaks data.
3. One project with two schemas (`prod`, `rnd`) and a separate database role per environment.

## Decision
Option 3. `app_prod` and `app_rnd` can only touch their own schema; they do not own tables and have no `BYPASSRLS`. The shared Supabase `authenticated` role would need access to both schemas, so instead each backend sets a per-environment role (`app_prod_user`, `app_rnd_user`) inside its request transaction, with the verified user's claims, so the user's id resolves and row-level security applies (policies use `current_user_id()` instead of `auth.uid()`: see ADR 010). Migrations take the target schema as an explicit argument and refuse to run without it.

## Consequences
- Row-level security is tested directly against the database, not just through the API: a second user cannot read the first user's rows, and a query with no user context returns nothing.
- Backups use a read-only role with explicit select policies rather than any role that bypasses row-level security. The decryption key stays offline with the owner.
- Verified in Supabase's documentation: the shared pooler is IPv4 on every plan while the direct connection is IPv6-only on the Free plan; transaction mode keeps no session state, so every request runs as one transaction with `SET LOCAL`; a custom role connects through the pooler as `role.project-ref`. Still **needs check**: whether Supabase's default admin role can create the roles and memberships the migrations need (the tests use a non-superuser stand-in).
