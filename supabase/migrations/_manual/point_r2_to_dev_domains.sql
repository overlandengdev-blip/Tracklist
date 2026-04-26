-- Run this once, AFTER you've enabled public access on each R2 bucket and
-- have the pub-xxxxxxx.r2.dev hostnames. Replace the placeholders below,
-- then run it via `supabase db query < path/to/this/file.sql` or paste
-- into the Supabase SQL editor.

update public.app_config
  set value = to_jsonb('pub-REPLACE_UPLOADS.r2.dev'::text)
  where key = 'r2_public_domain_uploads';

update public.app_config
  set value = to_jsonb('pub-REPLACE_CLIPS.r2.dev'::text)
  where key = 'r2_public_domain_clips';

-- Bucket names only need changing if you chose different ones in Cloudflare.
-- Defaults: tracklist-dj-uploads and tracklist-dj-clips.

-- Sanity check
select key, value from public.app_config
  where key like 'r2_%'
  order by key;
