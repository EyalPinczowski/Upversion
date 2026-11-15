-- Plan builder explanations (ADR 017, WP-4). Additive and backward compatible: two check
-- constraints are widened and one read-only function is added. No table, no column and no data
-- change.
--
-- 1. ai_usage_daily.purpose may now also be 'plan_explain'. The check (created unnamed in 0010,
--    widened in 0017) has PostgreSQL's generated name ai_usage_daily_purpose_check (verified in a
--    migrated database by packages/db/test/plan-explain-schema.test.ts). It is dropped and
--    re-added with the four existing purposes plus plan_explain.
-- 2. ai_cache.purpose may now also be 'plan_explain' (the explanation is cached per user under the
--    key of the allowlisted request, ADR 017 section 3). The check has the generated name
--    ai_cache_purpose_check (verified by the same test). It is dropped and re-added with the three
--    purposes 0010 allowed plus plan_explain. cv_tailor stays OUT of ai_cache on purpose: CV
--    tailoring has no cache, so such a row must remain impossible.
-- 3. ai_plan_explain_usage_today(): the sum of today's (UTC) ai_usage_daily.requests for the
--    purpose plan_explain over ALL users. RLS gives the app role only its own rows, and the
--    app-wide cap needs the total, so this SECURITY DEFINER function returns that one number and
--    nothing else (no user id, no row). It takes no argument and is fixed to plan_explain, so it
--    cannot be used to read another purpose's totals (same shape as ai_cv_tailor_usage_today in
--    0017). A signed-in user only; the UTC day is computed inside; search_path is pinned; no
--    dynamic SQL; PUBLIC has no EXECUTE.
set local role {{owner}};

alter table {{schema}}.ai_usage_daily drop constraint ai_usage_daily_purpose_check;
alter table {{schema}}.ai_usage_daily add constraint ai_usage_daily_purpose_check
  check (purpose in
    ('practice_message', 'practice_feedback', 'day_overview', 'cv_tailor', 'plan_explain'));

alter table {{schema}}.ai_cache drop constraint ai_cache_purpose_check;
alter table {{schema}}.ai_cache add constraint ai_cache_purpose_check
  check (purpose in ('practice_message', 'practice_feedback', 'day_overview', 'plan_explain'));

create function {{schema}}.ai_plan_explain_usage_today()
  returns bigint
  language sql
  stable
  security definer
  set search_path = {{schema}}, pg_temp
  as $$
  select coalesce(sum(u.requests), 0)::bigint
    from {{schema}}.ai_usage_daily u
   where {{schema}}.current_user_id() is not null
     and u.purpose = 'plan_explain'
     and u.day = (now() at time zone 'utc')::date
$$;

revoke all on function {{schema}}.ai_plan_explain_usage_today() from public;
grant execute on function {{schema}}.ai_plan_explain_usage_today() to {{app_user}};
