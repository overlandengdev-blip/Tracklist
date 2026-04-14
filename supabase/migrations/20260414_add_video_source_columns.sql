-- ============================================================
-- Add video-source columns to clips for camera roll uploads
-- ============================================================

BEGIN;

-- New columns for video source tracking
alter table public.clips
  add column if not exists source_type text not null default 'live_recording'
    check (source_type in ('live_recording', 'camera_roll_upload')),
  add column if not exists has_video boolean not null default false,
  add column if not exists video_provider text
    check (video_provider in ('cloudflare_stream', 'bunny', 'mux') or video_provider is null),
  add column if not exists video_id text,
  add column if not exists video_duration_seconds numeric,
  add column if not exists thumbnail_url text,
  add column if not exists original_filename text,
  add column if not exists clip_start_offset_seconds numeric not null default 0;

-- Index for filtering by source type (useful for analytics)
create index if not exists idx_clips_source_type on public.clips (source_type);

-- Add temp-video storage bucket for server-side extraction
-- Videos are uploaded here temporarily, extracted to audio, then deleted
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('temp-video', 'temp-video', false, 104857600,
  array['video/mp4', 'video/quicktime', 'video/x-m4v', 'video/3gpp'])
on conflict (id) do nothing;

-- Storage policies for temp-video: same pattern as audio-clips
create policy "temp_video_upload_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'temp-video'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "temp_video_read_own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'temp-video'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "temp_video_delete_own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'temp-video'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Update schema version
insert into public.schema_version (version, description)
values ('1.1.0', 'Add video-source columns to clips, temp-video storage bucket');

COMMIT;
