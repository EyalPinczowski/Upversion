-- Scheduled calendar sync (docs/calendar-cron.md). Additive and backward compatible: one new
-- column with a default and one new read-only function. Nothing is dropped or renamed, RLS is
-- unchanged.
--
-- 1. calendar_connections.auto_sync: the user's own switch for background syncing (the scheduled
--    sync skips a user who turned it off). Default true. The app login may update it (own row, by
--    the existing RLS update policy).
-- 2. calendar_users_due(p_older_than, p_limit): the user ids whose calendar is due for the
--    scheduled sync. RLS shows the app login only the signed-in user's rows, and the scheduled run
--    has no signed-in user, so this narrow SECURITY DEFINER function does the cross-user lookup.
--    It returns user ids only (never a token, email, title or any other column), at most
--    p_limit (clamped to 1..100), oldest sync first. A user is due when the connection is
--    'connected', has a stored refresh token and an app calendar, auto_sync is on, the account is
--    active and the last sync is missing or older than p_older_than. search_path is pinned, no
--    dynamic SQL, PUBLIC has no EXECUTE, only the app role may call it. Each user's sync then runs
--    under that user's own RLS context.
set local role {{owner}};

alter table {{schema}}.calendar_connections
  add column if not exists auto_sync boolean not null default true;

grant update (auto_sync) on {{schema}}.calendar_connections to {{app_user}};

comment on column {{schema}}.calendar_connections.auto_sync is
  'The user''s switch for the scheduled background calendar sync. Default true.';

create function {{schema}}.calendar_users_due(p_older_than interval, p_limit integer)
  returns table (user_id uuid)
  language sql
  stable
  security definer
  set search_path = {{schema}}, pg_temp
  as $$
  select c.user_id
    from {{schema}}.calendar_connections c
    join {{schema}}.app_users u on u.id = c.user_id
   where c.status = 'connected'
     and c.auto_sync
     and c.refresh_token_ciphertext is not null
     and c.app_calendar_id is not null
     and u.status = 'active'
     and (c.last_synced_at is null or c.last_synced_at < now() - p_older_than)
   order by c.last_synced_at asc nulls first, c.user_id
   limit greatest(1, least(coalesce(p_limit, 1), 100))
$$;

revoke all on function {{schema}}.calendar_users_due(interval, integer) from public;
grant execute on function {{schema}}.calendar_users_due(interval, integer) to {{app_user}};
