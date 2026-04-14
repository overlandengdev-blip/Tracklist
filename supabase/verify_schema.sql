-- ============================================================
-- TRACKLIST V1 SCHEMA VERIFICATION
-- Run after applying the migration to verify everything is correct
-- ============================================================

-- 1. Check all 25 tables exist
do $$
declare
  v_tables text[] := array[
    'schema_version','app_config','profiles','genres','venues','djs','events',
    'dj_event_sets','tracks','clips','recognitions','community_ids','votes',
    'follows','saved_tracks','saved_clips','reputation_events','badges',
    'user_badges','notifications','push_tokens','reports','blocked_users',
    'clip_plays','rate_limit_events'
  ];
  v_table text;
  v_missing text[] := '{}';
begin
  foreach v_table in array v_tables loop
    if not exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = v_table
    ) then
      v_missing := v_missing || v_table;
    end if;
  end loop;
  if array_length(v_missing, 1) > 0 then
    raise exception 'FAIL: Missing tables: %', array_to_string(v_missing, ', ');
  else
    raise notice 'PASS: All 25 tables exist';
  end if;
end $$;

-- 2. Check RLS is enabled on every table
do $$
declare
  v_no_rls text[];
begin
  select array_agg(tablename) into v_no_rls
  from pg_tables
  where schemaname = 'public'
    and tablename != 'schema_migrations'
    and tablename not in (select tablename from pg_tables where schemaname = 'public')
    or tablename in (
      select t.tablename from pg_tables t
      where t.schemaname = 'public'
        and not exists (
          select 1 from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = t.tablename and c.relrowsecurity = true
        )
    );
  -- Direct check
  select array_agg(c.relname) into v_no_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relrowsecurity = false
    and c.relname not like 'schema_%';

  if v_no_rls is not null and array_length(v_no_rls, 1) > 0 then
    raise notice 'WARNING: Tables without RLS: %', array_to_string(v_no_rls, ', ');
  else
    raise notice 'PASS: RLS enabled on all public tables';
  end if;
end $$;

-- 3. Check RLS policy counts per table
do $$
declare
  r record;
begin
  raise notice '--- RLS policy counts ---';
  for r in
    select schemaname, tablename, count(*) as policy_count
    from pg_policies
    where schemaname = 'public'
    group by schemaname, tablename
    order by tablename
  loop
    raise notice '  %: % policies', r.tablename, r.policy_count;
  end loop;
end $$;

-- 4. Check storage buckets exist
do $$
declare
  v_buckets text[] := array['audio-clips','avatars','venue-images','event-posters','track-artwork'];
  v_bucket text;
  v_missing text[] := '{}';
begin
  foreach v_bucket in array v_buckets loop
    if not exists (select 1 from storage.buckets where id = v_bucket) then
      v_missing := v_missing || v_bucket;
    end if;
  end loop;
  if array_length(v_missing, 1) > 0 then
    raise exception 'FAIL: Missing storage buckets: %', array_to_string(v_missing, ', ');
  else
    raise notice 'PASS: All 5 storage buckets exist';
  end if;
end $$;

-- 5. Check triggers on auth.users
do $$
begin
  if exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'auth' and c.relname = 'users' and t.tgname = 'on_auth_user_created'
  ) then
    raise notice 'PASS: handle_new_user trigger exists on auth.users';
  else
    raise exception 'FAIL: handle_new_user trigger missing on auth.users';
  end if;
end $$;

-- 6. Check key functions exist
do $$
declare
  v_functions text[] := array[
    'set_updated_at','set_audit_columns','is_admin','handle_new_user',
    'check_rate_limit','find_or_create_track','cleanup_orphaned_follows',
    'update_search_vector','on_clips_change','on_community_ids_change_profile',
    'on_community_ids_change_clip','on_votes_change','prevent_self_vote',
    'on_community_id_accepted','enforce_community_id_columns',
    'handle_community_id_dedup','enforce_reputation_floor',
    'on_follows_change','on_saved_clips_change','on_clip_plays_insert',
    'on_reports_change_clip'
  ];
  v_func text;
  v_missing text[] := '{}';
begin
  foreach v_func in array v_functions loop
    if not exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_func
    ) then
      v_missing := v_missing || v_func;
    end if;
  end loop;
  if array_length(v_missing, 1) > 0 then
    raise exception 'FAIL: Missing functions: %', array_to_string(v_missing, ', ');
  else
    raise notice 'PASS: All 21 functions exist';
  end if;
end $$;

-- 7. Check seed data
do $$
declare
  v_genre_count integer;
  v_badge_count integer;
  v_config_count integer;
begin
  select count(*) into v_genre_count from public.genres;
  select count(*) into v_badge_count from public.badges;
  select count(*) into v_config_count from public.app_config;

  if v_genre_count >= 15 then
    raise notice 'PASS: % genres seeded (% parent + subgenres)', v_genre_count, (select count(*) from public.genres where parent_genre_id is null);
  else
    raise exception 'FAIL: Expected 15+ genres, got %', v_genre_count;
  end if;

  if v_badge_count = 5 then
    raise notice 'PASS: 5 badges seeded';
  else
    raise exception 'FAIL: Expected 5 badges, got %', v_badge_count;
  end if;

  if v_config_count = 5 then
    raise notice 'PASS: 5 app_config entries seeded';
  else
    raise exception 'FAIL: Expected 5 app_config entries, got %', v_config_count;
  end if;
end $$;

-- 8. Check schema version
do $$
declare
  v_version text;
begin
  select version into v_version from public.schema_version order by applied_at desc limit 1;
  if v_version = '1.0.0' then
    raise notice 'PASS: Schema version is 1.0.0';
  else
    raise exception 'FAIL: Expected schema version 1.0.0, got %', v_version;
  end if;
end $$;

-- 9. Check realtime publication
do $$
declare
  v_tables text[];
begin
  select array_agg(tablename::text) into v_tables
  from pg_publication_tables
  where pubname = 'supabase_realtime' and schemaname = 'public';

  if 'clips' = any(v_tables) and 'notifications' = any(v_tables) then
    raise notice 'PASS: clips and notifications in realtime publication';
  else
    raise notice 'WARNING: Realtime tables: %', coalesce(array_to_string(v_tables, ', '), 'none');
  end if;
end $$;

-- 10. Check index count
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from pg_indexes where schemaname = 'public';
  raise notice 'PASS: % indexes on public schema', v_count;
end $$;

-- Summary
do $$
begin
  raise notice '';
  raise notice '============================================';
  raise notice 'VERIFICATION COMPLETE';
  raise notice 'If you see all PASS messages above, the schema is correctly applied.';
  raise notice '============================================';
end $$;
