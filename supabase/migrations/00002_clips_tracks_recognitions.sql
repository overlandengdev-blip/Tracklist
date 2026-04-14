-- ============================================
-- TRACKS — the canonical track library
-- ============================================
create table public.tracks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  artist text not null,
  isrc text unique,
  spotify_id text,
  soundcloud_url text,
  artwork_url text,
  created_at timestamptz not null default now()
);

alter table public.tracks enable row level security;

-- Any authenticated user can read tracks
create policy "Authenticated users can read tracks"
  on public.tracks for select
  to authenticated
  using (true);

-- Only service_role can insert (edge functions use service key)
-- No RLS policy needed — service_role bypasses RLS by default


-- ============================================
-- CLIPS — one per recording
-- ============================================
create table public.clips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  audio_path text not null,
  duration_seconds integer not null,
  status text not null default 'pending'
    check (status in ('pending', 'matched', 'unmatched', 'community')),
  matched_track_id uuid references public.tracks,
  venue_name text,
  recorded_at timestamptz not null default now(),
  is_public boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.clips enable row level security;

-- Users can do everything with their own clips
create policy "Users can insert their own clips"
  on public.clips for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users can read their own clips"
  on public.clips for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can update their own clips"
  on public.clips for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own clips"
  on public.clips for delete
  to authenticated
  using (auth.uid() = user_id);

-- Anyone authenticated can read public clips
create policy "Authenticated users can read public clips"
  on public.clips for select
  to authenticated
  using (is_public = true);


-- ============================================
-- RECOGNITIONS — one per identification attempt
-- ============================================
create table public.recognitions (
  id uuid primary key default gen_random_uuid(),
  clip_id uuid not null references public.clips on delete cascade,
  service text not null check (service in ('acrcloud', 'audd')),
  raw_response jsonb,
  matched_track_id uuid references public.tracks,
  confidence numeric,
  attempted_at timestamptz not null default now()
);

alter table public.recognitions enable row level security;

-- Users can read recognitions for their own clips
create policy "Users can read recognitions for own clips"
  on public.recognitions for select
  to authenticated
  using (
    exists (
      select 1 from public.clips
      where clips.id = recognitions.clip_id
        and clips.user_id = auth.uid()
    )
  );

-- Only service_role inserts recognitions (bypasses RLS by default)


-- ============================================
-- STORAGE — audio-clips bucket
-- ============================================
insert into storage.buckets (id, name, public)
  values ('audio-clips', 'audio-clips', false);

-- Users can upload to their own folder: {user_id}/*
create policy "Users can upload to own folder"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'audio-clips'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Users can read their own files
create policy "Users can read own audio"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'audio-clips'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Users can delete their own files
create policy "Users can delete own audio"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'audio-clips'
    and (storage.foldername(name))[1] = auth.uid()::text
  );


-- ============================================
-- REALTIME — enable for clip status updates
-- ============================================
alter publication supabase_realtime add table public.clips;
