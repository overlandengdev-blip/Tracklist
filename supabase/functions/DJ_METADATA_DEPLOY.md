# DJ content + track-metadata backend — deploy notes

One migration + two shared helpers + five edge functions. Designed to cost
near-zero in API calls and egress bandwidth. See each function header for
its specific contract.

## 1 · Run the migration

```bash
supabase db push
```

File: `supabase/migrations/20260421_track_metadata_and_dj_content.sql`

This:

- Adds Spotify audio-feature columns + `streaming_links` jsonb + cache
  bookkeeping to `public.tracks`.
- Adds tier/quota/counter columns to `public.djs`.
- Creates `public.dj_uploads` (audio), `public.dj_clips` (video),
  `public.pending_uploads` (in-flight reservations).
- Creates helper SQL functions `check_dj_storage_quota()` and
  `cleanup_expired_pending_uploads()`.
- Installs triggers to keep `storage_bytes_used`, `uploads_count`,
  `clips_count`, and `updated_at` in sync automatically.
- Enables RLS on the new tables with public-read / owner-write policies.
- Seeds `app_config` with R2 bucket names, quota defaults, and upload caps.

## 2 · Set secrets (Supabase → Project Settings → Edge Functions → Secrets)

### Spotify (already used by `spotify-search` — reuse existing secret)
| Name | Source |
|---|---|
| `SPOTIFY_CLIENT_ID` | dashboard.spotify.com/developer |
| `SPOTIFY_CLIENT_SECRET` | same |

### Cloudflare R2 (new)
| Name | Source |
|---|---|
| `R2_ACCOUNT_ID` | Cloudflare dash → R2 → right sidebar |
| `R2_ACCESS_KEY_ID` | R2 → Manage API Tokens → Create, permission = **Object Read & Write** scoped to the two buckets |
| `R2_SECRET_ACCESS_KEY` | same |

No Odesli key — the song.link API is free and unauthenticated.

## 3 · Create the R2 buckets

Names must match `app_config` (defaults assume):

- `tracklist-dj-uploads` — audio sets / tracks
- `tracklist-dj-clips` — video clips

Enable **Custom Domain** on each (Cloudflare dash → R2 → bucket → Settings
→ Public access → connect domain). Wildcard `uploads.tracklist.app` and
`clips.tracklist.app` are the defaults — change them in `app_config`
(`r2_public_domain_uploads`, `r2_public_domain_clips`) if you use
different hostnames.

CORS on each bucket (bucket → Settings → CORS policy):

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type", "content-length"],
    "ExposeHeaders": ["etag"],
    "MaxAgeSeconds": 3600
  }
]
```

## 4 · Deploy the edge functions

```bash
supabase functions deploy get-track-metadata
supabase functions deploy get-r2-upload-url
supabase functions deploy finalize-dj-upload
supabase functions deploy update-dj-profile
supabase functions deploy get-dj-uploads
```

## 5 · Schedule the cleanup job

Run `cleanup_expired_pending_uploads()` hourly via `pg_cron`:

```sql
select cron.schedule(
  'cleanup-pending-uploads',
  '0 * * * *',
  $$select public.cleanup_expired_pending_uploads();$$
);
```

## 6 · Client flow (Expo)

### Identify → rich metadata
```ts
// After identify-clip returns a matched track_id OR a spotify_id:
const { track } = await invoke('get-track-metadata', { track_id });
// track.bpm, track.key, track.camelot, track.artwork_url,
// track.streaming_links.{spotify, appleMusic, soundcloud, youtube, ...}
```

### DJ uploads a track/clip
```ts
// 1. Ask backend for a presigned URL
const { upload, r2, reservation } = await invoke('get-r2-upload-url', {
  dj_id,
  target: 'dj_uploads',          // or 'dj_clips' for video
  content_type: file.mimeType,
  size_bytes: file.size,
  filename: file.name,
});

// 2. PUT the file directly to R2 (zero Supabase bandwidth)
await fetch(upload.url, {
  method: 'PUT',
  headers: upload.headers,       // MUST match Content-Type + Content-Length
  body: file.blob,
});

// 3. Commit the DB row
const { upload: row } = await invoke('finalize-dj-upload', {
  r2_bucket: r2.bucket,
  r2_key: r2.key,
  title,
  kind: 'track',
  duration_sec,
  bpm,
  key_signature,
  genre,
});
// Row is now queryable at r2.public_url via the CDN.
```

### Browse a DJ's catalog
```ts
const { dj, uploads, clips } = await invoke('get-dj-uploads', {
  dj_id,
  kind: 'all',       // or 'audio' / 'video'
  limit: 20,
});
```

### Update own DJ profile
```ts
await invoke('update-dj-profile', {
  dj_id,
  bio, avatar_url, cover_image_url, booking_email,
  soundcloud_url, instagram, genres, is_accepting_bookings,
});
```

## 7 · Cost ceilings baked in

| Lever | Default | `app_config` key |
|---|---|---|
| Free-tier storage per DJ | 5 GiB | `dj_storage_quota_bytes_free` |
| Pro-tier storage per DJ | 100 GiB | `dj_storage_quota_bytes_pro` |
| Label-tier storage per DJ | 1 TiB | `dj_storage_quota_bytes_label` |
| Max single audio upload | 250 MiB | `dj_upload_max_size_bytes` |
| Max single video clip | 25 MiB | `dj_clip_max_size_bytes` |
| Max video clip length | 60 s | `dj_clip_max_duration_sec` |
| Uploads per DJ per day | 20 | `dj_upload_rate_per_day` |
| Spotify metadata refresh | 90 days | `track_metadata_refresh_days` |
| Negative-cache TTL | 24 hours | `track_metadata_negative_ttl_hours` |

Tune any of these live without a deploy:
```sql
update public.app_config set value = '30'::jsonb where key = 'dj_upload_rate_per_day';
```

## 8 · Security properties

- **RLS**: All new tables have row-level security on. Public content is
  world-readable; private/unlisted/followers-only hidden; owner always sees
  their own rows.
- **Presigned URLs**: 5-minute expiry. Signed headers include
  `Content-Length` and `Content-Type` — uploader cannot swap in a larger
  or different-type file. Key path includes a server-generated UUID, so
  one user cannot guess or overwrite another's objects.
- **Quota reservation**: Size is reserved in `pending_uploads` the moment
  the URL is issued, so a flurry of parallel presign calls can't bypass
  the storage cap.
- **Negative metadata cache**: Back-off prevents hammering Spotify on
  white-label or bootleg tracks that will never resolve.
- **Spotify token**: Shared via `service_tokens`; one client-credentials
  refresh per deploy per hour, cached in Postgres.
