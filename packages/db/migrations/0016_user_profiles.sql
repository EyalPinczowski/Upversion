-- User profile and first-time setup (ADR 015). Additive: one new table, nothing existing changes.
-- Tier 2 data (spec 3.B, owner to confirm): none of it goes to events, logs or AI prompts.
--
-- user_profiles: one row per user (a missing row means setup_status 'not_started'; no backfill).
--   answers: setup answers keyed by questions.json id (validated in the API against the question
--     definitions). skills / roles_held: validated in the API (taxonomy ids, level 0..3, title
--     length and a personal-details check). No column holds raw CV text, a file, a file name or
--     evidence: the CV is read in the browser only. pg_column_size checks cap the three jsonb columns.
--   The app can add, read, change and delete its own row; user_id and created_at never change.
--   updated_at is set by the API on each write (no trigger).
-- Deleting an account removes the row (cascade from app_users).
set local role {{owner}};

create table {{schema}}.user_profiles (
  user_id uuid primary key references {{schema}}.app_users (id) on delete cascade,
  answers jsonb not null default '{}' check (jsonb_typeof(answers) = 'object'),
  skills jsonb not null default '[]'
    check (jsonb_typeof(skills) = 'array' and jsonb_array_length(skills) <= 60),
  roles_held jsonb not null default '[]'
    check (jsonb_typeof(roles_held) = 'array' and jsonb_array_length(roles_held) <= 15),
  years_experience numeric check (years_experience is null or years_experience between 0 and 50),
  cv_imported_at timestamptz,
  setup_status text not null default 'not_started'
    check (setup_status in ('not_started', 'in_progress', 'completed', 'dismissed')),
  setup_step text check (setup_step is null or char_length(setup_step) <= 40),
  setup_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    pg_column_size(answers) <= 8192
    and pg_column_size(skills) <= 16384
    and pg_column_size(roles_held) <= 8192
  )
);

alter table {{schema}}.user_profiles enable row level security;

create policy app_user_select on {{schema}}.user_profiles
  for select to {{app_user}} using (user_id = (select {{schema}}.current_user_id()));
create policy app_user_insert on {{schema}}.user_profiles
  for insert to {{app_user}} with check (user_id = (select {{schema}}.current_user_id()));
create policy app_user_update on {{schema}}.user_profiles
  for update to {{app_user}}
  using (user_id = (select {{schema}}.current_user_id()))
  with check (user_id = (select {{schema}}.current_user_id()));
create policy app_user_delete on {{schema}}.user_profiles
  for delete to {{app_user}} using (user_id = (select {{schema}}.current_user_id()));
create policy backup_select on {{schema}}.user_profiles for select to {{backup}} using (true);

-- Everything except the owner and the creation time can be updated.
revoke update on {{schema}}.user_profiles from {{app_user}};
grant update (answers, skills, roles_held, years_experience, cv_imported_at, setup_status,
  setup_step, setup_completed_at, updated_at) on {{schema}}.user_profiles to {{app_user}};
