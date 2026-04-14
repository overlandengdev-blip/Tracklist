-- ============================================================
-- TRACKLIST V1 COMPLETE SCHEMA
-- 25 tables, full RLS, triggers, indexes, seed data
-- Replaces migrations 00001 + 00002
-- Run in Supabase SQL Editor as a single script
-- ============================================================

BEGIN;

-- ============================================================
-- 1. EXTENSIONS
-- ============================================================
create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- ============================================================
-- 2. CLEANUP — drop objects from prior migrations
-- ============================================================

-- Triggers on auth.users
drop trigger if exists on_auth_user_created on auth.users;

-- Remove from realtime
do $$ begin
  alter publication supabase_realtime drop table if exists public.clips;
exception when undefined_object then null;
end $$;

-- Storage
do $$ begin
  delete from storage.objects where bucket_id in ('audio-clips');
  delete from storage.buckets where id in ('audio-clips');
exception when undefined_table then null;
end $$;

-- Drop storage policies
drop policy if exists "Users can upload to own folder" on storage.objects;
drop policy if exists "Users can read own audio" on storage.objects;
drop policy if exists "Users can delete own audio" on storage.objects;

-- Drop all existing tables (CASCADE handles FKs, policies, triggers)
drop table if exists public.recognitions cascade;
drop table if exists public.clips cascade;
drop table if exists public.tracks cascade;
drop table if exists public.profiles cascade;

-- Drop functions from prior migrations
drop function if exists public.handle_new_user() cascade;

-- ============================================================
-- 3. UTILITY FUNCTIONS
-- ============================================================

-- 3a. Auto-set updated_at on UPDATE
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- 3b. Auto-set audit columns (created_by on INSERT, updated_by on UPDATE)
-- auth.uid() returns the authenticated user's UUID, or NULL for service_role
create or replace function public.set_audit_columns()
returns trigger language plpgsql security invoker as $$
begin
  if TG_OP = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
  end if;
  if TG_OP = 'UPDATE' then
    new.updated_by := auth.uid();
  end if;
  return new;
end;
$$;

-- 3c. Helper to check if current user is admin
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select is_admin from public.profiles where id = auth.uid()),
    false
  );
$$;

-- ============================================================
-- 4. TABLES (dependency order)
-- ============================================================

-- 4a. schema_version — migration tracking
create table public.schema_version (
  version text primary key,
  description text,
  applied_at timestamptz not null default now()
);

-- 4b. app_config — runtime feature flags
create table public.app_config (
  key text primary key,
  value jsonb not null,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 4c. profiles — extends auth.users
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  display_name text not null,
  username text not null,
  bio text,
  avatar_url text,
  reputation integer not null default 0,
  clips_count integer not null default 0,
  ids_correct_count integer not null default 0,
  ids_proposed_count integer not null default 0,
  followers_count integer not null default 0,
  following_count integer not null default 0,
  home_city text,
  is_verified boolean not null default false,
  is_admin boolean not null default false,
  is_private boolean not null default false,
  notification_preferences jsonb default '{}',
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- 4d. genres — hierarchical taxonomy
create table public.genres (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  slug text not null unique,
  parent_genre_id uuid references public.genres on delete set null,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 4e. venues
create table public.venues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  city text,
  country text,
  lat numeric,
  lng numeric,
  capacity integer,
  genres text[],
  aliases text[],
  website text,
  instagram text,
  description text,
  verified boolean not null default false,
  search_vector tsvector,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 4f. djs
create table public.djs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  bio text,
  avatar_url text,
  soundcloud_url text,
  resident_advisor_url text,
  instagram text,
  genres text[],
  aliases text[],
  claimed_by_user_id uuid references public.profiles on delete set null,
  search_vector tsvector,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 4g. events
create table public.events (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid references public.venues on delete set null,
  name text not null,
  start_time timestamptz not null,
  end_time timestamptz,
  description text,
  genres text[],
  external_ticket_url text,
  poster_url text,
  verified boolean not null default false,
  metadata jsonb default '{}',
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 4h. dj_event_sets
create table public.dj_event_sets (
  id uuid primary key default gen_random_uuid(),
  dj_id uuid not null references public.djs on delete cascade,
  event_id uuid not null references public.events on delete cascade,
  set_start_time timestamptz,
  set_end_time timestamptz,
  stage text,
  position integer not null default 0,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (dj_id, event_id)
);

-- 4i. tracks — canonical music catalog
create table public.tracks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  artist text not null,
  remixer text,
  release text,
  label text,
  isrc text,
  spotify_id text,
  apple_music_id text,
  soundcloud_url text,
  beatport_url text,
  bandcamp_url text,
  youtube_url text,
  artwork_url text,
  release_date date,
  genres text[],
  bpm integer,
  key text,
  duration_ms integer,
  is_unreleased boolean not null default false,
  is_id_still_unknown boolean not null default false,
  metadata jsonb default '{}',
  search_vector tsvector,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 4j. clips — core content
create table public.clips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  audio_path text not null,
  waveform_data jsonb,
  duration_seconds numeric not null,
  recorded_at timestamptz not null default now(),
  captured_lat numeric,
  captured_lng numeric,
  venue_id uuid references public.venues on delete set null,
  event_id uuid references public.events on delete set null,
  dj_id uuid references public.djs on delete set null,
  dj_event_set_id uuid references public.dj_event_sets on delete set null,
  timestamp_in_set_seconds integer,
  status text not null default 'pending'
    check (status in ('pending','processing','matched','unmatched','community','resolved')),
  matched_track_id uuid references public.tracks on delete set null,
  resolution_source text
    check (resolution_source in ('acrcloud','audd','community','manual')),
  is_public boolean not null default false,
  community_ids_count integer not null default 0,
  play_count integer not null default 0,
  save_count integer not null default 0,
  report_count integer not null default 0,
  metadata jsonb default '{}',
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- 4k. recognitions — AI audit trail
create table public.recognitions (
  id uuid primary key default gen_random_uuid(),
  clip_id uuid not null references public.clips on delete cascade,
  service text not null check (service in ('acrcloud','audd','shazamkit')),
  request_duration_ms integer,
  success boolean not null,
  matched_track_id uuid references public.tracks on delete set null,
  confidence numeric,
  raw_response jsonb,
  error_message text,
  cost_cents numeric,
  attempted_at timestamptz not null default now()
);

-- 4l. community_ids — human identification proposals
create table public.community_ids (
  id uuid primary key default gen_random_uuid(),
  clip_id uuid not null references public.clips on delete cascade,
  proposed_by uuid not null references public.profiles on delete cascade,
  track_id uuid references public.tracks on delete set null,
  freeform_title text,
  freeform_artist text,
  freeform_notes text,
  confidence text check (confidence in ('guessing','pretty_sure','certain')),
  upvotes_count integer not null default 0,
  downvotes_count integer not null default 0,
  is_accepted boolean not null default false,
  accepted_at timestamptz,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- 4m. votes — on community IDs
create table public.votes (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.community_ids on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  direction text not null check (direction in ('up','down')),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (community_id, user_id)
);

-- 4n. follows — polymorphic social graph
create table public.follows (
  id uuid primary key default gen_random_uuid(),
  follower_id uuid not null references public.profiles on delete cascade,
  followable_type text not null check (followable_type in ('profile','dj','venue','genre')),
  followable_id uuid not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (follower_id, followable_type, followable_id)
);

-- 4o. saved_tracks
create table public.saved_tracks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  track_id uuid not null references public.tracks on delete cascade,
  clip_id uuid references public.clips on delete set null,
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (user_id, track_id)
);

-- 4p. saved_clips
create table public.saved_clips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  clip_id uuid not null references public.clips on delete cascade,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (user_id, clip_id)
);

-- 4q. reputation_events — append-only audit log
create table public.reputation_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  event_type text not null
    check (event_type in ('id_accepted','id_upvoted','id_downvoted','clip_matched','badge_earned','admin_adjustment')),
  points_delta integer not null,
  related_entity_type text,
  related_entity_id uuid,
  note text,
  created_at timestamptz not null default now()
);

-- 4r. badges
create table public.badges (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text,
  icon_url text,
  criteria jsonb default '{}',
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 4s. user_badges
create table public.user_badges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  badge_id uuid not null references public.badges on delete cascade,
  earned_at timestamptz not null default now(),
  metadata jsonb default '{}',
  unique (user_id, badge_id)
);

-- 4t. notifications
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  type text not null
    check (type in (
      'clip_matched','clip_unmatched_posted_to_community',
      'id_proposed_on_your_clip','id_accepted','id_upvoted','id_downvoted',
      'your_vote_on_accepted_id','new_follower',
      'followed_dj_has_new_set','followed_venue_has_new_event',
      'badge_earned','clip_reported','report_resolved','mention','system'
    )),
  actor_id uuid references public.profiles on delete set null,
  entity_type text,
  entity_id uuid,
  data jsonb default '{}',
  read_at timestamptz,
  push_sent_at timestamptz,
  created_at timestamptz not null default now()
);

-- 4u. push_tokens
create table public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  token text not null unique,
  platform text not null check (platform in ('ios','android','web')),
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

-- 4v. reports
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles on delete cascade,
  entity_type text not null check (entity_type in ('clip','community_id','profile','comment')),
  entity_id uuid not null,
  reason text not null check (reason in ('spam','abuse','copyright','other')),
  description text,
  status text not null default 'pending'
    check (status in ('pending','reviewing','resolved','dismissed')),
  resolved_by uuid references public.profiles on delete set null,
  resolved_at timestamptz,
  resolution_note text,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 4w. blocked_users
create table public.blocked_users (
  id uuid primary key default gen_random_uuid(),
  blocker_id uuid not null references public.profiles on delete cascade,
  blocked_id uuid not null references public.profiles on delete cascade,
  reason text,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (blocker_id, blocked_id)
);

-- 4x. clip_plays — analytics
create table public.clip_plays (
  id uuid primary key default gen_random_uuid(),
  clip_id uuid not null references public.clips on delete cascade,
  user_id uuid references public.profiles on delete set null,
  played_at timestamptz not null default now(),
  duration_played_seconds integer
);

-- 4y. rate_limit_events
create table public.rate_limit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  action_type text not null,
  created_at timestamptz not null default now()
);


-- ============================================================
-- 5. INDEXES
-- ============================================================

-- profiles
create unique index idx_profiles_username_lower on public.profiles (lower(username));
create index idx_profiles_reputation_desc on public.profiles (reputation desc);
create index idx_profiles_deleted_at on public.profiles (deleted_at) where deleted_at is not null;

-- genres
create index idx_genres_parent on public.genres (parent_genre_id);

-- venues
create index idx_venues_city_country on public.venues (city, country);
create index idx_venues_search on public.venues using gin (search_vector);

-- djs
create index idx_djs_claimed_by on public.djs (claimed_by_user_id) where claimed_by_user_id is not null;
create index idx_djs_search on public.djs using gin (search_vector);

-- events
create index idx_events_venue_start on public.events (venue_id, start_time desc);
create index idx_events_upcoming on public.events (start_time) where start_time > now();
create index idx_events_created_by on public.events (created_by) where created_by is not null;

-- dj_event_sets
create index idx_dj_event_sets_dj on public.dj_event_sets (dj_id);
create index idx_dj_event_sets_event on public.dj_event_sets (event_id);

-- tracks
create unique index idx_tracks_isrc on public.tracks (isrc) where isrc is not null;
create unique index idx_tracks_spotify on public.tracks (spotify_id) where spotify_id is not null;
create index idx_tracks_artist_title on public.tracks (artist, title);
create index idx_tracks_search on public.tracks using gin (search_vector);

-- clips
create index idx_clips_user_created on public.clips (user_id, created_at desc);
create index idx_clips_public on public.clips (created_at desc)
  where is_public = true and deleted_at is null;
create index idx_clips_event on public.clips (event_id, created_at) where event_id is not null;
create index idx_clips_dj on public.clips (dj_id, created_at) where dj_id is not null;
create index idx_clips_status_pending on public.clips (status)
  where status in ('pending', 'processing');
create index idx_clips_venue on public.clips (venue_id) where venue_id is not null;
create index idx_clips_matched_track on public.clips (matched_track_id) where matched_track_id is not null;
create index idx_clips_dj_event_set on public.clips (dj_event_set_id) where dj_event_set_id is not null;

-- recognitions
create index idx_recognitions_clip on public.recognitions (clip_id, attempted_at desc);
create index idx_recognitions_track on public.recognitions (matched_track_id) where matched_track_id is not null;

-- community_ids
create index idx_community_ids_clip_votes on public.community_ids (clip_id, upvotes_count desc);
create index idx_community_ids_proposer on public.community_ids (proposed_by, created_at desc);
create index idx_community_ids_track on public.community_ids (track_id) where track_id is not null;

-- votes
create index idx_votes_community on public.votes (community_id);
create index idx_votes_user on public.votes (user_id);

-- follows
create index idx_follows_target on public.follows (followable_type, followable_id);
create index idx_follows_follower on public.follows (follower_id);

-- saved_tracks
create index idx_saved_tracks_user on public.saved_tracks (user_id, created_at desc);
create index idx_saved_tracks_track on public.saved_tracks (track_id);

-- saved_clips
create index idx_saved_clips_user on public.saved_clips (user_id, created_at desc);
create index idx_saved_clips_clip on public.saved_clips (clip_id);

-- reputation_events
create index idx_reputation_events_user on public.reputation_events (user_id, created_at desc);

-- user_badges
create index idx_user_badges_user on public.user_badges (user_id);
create index idx_user_badges_badge on public.user_badges (badge_id);

-- notifications
create index idx_notifications_user_created on public.notifications (user_id, created_at desc);
create index idx_notifications_unread on public.notifications (user_id) where read_at is null;
create index idx_notifications_actor on public.notifications (actor_id) where actor_id is not null;

-- push_tokens
create index idx_push_tokens_user on public.push_tokens (user_id);

-- reports
create index idx_reports_reporter on public.reports (reporter_id);
create index idx_reports_entity on public.reports (entity_type, entity_id);
create index idx_reports_status on public.reports (status) where status in ('pending', 'reviewing');

-- blocked_users
create index idx_blocked_users_blocker on public.blocked_users (blocker_id);
create index idx_blocked_users_blocked on public.blocked_users (blocked_id);

-- clip_plays
create index idx_clip_plays_clip on public.clip_plays (clip_id);
create index idx_clip_plays_user on public.clip_plays (user_id) where user_id is not null;
create index idx_clip_plays_time on public.clip_plays (played_at);

-- rate_limit_events
create index idx_rate_limit_user_action on public.rate_limit_events (user_id, action_type, created_at desc);


-- ============================================================
-- 6. RLS — enable on every table, default deny
-- ============================================================

alter table public.schema_version enable row level security;
alter table public.app_config enable row level security;
alter table public.profiles enable row level security;
alter table public.genres enable row level security;
alter table public.venues enable row level security;
alter table public.djs enable row level security;
alter table public.events enable row level security;
alter table public.dj_event_sets enable row level security;
alter table public.tracks enable row level security;
alter table public.clips enable row level security;
alter table public.recognitions enable row level security;
alter table public.community_ids enable row level security;
alter table public.votes enable row level security;
alter table public.follows enable row level security;
alter table public.saved_tracks enable row level security;
alter table public.saved_clips enable row level security;
alter table public.reputation_events enable row level security;
alter table public.badges enable row level security;
alter table public.user_badges enable row level security;
alter table public.notifications enable row level security;
alter table public.push_tokens enable row level security;
alter table public.reports enable row level security;
alter table public.blocked_users enable row level security;
alter table public.clip_plays enable row level security;
alter table public.rate_limit_events enable row level security;


-- ============================================================
-- 7. RLS POLICIES
-- ============================================================

-- schema_version: read-only for authenticated
create policy "schema_version_select" on public.schema_version
  for select to authenticated using (true);

-- app_config: authenticated read, admin write
create policy "app_config_select" on public.app_config
  for select to authenticated using (true);
create policy "app_config_insert" on public.app_config
  for insert to authenticated with check (public.is_admin());
create policy "app_config_update" on public.app_config
  for update to authenticated using (public.is_admin());
create policy "app_config_delete" on public.app_config
  for delete to authenticated using (public.is_admin());

-- profiles
create policy "profiles_select" on public.profiles
  for select to authenticated using (deleted_at is null);
create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- genres: authenticated read, admin write
create policy "genres_select" on public.genres
  for select to authenticated using (true);
create policy "genres_insert" on public.genres
  for insert to authenticated with check (public.is_admin());
create policy "genres_update" on public.genres
  for update to authenticated using (public.is_admin());

-- venues: authenticated read, admin write
create policy "venues_select" on public.venues
  for select to authenticated using (true);
create policy "venues_insert" on public.venues
  for insert to authenticated with check (public.is_admin());
create policy "venues_update" on public.venues
  for update to authenticated using (public.is_admin());

-- djs: authenticated read, admin write
create policy "djs_select" on public.djs
  for select to authenticated using (true);
create policy "djs_insert" on public.djs
  for insert to authenticated with check (public.is_admin());
create policy "djs_update" on public.djs
  for update to authenticated using (public.is_admin());

-- events: authenticated read, authenticated insert (user-submitted), admin update
create policy "events_select" on public.events
  for select to authenticated using (true);
create policy "events_insert" on public.events
  for insert to authenticated with check (true);
create policy "events_update" on public.events
  for update to authenticated using (public.is_admin());

-- dj_event_sets: authenticated read, admin write
create policy "dj_event_sets_select" on public.dj_event_sets
  for select to authenticated using (true);
create policy "dj_event_sets_insert" on public.dj_event_sets
  for insert to authenticated with check (public.is_admin());
create policy "dj_event_sets_update" on public.dj_event_sets
  for update to authenticated using (public.is_admin());

-- tracks: authenticated read, service_role inserts (bypasses RLS)
create policy "tracks_select" on public.tracks
  for select to authenticated using (true);

-- clips: owner full access + public read for is_public non-deleted
-- also respect blocked_users and is_private
create policy "clips_select_own" on public.clips
  for select to authenticated using (auth.uid() = user_id);
create policy "clips_select_public" on public.clips
  for select to authenticated
  using (
    is_public = true
    and deleted_at is null
    and user_id != auth.uid()
    -- respect privacy
    and not exists (
      select 1 from public.profiles
      where id = clips.user_id and is_private = true
      and not exists (
        select 1 from public.follows
        where follower_id = auth.uid()
          and followable_type = 'profile'
          and followable_id = clips.user_id
      )
    )
    -- respect blocks
    and not exists (
      select 1 from public.blocked_users
      where (blocker_id = clips.user_id and blocked_id = auth.uid())
         or (blocker_id = auth.uid() and blocked_id = clips.user_id)
    )
  );
create policy "clips_insert_own" on public.clips
  for insert to authenticated with check (auth.uid() = user_id);
create policy "clips_update_own" on public.clips
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy "clips_delete_own" on public.clips
  for delete to authenticated using (auth.uid() = user_id);

-- recognitions: clip owner can read, service_role inserts (bypasses RLS)
create policy "recognitions_select_own" on public.recognitions
  for select to authenticated
  using (exists (
    select 1 from public.clips where clips.id = recognitions.clip_id and clips.user_id = auth.uid()
  ));

-- community_ids: authenticated read (non-deleted), authenticated insert,
-- proposer + clip owner update (enforced by trigger), admin all
create policy "community_ids_select" on public.community_ids
  for select to authenticated using (deleted_at is null);
create policy "community_ids_insert" on public.community_ids
  for insert to authenticated with check (auth.uid() = proposed_by);
create policy "community_ids_update_proposer" on public.community_ids
  for update to authenticated
  using (auth.uid() = proposed_by);
create policy "community_ids_update_clip_owner" on public.community_ids
  for update to authenticated
  using (exists (
    select 1 from public.clips where clips.id = community_ids.clip_id and clips.user_id = auth.uid()
  ));
create policy "community_ids_update_admin" on public.community_ids
  for update to authenticated using (public.is_admin());

-- votes: authenticated read, own insert/update/delete
create policy "votes_select" on public.votes
  for select to authenticated using (true);
create policy "votes_insert" on public.votes
  for insert to authenticated with check (auth.uid() = user_id);
create policy "votes_update" on public.votes
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "votes_delete" on public.votes
  for delete to authenticated using (auth.uid() = user_id);

-- follows: own management, public read for follow graphs
create policy "follows_select" on public.follows
  for select to authenticated using (true);
create policy "follows_insert" on public.follows
  for insert to authenticated with check (auth.uid() = follower_id);
create policy "follows_delete" on public.follows
  for delete to authenticated using (auth.uid() = follower_id);

-- saved_tracks: own only
create policy "saved_tracks_select" on public.saved_tracks
  for select to authenticated using (auth.uid() = user_id);
create policy "saved_tracks_insert" on public.saved_tracks
  for insert to authenticated with check (auth.uid() = user_id);
create policy "saved_tracks_delete" on public.saved_tracks
  for delete to authenticated using (auth.uid() = user_id);

-- saved_clips: own only
create policy "saved_clips_select" on public.saved_clips
  for select to authenticated using (auth.uid() = user_id);
create policy "saved_clips_insert" on public.saved_clips
  for insert to authenticated with check (auth.uid() = user_id);
create policy "saved_clips_delete" on public.saved_clips
  for delete to authenticated using (auth.uid() = user_id);

-- reputation_events: own read
create policy "reputation_events_select" on public.reputation_events
  for select to authenticated using (auth.uid() = user_id);

-- badges: authenticated read, admin write
create policy "badges_select" on public.badges
  for select to authenticated using (true);
create policy "badges_insert" on public.badges
  for insert to authenticated with check (public.is_admin());
create policy "badges_update" on public.badges
  for update to authenticated using (public.is_admin());

-- user_badges: authenticated read
create policy "user_badges_select" on public.user_badges
  for select to authenticated using (true);

-- notifications: own select/update (mark read), service_role inserts
create policy "notifications_select" on public.notifications
  for select to authenticated using (auth.uid() = user_id);
create policy "notifications_update" on public.notifications
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- push_tokens: own management
create policy "push_tokens_select" on public.push_tokens
  for select to authenticated using (auth.uid() = user_id);
create policy "push_tokens_insert" on public.push_tokens
  for insert to authenticated with check (auth.uid() = user_id);
create policy "push_tokens_update" on public.push_tokens
  for update to authenticated using (auth.uid() = user_id);
create policy "push_tokens_delete" on public.push_tokens
  for delete to authenticated using (auth.uid() = user_id);

-- reports: own read, admin read all, authenticated insert
create policy "reports_select_own" on public.reports
  for select to authenticated using (auth.uid() = reporter_id);
create policy "reports_select_admin" on public.reports
  for select to authenticated using (public.is_admin());
create policy "reports_insert" on public.reports
  for insert to authenticated with check (auth.uid() = reporter_id);
create policy "reports_update_admin" on public.reports
  for update to authenticated using (public.is_admin());

-- blocked_users: own management
create policy "blocked_select" on public.blocked_users
  for select to authenticated using (auth.uid() = blocker_id);
create policy "blocked_insert" on public.blocked_users
  for insert to authenticated with check (auth.uid() = blocker_id);
create policy "blocked_delete" on public.blocked_users
  for delete to authenticated using (auth.uid() = blocker_id);

-- clip_plays: service_role inserts (bypasses RLS), own read
create policy "clip_plays_select" on public.clip_plays
  for select to authenticated using (auth.uid() = user_id);

-- rate_limit_events: service_role inserts (bypasses RLS)
-- no user-facing read policy needed


-- ============================================================
-- 8. BUSINESS LOGIC FUNCTIONS
-- ============================================================

-- 8a. Rate limit checker
create or replace function public.check_rate_limit(
  p_user_id uuid,
  p_action_type text,
  p_max_count integer,
  p_window_minutes integer
) returns boolean language sql stable security definer set search_path = '' as $$
  select count(*) < p_max_count
  from public.rate_limit_events
  where user_id = p_user_id
    and action_type = p_action_type
    and created_at > now() - (p_window_minutes || ' minutes')::interval;
$$;

-- 8b. Find or create track (deduplication)
create or replace function public.find_or_create_track(
  p_title text,
  p_artist text,
  p_isrc text default null,
  p_spotify_id text default null,
  p_remixer text default null,
  p_label text default null,
  p_artwork_url text default null,
  p_genres text[] default null,
  p_metadata jsonb default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_track_id uuid;
begin
  -- 1. Match on ISRC (most authoritative)
  if p_isrc is not null then
    select id into v_track_id from public.tracks where isrc = p_isrc;
    if v_track_id is not null then return v_track_id; end if;
  end if;

  -- 2. Match on Spotify ID
  if p_spotify_id is not null then
    select id into v_track_id from public.tracks where spotify_id = p_spotify_id;
    if v_track_id is not null then return v_track_id; end if;
  end if;

  -- 3. Fuzzy match on title + artist (pg_trgm similarity)
  select id into v_track_id from public.tracks
  where similarity(lower(title), lower(p_title)) > 0.6
    and similarity(lower(artist), lower(p_artist)) > 0.6
  order by similarity(lower(title), lower(p_title))
         + similarity(lower(artist), lower(p_artist)) desc
  limit 1;
  if v_track_id is not null then return v_track_id; end if;

  -- 4. No match — create new
  insert into public.tracks (title, artist, isrc, spotify_id, remixer, label, artwork_url, genres, metadata)
  values (p_title, p_artist, p_isrc, p_spotify_id, p_remixer, p_label, p_artwork_url, p_genres, p_metadata)
  returning id into v_track_id;

  return v_track_id;
end;
$$;

-- 8c. Cleanup orphaned follows (polymorphic — no FK enforcement)
create or replace function public.cleanup_orphaned_follows()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_deleted integer := 0;
  v_count integer;
begin
  delete from public.follows
  where followable_type = 'profile'
    and followable_id not in (select id from public.profiles where deleted_at is null);
  get diagnostics v_count = row_count; v_deleted := v_deleted + v_count;

  delete from public.follows
  where followable_type = 'dj'
    and followable_id not in (select id from public.djs);
  get diagnostics v_count = row_count; v_deleted := v_deleted + v_count;

  delete from public.follows
  where followable_type = 'venue'
    and followable_id not in (select id from public.venues);
  get diagnostics v_count = row_count; v_deleted := v_deleted + v_count;

  delete from public.follows
  where followable_type = 'genre'
    and followable_id not in (select id from public.genres);
  get diagnostics v_count = row_count; v_deleted := v_deleted + v_count;

  return v_deleted;
end;
$$;


-- ============================================================
-- 9. TRIGGER FUNCTIONS
-- ============================================================

-- 9a. Search vector maintenance
create or replace function public.update_search_vector()
returns trigger language plpgsql as $$
begin
  if TG_TABLE_NAME = 'tracks' then
    new.search_vector := to_tsvector('english',
      coalesce(new.title, '') || ' ' ||
      coalesce(new.artist, '') || ' ' ||
      coalesce(new.remixer, '') || ' ' ||
      coalesce(new.label, ''));
  elsif TG_TABLE_NAME = 'djs' then
    new.search_vector := to_tsvector('english',
      coalesce(new.name, '') || ' ' ||
      coalesce(array_to_string(new.aliases, ' '), '') || ' ' ||
      coalesce(new.bio, ''));
  elsif TG_TABLE_NAME = 'venues' then
    new.search_vector := to_tsvector('english',
      coalesce(new.name, '') || ' ' ||
      coalesce(array_to_string(new.aliases, ' '), '') || ' ' ||
      coalesce(new.city, '') || ' ' ||
      coalesce(new.country, '') || ' ' ||
      coalesce(new.description, ''));
  end if;
  return new;
end;
$$;

-- 9b. New user → auto-create profile with unique username
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_base_username text;
  v_username text;
  v_suffix integer := 0;
begin
  v_base_username := lower(regexp_replace(split_part(new.email, '@', 1), '[^a-z0-9_]', '', 'g'));
  if length(v_base_username) < 3 then
    v_base_username := 'user';
  end if;
  v_username := v_base_username;

  loop
    begin
      insert into public.profiles (id, display_name, username)
      values (new.id, split_part(new.email, '@', 1), v_username);
      exit;
    exception when unique_violation then
      v_suffix := v_suffix + 1;
      v_username := v_base_username || v_suffix::text;
    end;
  end loop;

  return new;
end;
$$;

-- 9c. Profile counters from clips changes
create or replace function public.on_clips_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if TG_OP = 'INSERT' then
    if new.deleted_at is null then
      update public.profiles set clips_count = clips_count + 1 where id = new.user_id;
    end if;
    return new;
  elsif TG_OP = 'UPDATE' then
    -- soft delete
    if old.deleted_at is null and new.deleted_at is not null then
      update public.profiles set clips_count = greatest(clips_count - 1, 0) where id = new.user_id;
    -- un-delete
    elsif old.deleted_at is not null and new.deleted_at is null then
      update public.profiles set clips_count = clips_count + 1 where id = new.user_id;
    end if;
    return new;
  elsif TG_OP = 'DELETE' then
    if old.deleted_at is null then
      update public.profiles set clips_count = greatest(clips_count - 1, 0) where id = old.user_id;
    end if;
    return old;
  end if;
  return null;
end;
$$;

-- 9d. Profile counters from community_ids changes
create or replace function public.on_community_ids_change_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if TG_OP = 'INSERT' then
    if new.deleted_at is null then
      update public.profiles set ids_proposed_count = ids_proposed_count + 1
      where id = new.proposed_by;
    end if;
    return new;
  elsif TG_OP = 'UPDATE' then
    if old.deleted_at is null and new.deleted_at is not null then
      update public.profiles set ids_proposed_count = greatest(ids_proposed_count - 1, 0)
      where id = new.proposed_by;
    elsif old.deleted_at is not null and new.deleted_at is null then
      update public.profiles set ids_proposed_count = ids_proposed_count + 1
      where id = new.proposed_by;
    end if;
    return new;
  elsif TG_OP = 'DELETE' then
    if old.deleted_at is null then
      update public.profiles set ids_proposed_count = greatest(ids_proposed_count - 1, 0)
      where id = old.proposed_by;
    end if;
    -- Hard delete of accepted community_id: reverse reputation
    if old.is_accepted = true then
      insert into public.reputation_events (user_id, event_type, points_delta, related_entity_type, related_entity_id, note)
      values (old.proposed_by, 'admin_adjustment', -10, 'community_id', old.id, 'Hard delete of accepted community ID');
      update public.profiles
      set reputation = greatest(reputation - 10, 0),
          ids_correct_count = greatest(ids_correct_count - 1, 0)
      where id = old.proposed_by;
    end if;
    return old;
  end if;
  return null;
end;
$$;

-- 9e. Clip counters from community_ids changes
create or replace function public.on_community_ids_change_clip()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if TG_OP = 'INSERT' then
    if new.deleted_at is null then
      perform set_config('app.system_update', 'true', true);
      update public.clips set community_ids_count = community_ids_count + 1 where id = new.clip_id;
    end if;
    return new;
  elsif TG_OP = 'UPDATE' then
    if old.deleted_at is null and new.deleted_at is not null then
      perform set_config('app.system_update', 'true', true);
      update public.clips set community_ids_count = greatest(community_ids_count - 1, 0) where id = new.clip_id;
    elsif old.deleted_at is not null and new.deleted_at is null then
      perform set_config('app.system_update', 'true', true);
      update public.clips set community_ids_count = community_ids_count + 1 where id = new.clip_id;
    end if;
    return new;
  elsif TG_OP = 'DELETE' then
    if old.deleted_at is null then
      perform set_config('app.system_update', 'true', true);
      update public.clips set community_ids_count = greatest(community_ids_count - 1, 0) where id = old.clip_id;
    end if;
    return old;
  end if;
  return null;
end;
$$;

-- 9f. Clip save_count from saved_clips changes
create or replace function public.on_saved_clips_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if TG_OP = 'INSERT' then
    perform set_config('app.system_update', 'true', true);
    update public.clips set save_count = save_count + 1 where id = new.clip_id;
    return new;
  elsif TG_OP = 'DELETE' then
    perform set_config('app.system_update', 'true', true);
    update public.clips set save_count = greatest(save_count - 1, 0) where id = old.clip_id;
    return old;
  end if;
  return null;
end;
$$;

-- 9g. Clip play_count from clip_plays
create or replace function public.on_clip_plays_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('app.system_update', 'true', true);
  update public.clips set play_count = play_count + 1 where id = new.clip_id;
  return new;
end;
$$;

-- 9h. Clip report_count from reports
create or replace function public.on_reports_change_clip()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if TG_OP = 'INSERT' and new.entity_type = 'clip' then
    perform set_config('app.system_update', 'true', true);
    update public.clips set report_count = report_count + 1 where id = new.entity_id;
    return new;
  elsif TG_OP = 'DELETE' and old.entity_type = 'clip' then
    perform set_config('app.system_update', 'true', true);
    update public.clips set report_count = greatest(report_count - 1, 0) where id = old.entity_id;
    return old;
  end if;
  return coalesce(new, old);
end;
$$;

-- 9i. Follow counters on profiles
create or replace function public.on_follows_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if TG_OP = 'INSERT' then
    -- Increment follower's following_count
    update public.profiles set following_count = following_count + 1
    where id = new.follower_id;
    -- Increment target's followers_count (only for profile follows)
    if new.followable_type = 'profile' then
      update public.profiles set followers_count = followers_count + 1
      where id = new.followable_id;
    end if;
    return new;
  elsif TG_OP = 'DELETE' then
    update public.profiles set following_count = greatest(following_count - 1, 0)
    where id = old.follower_id;
    if old.followable_type = 'profile' then
      update public.profiles set followers_count = greatest(followers_count - 1, 0)
      where id = old.followable_id;
    end if;
    return old;
  end if;
  return null;
end;
$$;

-- 9j. Vote counters + reputation
create or replace function public.on_votes_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_proposer_id uuid;
  v_delta integer;
  v_rep_event_type text;
begin
  -- Get the proposer of the community_id being voted on
  if TG_OP = 'DELETE' then
    select proposed_by into v_proposer_id from public.community_ids where id = old.community_id;
  else
    select proposed_by into v_proposer_id from public.community_ids where id = new.community_id;
  end if;

  -- Update vote counts on community_ids
  perform set_config('app.system_update', 'true', true);

  if TG_OP = 'INSERT' then
    if new.direction = 'up' then
      update public.community_ids set upvotes_count = upvotes_count + 1 where id = new.community_id;
      v_delta := 1; v_rep_event_type := 'id_upvoted';
    else
      update public.community_ids set downvotes_count = downvotes_count + 1 where id = new.community_id;
      v_delta := -1; v_rep_event_type := 'id_downvoted';
    end if;
  elsif TG_OP = 'UPDATE' then
    if old.direction = new.direction then return new; end if;
    if new.direction = 'up' then
      update public.community_ids
      set upvotes_count = upvotes_count + 1, downvotes_count = greatest(downvotes_count - 1, 0)
      where id = new.community_id;
      v_delta := 2; v_rep_event_type := 'id_upvoted';
    else
      update public.community_ids
      set downvotes_count = downvotes_count + 1, upvotes_count = greatest(upvotes_count - 1, 0)
      where id = new.community_id;
      v_delta := -2; v_rep_event_type := 'id_downvoted';
    end if;
  elsif TG_OP = 'DELETE' then
    if old.direction = 'up' then
      update public.community_ids set upvotes_count = greatest(upvotes_count - 1, 0) where id = old.community_id;
      v_delta := -1; v_rep_event_type := 'id_upvoted';
    else
      update public.community_ids set downvotes_count = greatest(downvotes_count - 1, 0) where id = old.community_id;
      v_delta := 1; v_rep_event_type := 'id_downvoted';
    end if;
  end if;

  -- Update proposer reputation
  if v_proposer_id is not null and v_delta is not null then
    update public.profiles
    set reputation = greatest(reputation + v_delta, 0)
    where id = v_proposer_id;

    insert into public.reputation_events (user_id, event_type, points_delta, related_entity_type, related_entity_id)
    values (v_proposer_id, v_rep_event_type, v_delta, 'vote', coalesce(new.id, old.id));
  end if;

  return coalesce(new, old);
end;
$$;

-- 9k. Prevent self-voting (proposer cannot vote on own community_id)
create or replace function public.prevent_self_vote()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_proposer_id uuid;
begin
  select proposed_by into v_proposer_id
  from public.community_ids where id = new.community_id;

  if new.user_id = v_proposer_id then
    raise exception 'Cannot vote on your own community ID proposal';
  end if;

  return new;
end;
$$;

-- 9l. Handle ID accepted/un-accepted
create or replace function public.on_community_id_accepted()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Only fire when is_accepted actually changes
  if old.is_accepted = new.is_accepted then return new; end if;

  perform set_config('app.system_update', 'true', true);

  if new.is_accepted = true then
    -- Acceptance: +10 rep, update clip status
    new.accepted_at := now();

    update public.profiles
    set reputation = reputation + 10,
        ids_correct_count = ids_correct_count + 1
    where id = new.proposed_by;

    insert into public.reputation_events (user_id, event_type, points_delta, related_entity_type, related_entity_id)
    values (new.proposed_by, 'id_accepted', 10, 'community_id', new.id);

    update public.clips
    set status = 'resolved',
        matched_track_id = new.track_id,
        resolution_source = 'community'
    where id = new.clip_id;

  else
    -- Un-acceptance: reverse
    new.accepted_at := null;

    update public.profiles
    set reputation = greatest(reputation - 10, 0),
        ids_correct_count = greatest(ids_correct_count - 1, 0)
    where id = old.proposed_by;

    insert into public.reputation_events (user_id, event_type, points_delta, related_entity_type, related_entity_id, note)
    values (old.proposed_by, 'id_accepted', -10, 'community_id', old.id, 'Un-accepted');

    update public.clips
    set status = 'community',
        matched_track_id = null,
        resolution_source = null
    where id = new.clip_id;
  end if;

  return new;
end;
$$;

-- 9m. Enforce column-level update rules on community_ids
-- Proposer can change: freeform fields, track_id, confidence, deleted_at
-- Clip owner can change: is_accepted, accepted_at
-- Admins: all columns
-- System updates (from triggers): allowed via app.system_update GUC
create or replace function public.enforce_community_id_columns()
returns trigger language plpgsql security invoker as $$
declare
  v_uid uuid;
  v_clip_owner_id uuid;
  v_is_admin boolean;
begin
  -- System updates from triggers bypass this check
  if current_setting('app.system_update', true) = 'true' then
    return new;
  end if;

  v_uid := auth.uid();

  -- Service role (null uid) can do anything
  if v_uid is null then return new; end if;

  -- Admin check
  select is_admin into v_is_admin from public.profiles where id = v_uid;
  if v_is_admin then return new; end if;

  -- Get clip owner
  select user_id into v_clip_owner_id from public.clips where id = old.clip_id;

  -- Proposer: can change freeform_title, freeform_artist, freeform_notes, track_id, confidence, deleted_at
  if v_uid = old.proposed_by then
    if new.is_accepted is distinct from old.is_accepted
      or new.accepted_at is distinct from old.accepted_at
      or new.upvotes_count is distinct from old.upvotes_count
      or new.downvotes_count is distinct from old.downvotes_count
    then
      raise exception 'Proposer cannot modify acceptance or counter fields';
    end if;
    return new;
  end if;

  -- Clip owner: can change is_accepted, accepted_at
  if v_uid = v_clip_owner_id then
    if new.freeform_title is distinct from old.freeform_title
      or new.freeform_artist is distinct from old.freeform_artist
      or new.freeform_notes is distinct from old.freeform_notes
      or new.track_id is distinct from old.track_id
      or new.confidence is distinct from old.confidence
      or new.deleted_at is distinct from old.deleted_at
    then
      raise exception 'Clip owner can only modify acceptance fields';
    end if;
    return new;
  end if;

  raise exception 'Not authorized to update this community ID';
end;
$$;

-- 9n. Community ID dedup on insert
-- If someone proposes an ID that matches an existing proposal for the same clip
-- (same track_id or normalized freeform fields), auto-upvote instead
create or replace function public.handle_community_id_dedup()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_existing_id uuid;
begin
  -- Check for exact track_id match on same clip
  if new.track_id is not null then
    select id into v_existing_id
    from public.community_ids
    where clip_id = new.clip_id
      and track_id = new.track_id
      and deleted_at is null
    limit 1;
  end if;

  -- Check freeform fuzzy match (normalized comparison)
  if v_existing_id is null and new.freeform_title is not null then
    select id into v_existing_id
    from public.community_ids
    where clip_id = new.clip_id
      and deleted_at is null
      and lower(trim(freeform_title)) = lower(trim(new.freeform_title))
      and lower(trim(coalesce(freeform_artist, ''))) = lower(trim(coalesce(new.freeform_artist, '')))
    limit 1;
  end if;

  -- Duplicate found: upvote existing instead of inserting new row
  if v_existing_id is not null then
    insert into public.votes (community_id, user_id, direction, created_by)
    values (v_existing_id, new.proposed_by, 'up', new.proposed_by)
    on conflict (community_id, user_id) do nothing;
    return null; -- cancel the INSERT
  end if;

  return new; -- proceed with INSERT
end;
$$;

-- 9o. Enforce reputation floor (never below 0)
create or replace function public.enforce_reputation_floor()
returns trigger language plpgsql as $$
begin
  if new.reputation < 0 then
    new.reputation := 0;
  end if;
  return new;
end;
$$;


-- ============================================================
-- 10. ATTACH TRIGGERS
-- ============================================================

-- 10a. updated_at triggers (every table with updated_at)
create trigger set_updated_at before update on public.app_config
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.genres
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.venues
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.djs
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.events
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.dj_event_sets
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.tracks
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.clips
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.community_ids
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.badges
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.reports
  for each row execute function public.set_updated_at();

-- 10b. Audit column triggers
create trigger set_audit before insert or update on public.app_config
  for each row execute function public.set_audit_columns();
create trigger set_audit before insert or update on public.profiles
  for each row execute function public.set_audit_columns();
create trigger set_audit before insert or update on public.genres
  for each row execute function public.set_audit_columns();
create trigger set_audit before insert or update on public.venues
  for each row execute function public.set_audit_columns();
create trigger set_audit before insert or update on public.djs
  for each row execute function public.set_audit_columns();
create trigger set_audit before insert or update on public.events
  for each row execute function public.set_audit_columns();
create trigger set_audit before insert or update on public.dj_event_sets
  for each row execute function public.set_audit_columns();
create trigger set_audit before insert or update on public.tracks
  for each row execute function public.set_audit_columns();
create trigger set_audit before insert or update on public.clips
  for each row execute function public.set_audit_columns();
create trigger set_audit before insert or update on public.community_ids
  for each row execute function public.set_audit_columns();
create trigger set_audit before insert or update on public.badges
  for each row execute function public.set_audit_columns();
create trigger set_audit before insert or update on public.reports
  for each row execute function public.set_audit_columns();
create trigger set_audit before insert on public.votes
  for each row execute function public.set_audit_columns();
create trigger set_audit before insert on public.follows
  for each row execute function public.set_audit_columns();
create trigger set_audit before insert on public.saved_tracks
  for each row execute function public.set_audit_columns();
create trigger set_audit before insert on public.saved_clips
  for each row execute function public.set_audit_columns();
create trigger set_audit before insert on public.blocked_users
  for each row execute function public.set_audit_columns();

-- 10c. Search vector triggers
create trigger update_search_vector before insert or update on public.tracks
  for each row execute function public.update_search_vector();
create trigger update_search_vector before insert or update on public.djs
  for each row execute function public.update_search_vector();
create trigger update_search_vector before insert or update on public.venues
  for each row execute function public.update_search_vector();

-- 10d. New user profile creation
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 10e. Counter maintenance
create trigger on_clips_change after insert or update or delete on public.clips
  for each row execute function public.on_clips_change();

create trigger on_community_ids_change_profile after insert or update or delete on public.community_ids
  for each row execute function public.on_community_ids_change_profile();

create trigger on_community_ids_change_clip after insert or update or delete on public.community_ids
  for each row execute function public.on_community_ids_change_clip();

create trigger on_saved_clips_change after insert or delete on public.saved_clips
  for each row execute function public.on_saved_clips_change();

create trigger on_clip_plays_insert after insert on public.clip_plays
  for each row execute function public.on_clip_plays_insert();

create trigger on_reports_change_clip after insert or delete on public.reports
  for each row execute function public.on_reports_change_clip();

create trigger on_follows_change after insert or delete on public.follows
  for each row execute function public.on_follows_change();

create trigger on_votes_change after insert or update or delete on public.votes
  for each row execute function public.on_votes_change();

-- 10f. Reputation floor
create trigger enforce_reputation_floor before update on public.profiles
  for each row execute function public.enforce_reputation_floor();

-- 10g. Vote self-prevention
create trigger prevent_self_vote before insert on public.votes
  for each row execute function public.prevent_self_vote();

-- 10h. Community ID acceptance logic (BEFORE update so we can modify new.accepted_at)
create trigger on_community_id_accepted before update on public.community_ids
  for each row execute function public.on_community_id_accepted();

-- 10i. Community ID column restriction (fires after acceptance trigger)
create trigger enforce_community_id_columns before update on public.community_ids
  for each row execute function public.enforce_community_id_columns();

-- 10j. Community ID dedup (fires before insert)
create trigger handle_community_id_dedup before insert on public.community_ids
  for each row execute function public.handle_community_id_dedup();


-- ============================================================
-- 11. STORAGE BUCKETS
-- ============================================================

-- audio-clips: private, 10MB, audio MIME types
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('audio-clips', 'audio-clips', false, 10485760,
  array['audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/wav']);

-- avatars: public read, 2MB, image MIME types
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152,
  array['image/jpeg', 'image/png', 'image/webp']);

-- venue-images: public read, admin write
insert into storage.buckets (id, name, public)
values ('venue-images', 'venue-images', true);

-- event-posters: public read, admin write
insert into storage.buckets (id, name, public)
values ('event-posters', 'event-posters', true);

-- track-artwork: public read, admin write
insert into storage.buckets (id, name, public)
values ('track-artwork', 'track-artwork', true);

-- Storage policies: audio-clips
create policy "audio_upload_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'audio-clips'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "audio_read_own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'audio-clips'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "audio_delete_own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'audio-clips'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Storage policies: avatars
create policy "avatar_read_public" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars');
create policy "avatar_upload_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "avatar_update_own" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "avatar_delete_own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Storage policies: admin-write buckets (venue-images, event-posters, track-artwork)
create policy "admin_media_read" on storage.objects
  for select to authenticated
  using (bucket_id in ('venue-images', 'event-posters', 'track-artwork'));
create policy "admin_media_upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('venue-images', 'event-posters', 'track-artwork')
    and public.is_admin()
  );
create policy "admin_media_update" on storage.objects
  for update to authenticated
  using (
    bucket_id in ('venue-images', 'event-posters', 'track-artwork')
    and public.is_admin()
  );
create policy "admin_media_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id in ('venue-images', 'event-posters', 'track-artwork')
    and public.is_admin()
  );


-- ============================================================
-- 12. REALTIME
-- ============================================================

alter publication supabase_realtime add table public.clips;
alter publication supabase_realtime add table public.notifications;


-- ============================================================
-- 13. SEED DATA
-- ============================================================

-- Genres: parent genres first, then subgenres
with parent_genres as (
  insert into public.genres (name, slug) values
    ('House', 'house'),
    ('Techno', 'techno'),
    ('Drum and Bass', 'drum-and-bass'),
    ('Dubstep', 'dubstep'),
    ('Trance', 'trance'),
    ('Ambient', 'ambient'),
    ('Breakbeat', 'breakbeat'),
    ('Garage', 'garage'),
    ('Electro', 'electro'),
    ('Downtempo', 'downtempo'),
    ('Hardcore', 'hardcore'),
    ('Minimal', 'minimal'),
    ('Progressive', 'progressive'),
    ('Disco', 'disco'),
    ('Bass Music', 'bass-music')
  returning id, slug
)
insert into public.genres (name, slug, parent_genre_id) values
  ('Deep House', 'deep-house', (select id from parent_genres where slug = 'house')),
  ('Tech House', 'tech-house', (select id from parent_genres where slug = 'house')),
  ('Acid House', 'acid-house', (select id from parent_genres where slug = 'house')),
  ('Afro House', 'afro-house', (select id from parent_genres where slug = 'house')),
  ('Hard Techno', 'hard-techno', (select id from parent_genres where slug = 'techno')),
  ('Dub Techno', 'dub-techno', (select id from parent_genres where slug = 'techno')),
  ('Acid Techno', 'acid-techno', (select id from parent_genres where slug = 'techno')),
  ('Liquid DnB', 'liquid-dnb', (select id from parent_genres where slug = 'drum-and-bass')),
  ('Jump Up', 'jump-up', (select id from parent_genres where slug = 'drum-and-bass')),
  ('Neurofunk', 'neurofunk', (select id from parent_genres where slug = 'drum-and-bass')),
  ('Melodic Dubstep', 'melodic-dubstep', (select id from parent_genres where slug = 'dubstep')),
  ('Riddim', 'riddim', (select id from parent_genres where slug = 'dubstep')),
  ('Psytrance', 'psytrance', (select id from parent_genres where slug = 'trance')),
  ('Progressive Trance', 'progressive-trance', (select id from parent_genres where slug = 'trance')),
  ('UK Garage', 'uk-garage', (select id from parent_genres where slug = 'garage')),
  ('Nu Disco', 'nu-disco', (select id from parent_genres where slug = 'disco'));

-- Badges
insert into public.badges (slug, name, description, criteria) values
  ('first-id', 'First ID', 'Successfully identified your first track for the community',
   '{"type": "ids_correct_count", "threshold": 1}'::jsonb),
  ('10-ids', 'Track Spotter', 'Successfully identified 10 tracks for the community',
   '{"type": "ids_correct_count", "threshold": 10}'::jsonb),
  ('100-ids', 'Track Encyclopedia', 'Successfully identified 100 tracks for the community',
   '{"type": "ids_correct_count", "threshold": 100}'::jsonb),
  ('genre-specialist', 'Genre Specialist', 'Identified 25+ tracks in a single genre',
   '{"type": "genre_ids_count", "threshold": 25}'::jsonb),
  ('scene-veteran', 'Scene Veteran', 'Active member for over a year with 50+ clips recorded',
   '{"type": "veteran", "months": 12, "clips_threshold": 50}'::jsonb);

-- App config defaults
insert into public.app_config (key, value) values
  ('acrcloud_enabled', 'true'::jsonb),
  ('audd_enabled', 'true'::jsonb),
  ('community_id_enabled', 'true'::jsonb),
  ('max_clips_per_day_free', '10'::jsonb),
  ('max_clips_per_day_pro', '100'::jsonb);


-- ============================================================
-- 14. SCHEMA VERSION
-- ============================================================

insert into public.schema_version (version, description)
values ('1.0.0', 'Complete v1 schema: 25 tables, full RLS, triggers, indexes, seed data');


COMMIT;
