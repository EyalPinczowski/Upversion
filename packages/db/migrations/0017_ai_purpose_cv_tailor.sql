-- CV tailoring (ADR 016, WP-F). Additive and backward compatible: one check constraint is widened
-- and one read-only function is added. No table, no column and no data change.
--
-- 1. ai_usage_daily.purpose may now also be 'cv_tailor'. The check created (unnamed) in 0010 got
--    PostgreSQL's generated name ai_usage_daily_purpose_check (verified in a migrated database by
--    packages/db/test/cv-tailor-schema.test.ts). It is dropped and re-added with the same three
--    purposes plus cv_tailor. The requests >= 0 and avoided >= 0 checks are not touched.
--    ai_cache is NOT changed: CV tailoring has no cache, so a cv_tailor row there must stay
--    impossible.
-- 2. ai_feature_usage_today(p_purpose): the sum of today's (UTC) ai_usage_daily.requests for one
--    purpose over ALL users. RLS gives the app role only its own rows, and the app-wide cap of a
--    feature needs the total, so this SECURITY DEFINER function returns that one number and
--    nothing else (no user id, no row). A signed-in user only; the UTC day is computed inside;
--    search_path is pinned; no dynamic SQL; PUBLIC has no EXECUTE.
set local role {{owner}};

alter table {{schema}}.ai_usage_daily drop constraint ai_usage_daily_purpose_check;
alter table {{schema}}.ai_usage_daily add constraint ai_usage_daily_purpose_check
  check (purpose in ('practice_message', 'practice_feedback', 'day_overview', 'cv_tailor'));

create function {{schema}}.ai_feature_usage_today(p_purpose text)
  returns bigint
  language sql
  stable
  security definer
  set search_path = {{schema}}, pg_temp
  as $$
  select coalesce(sum(u.requests), 0)::bigint
    from {{schema}}.ai_usage_daily u
   where {{schema}}.current_user_id() is not null
     and u.purpose = p_purpose
     and u.day = (now() at time zone 'utc')::date
$$;

revoke all on function {{schema}}.ai_feature_usage_today(text) from public;
grant execute on function {{schema}}.ai_feature_usage_today(text) to {{app_user}};
