-- ============================================================
-- Track metadata caching + DJ content (uploads & video clips)
-- ------------------------------------------------------------
-- Part 1 — Extend `tracks` so one Spotify+Odesli fetch per ISRC
--          is cached forever (zero-cost on repeat matches).
-- Part 2 — Extend `djs` so a claimed DJ profile can post content.
-- Part 3 — New tables `dj_uploads` (audio) and `dj_clips` (video)
--          storing only R2 object keys (no egress cost from
--          Supabase Storage).
-- Part 4 — Storage quota tracking, app_config keys, RLS, indexes.
-- ============================================================

begin;

-- ─────────────────────────────────────────────────────────────
-- PART 1 · tracks enrichment (Spotify audio features + Odesli)
-- ─────────────────────────────────────────────────────────────

alter table public.tracks
  add column if not exists camelot text,
  add column if not exists energy numeric,
  add column if not exists danceability numeric,
  add column if not exists valence numeric,
  add column if not exists time_signature integer,
  add column if not exists preview_url text,
  add column if not exists streaming_links jsonb default '{}'::jsonb,
  add column if not exists metadata_fetched_at timestamptz,
  add column if not exists metadata_source text
    check (metadata_source in ('spotify','odesli','manual','acrcloud')),
  add column if not exists metadata_fetch_failed_at timestamptz,
  add column if not exists metadata_fetch_attempts integer not null default 0;

-- Index to find tracks whose metadata is stale or missing
create index if not exists tracks_metadata_pending_idx
  on public.tracks (metadata_fetched_at)
  where metadata_fetched_at is null;

-- Index for ISRC lookups (canonical dedupe key for tracks)
create unique index if not exists tracks_isrc_unique_idx
  on public.tracks (isrc)
  where isrc is not null;

-- Index for Spotify ID lookups
create unique index if not exists tracks_spotify_id_unique_idx
  on public.tracks (spotify_id)
  where spotify_id is not null;

-- ─────────────────────────────────────────────────────────────
-- PART 2 · djs enrichment for self-serve DJ profiles
-- ─────────────────────────────────────────────────────────────

alter table public.djs
  add column if not exists booking_email text,
  add column if not exists cover_image_url text,
  add column if not exists tier text not null default 'free'
    check (tier in ('free','pro','label')),
  add column if not exists storage_bytes_used bigint not null default 0,
  add column if not exists uploads_count integer not null default 0,
  add column if not exists clips_count integer not null default 0,
  add column if not exists plays_count integer not null default 0,
  add column if not exists followers_count integer not null default 0,
  add column if not exists is_accepting_bookings boolean not null default false,
  add column if not exists bandcamp_url text,
  add column if not exists website_url text;

-- ─────────────────────────────────────────────────────────────
-- PART 3 · dj_uploads  (audio: tracks / sets / mixes)
-- ─────────────────────────────────────────────────────────────

create table if not exists public.dj_uploads (
  id uuid primary key default gen_random_uuid(),
  dj_id uuid not null references public.djs on delete cascade,
  uploaded_by uuid not null references public.profiles on delete cascade,
  kind text not null check (kind in ('track','set','mix','edit','bootleg')),
  title text not null,
  description text,
  -- R2 object storage (zero egress)
  r2_bucket text not null,
  r2_key text not null,
  artwork_r2_key text,
  mime_type text not null,
  size_bytes bigint not null,
  duration_sec integer,
  -- metadata
  bpm numeric,
  key_signature text,
  camelot text,
  genre text,
  tags text[],
  tracklist jsonb default '[]'::jsonb,       -- for sets: [{time_sec, title, artist, track_id}]
  recorded_at timestamptz,
  recorded_venue_id uuid references public.venues on delete set null,
  -- social / state
  visibility text not null default 'public'
    check (visibility in ('public','followers','unlisted','private')),
  play_count integer not null default 0,
  save_count integer not null default 0,
  is_featured boolean not null default false,
  report_count integer not null default 0,
  -- moderation
  status text not null default 'active'
    check (status in ('uploading','active','hidden','removed')),
  -- audit
  metadata jsonb default '{}'::jsonb,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (r2_bucket, r2_key)
);

create index if not exists dj_uploads_dj_id_idx
  on public.dj_uploads (dj_id, created_at desc)
  where deleted_at is null and status = 'active';

create index if not exists dj_uploads_kind_idx
  on public.dj_uploads (kind, created_at desc)
  where deleted_at is null and status = 'active' and visibility = 'public';

create index if not exists dj_uploads_venue_idx
  on public.dj_uploads (recorded_venue_id, recorded_at desc)
  where recorded_venue_id is not null;

-- ─────────────────────────────────────────────────────────────
-- PART 4 · dj_clips  (short video performances)
-- ─────────────────────────────────────────────────────────────

create table if not exists public.dj_clips (
  id uuid primary key default gen_random_uuid(),
  dj_id uuid not null references public.djs on delete cascade,
  posted_by uuid not null references public.profiles on delete cascade,
  caption text,
  -- R2 video + thumbnail
  r2_bucket text not null,
  r2_key text not null,
  thumbnail_r2_key text,
  mime_type text not null,
  size_bytes bigint not null,
  duration_sec integer not null check (duration_sec > 0 and duration_sec <= 120),
  width integer,
  height integer,
  -- context
  venue_id uuid references public.venues on delete set null,
  event_id uuid references public.events on delete set null,
  recorded_at timestamptz,
  -- social
  visibility text not null default 'public'
    check (visibility in ('public','followers','unlisted','private')),
  play_count integer not null default 0,
  like_count integer not null default 0,
  comment_count integer not null default 0,
  report_count integer not null default 0,
  -- moderation
  status text not null default 'active'
    check (status in ('uploading','active','hidden','removed')),
  -- audit
  metadata jsonb default '{}'::jsonb,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (r2_bucket, r2_key)
);

create index if not exists dj_clips_dj_id_idx
  on public.dj_clips (dj_id, created_at desc)
  where deleted_at is null and status = 'active';

create index if not exists dj_clips_public_feed_idx
  on public.dj_clips (created_at desc)
  where deleted_at is null and status = 'active' and visibility = 'public';

create index if not exists dj_clips_venue_idx
  on public.dj_clips (venue_id, recorded_at desc)
  where venue_id is not null;

-- ─────────────────────────────────────────────────────────────
-- PART 5 · pending_uploads — track in-flight presigned URLs
-- so we can enforce quota before the client PUTs to R2.
-- Rows auto-expire via cron (see cleanup function below).
-- ─────────────────────────────────────────────────────────────

create table if not exists public.pending_uploads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  dj_id uuid not null references public.djs on delete cascade,
  target_table text not null check (target_table in ('dj_uploads','dj_clips')),
  r2_bucket text not null,
  r2_key text not null,
  max_size_bytes bigint not null,
  content_type text not null,
  expires_at timestamptz not null,
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  unique (r2_bucket, r2_key)
);

create index if not exists pending_uploads_user_idx
  on public.pending_uploads (user_id, created_at desc)
  where finalized_at is null;

create index if not exists pending_uploads_expires_idx
  on public.pending_uploads (expires_at)
  where finalized_at is null;

-- ─────────────────────────────────────────────────────────────
-- PART 6 · helper function: enforce storage quota for a DJ
-- Returns remaining bytes; throws if quota exceeded.
-- ─────────────────────────────────────────────────────────────

create or replace function public.check_dj_storage_quota(
  p_dj_id uuid,
  p_additional_bytes bigint
) returns bigint
language plpgsql
security definer
as $$
declare
  v_used bigint;
  v_tier text;
  v_quota bigint;
  v_pending bigint;
begin
  select storage_bytes_used, tier into v_used, v_tier
  from public.djs where id = p_dj_id;

  if v_used is null then
    raise exception 'DJ not found' using errcode = 'P0002';
  end if;

  -- Fetch tier-specific quota from app_config
  select coalesce((value::text)::bigint, 0) into v_quota
  from public.app_config
  where key = 'dj_storage_quota_bytes_' || v_tier;

  if v_quota is null or v_quota = 0 then
    v_quota := 5368709120; -- 5 GiB default free tier
  end if;

  -- Reserved bytes from unfinalized pending uploads
  select coalesce(sum(max_size_bytes), 0) into v_pending
  from public.pending_uploads
  where dj_id = p_dj_id
    and finalized_at is null
    and expires_at > now();

  if (v_used + v_pending + p_additional_bytes) > v_quota then
    raise exception 'Storage quota exceeded for DJ % (used=%, pending=%, requested=%, quota=%)',
      p_dj_id, v_used, v_pending, p_additional_bytes, v_quota
      using errcode = 'P0001';
  end if;

  return v_quota - (v_used + v_pending + p_additional_bytes);
end;
$$;

-- ─────────────────────────────────────────────────────────────
-- PART 7 · helper function: cleanup expired pending uploads
-- (call from pg_cron once per hour)
-- ─────────────────────────────────────────────────────────────

create or replace function public.cleanup_expired_pending_uploads()
returns integer
language plpgsql
security definer
as $$
declare
  v_deleted integer;
begin
  delete from public.pending_uploads
  where finalized_at is null
    and expires_at < now() - interval '1 hour';

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- ─────────────────────────────────────────────────────────────
-- PART 8 · triggers: auto-update updated_at
-- ─────────────────────────────────────────────────────────────

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists dj_uploads_touch_updated_at on public.dj_uploads;
create trigger dj_uploads_touch_updated_at
  before update on public.dj_uploads
  for each row execute function public.touch_updated_at();

drop trigger if exists dj_clips_touch_updated_at on public.dj_clips;
create trigger dj_clips_touch_updated_at
  before update on public.dj_clips
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────
-- PART 9 · trigger: keep djs.storage_bytes_used in sync
-- ─────────────────────────────────────────────────────────────

create or replace function public.sync_dj_storage_on_upload_change()
returns trigger
language plpgsql
as $$
declare
  v_dj_id uuid;
  v_delta bigint;
begin
  if tg_op = 'INSERT' then
    v_dj_id := new.dj_id;
    v_delta := coalesce(new.size_bytes, 0);
  elsif tg_op = 'DELETE' then
    v_dj_id := old.dj_id;
    v_delta := -coalesce(old.size_bytes, 0);
  elsif tg_op = 'UPDATE' then
    v_dj_id := new.dj_id;
    v_delta := coalesce(new.size_bytes, 0) - coalesce(old.size_bytes, 0);
  end if;

  if v_delta <> 0 then
    update public.djs
      set storage_bytes_used = greatest(0, storage_bytes_used + v_delta)
      where id = v_dj_id;
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists dj_uploads_sync_storage on public.dj_uploads;
create trigger dj_uploads_sync_storage
  after insert or update of size_bytes or delete on public.dj_uploads
  for each row execute function public.sync_dj_storage_on_upload_change();

drop trigger if exists dj_clips_sync_storage on public.dj_clips;
create trigger dj_clips_sync_storage
  after insert or update of size_bytes or delete on public.dj_clips
  for each row execute function public.sync_dj_storage_on_upload_change();

-- ─────────────────────────────────────────────────────────────
-- PART 10 · trigger: keep counter columns on djs in sync
-- ─────────────────────────────────────────────────────────────

create or replace function public.sync_dj_counters()
returns trigger
language plpgsql
as $$
declare
  v_col text;
begin
  v_col := case tg_table_name
    when 'dj_uploads' then 'uploads_count'
    when 'dj_clips'   then 'clips_count'
  end;

  if tg_op = 'INSERT' then
    execute format('update public.djs set %I = %I + 1 where id = $1', v_col, v_col)
      using new.dj_id;
  elsif tg_op = 'DELETE' then
    execute format('update public.djs set %I = greatest(0, %I - 1) where id = $1', v_col, v_col)
      using old.dj_id;
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists dj_uploads_sync_counter on public.dj_uploads;
create trigger dj_uploads_sync_counter
  after insert or delete on public.dj_uploads
  for each row execute function public.sync_dj_counters();

drop trigger if exists dj_clips_sync_counter on public.dj_clips;
create trigger dj_clips_sync_counter
  after insert or delete on public.dj_clips
  for each row execute function public.sync_dj_counters();

-- ─────────────────────────────────────────────────────────────
-- PART 11 · Row-Level Security
-- ─────────────────────────────────────────────────────────────

alter table public.dj_uploads       enable row level security;
alter table public.dj_clips         enable row level security;
alter table public.pending_uploads  enable row level security;

-- dj_uploads: public visibility allows everyone to read; owner can CRUD
drop policy if exists dj_uploads_read_public on public.dj_uploads;
create policy dj_uploads_read_public on public.dj_uploads
  for select
  using (
    deleted_at is null
    and status = 'active'
    and visibility = 'public'
  );

drop policy if exists dj_uploads_read_own on public.dj_uploads;
create policy dj_uploads_read_own on public.dj_uploads
  for select
  using (auth.uid() = uploaded_by);

drop policy if exists dj_uploads_owner_write on public.dj_uploads;
create policy dj_uploads_owner_write on public.dj_uploads
  for all
  using (auth.uid() = uploaded_by)
  with check (auth.uid() = uploaded_by);

-- dj_clips: same shape
drop policy if exists dj_clips_read_public on public.dj_clips;
create policy dj_clips_read_public on public.dj_clips
  for select
  using (
    deleted_at is null
    and status = 'active'
    and visibility = 'public'
  );

drop policy if exists dj_clips_read_own on public.dj_clips;
create policy dj_clips_read_own on public.dj_clips
  for select
  using (auth.uid() = posted_by);

drop policy if exists dj_clips_owner_write on public.dj_clips;
create policy dj_clips_owner_write on public.dj_clips
  for all
  using (auth.uid() = posted_by)
  with check (auth.uid() = posted_by);

-- pending_uploads: owner-only (service role bypasses RLS anyway)
drop policy if exists pending_uploads_owner on public.pending_uploads;
create policy pending_uploads_owner on public.pending_uploads
  for select
  using (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────
-- PART 12 · app_config seed values
-- ─────────────────────────────────────────────────────────────

-- Seed tunable knobs. Descriptions for each key are documented in
-- supabase/functions/DJ_METADATA_DEPLOY.md.
insert into public.app_config (key, value) values
  ('r2_account_id',                '"unset"'::jsonb),
  ('r2_bucket_dj_uploads',         '"tracklist-dj-uploads"'::jsonb),
  ('r2_bucket_dj_clips',           '"tracklist-dj-clips"'::jsonb),
  ('r2_public_domain_uploads',     '"uploads.tracklist.app"'::jsonb),
  ('r2_public_domain_clips',       '"clips.tracklist.app"'::jsonb),
  ('dj_storage_quota_bytes_free',  '5368709120'::jsonb),
  ('dj_storage_quota_bytes_pro',   '107374182400'::jsonb),
  ('dj_storage_quota_bytes_label', '1099511627776'::jsonb),
  ('dj_upload_max_size_bytes',     '262144000'::jsonb),
  ('dj_clip_max_size_bytes',       '26214400'::jsonb),
  ('dj_clip_max_duration_sec',     '60'::jsonb),
  ('dj_upload_rate_per_day',       '20'::jsonb),
  ('track_metadata_refresh_days',  '90'::jsonb),
  ('track_metadata_negative_ttl_hours', '24'::jsonb)
on conflict (key) do nothing;

commit;
