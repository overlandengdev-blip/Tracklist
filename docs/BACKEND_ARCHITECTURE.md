# Tracklist — Backend Architecture

Living document for the Supabase + Cloudflare R2 backend that powers
track metadata enrichment, DJ profiles, audio uploads, and video clips.
Pair with `supabase/functions/DJ_METADATA_DEPLOY.md` for the deploy
runbook.

---

## 1 · System overview

```mermaid
flowchart LR
  subgraph Client["Client (Expo app / HTML prototype)"]
    A[User records audio]
    B[User uploads set / clip]
    C[User edits DJ profile]
    D[User browses DJ catalog]
  end

  subgraph Edge["Supabase Edge Functions (Deno)"]
    E1[identify-clip]
    E2[get-track-metadata]
    E3[get-r2-upload-url]
    E4[finalize-dj-upload]
    E5[update-dj-profile]
    E6[get-dj-uploads]
  end

  subgraph DB["Postgres + RLS"]
    T1[(tracks)]
    T2[(djs)]
    T3[(dj_uploads)]
    T4[(dj_clips)]
    T5[(pending_uploads)]
    T6[(app_config)]
    T7[(service_tokens)]
  end

  subgraph Ext["External services"]
    X1[ACRCloud / future AI model]
    X2[Spotify Web API]
    X3[Odesli / song.link]
    X4[Cloudflare R2]
  end

  A --> E1 --> X1
  E1 --> T1
  A --> E2
  E2 -. cache miss .-> X2
  E2 -. cache miss .-> X3
  E2 --> T1

  B --> E3 --> T5 --> X4
  B -. PUT direct .-> X4
  B --> E4 --> T3 & T4

  C --> E5 --> T2
  D --> E6 --> T2 & T3 & T4

  E2 -. token cache .-> T7
  E2 & E3 & E4 & E5 & E6 -. config .-> T6
```

Two design principles drive everything:

1. **Zero Supabase egress for media** — files PUT/GET directly against
   Cloudflare R2 via presigned URLs and a CDN custom domain. Supabase
   only handles JSON.
2. **Cache aggressively, fail negatively** — Spotify / Odesli responses
   are written into `tracks` and reused for 90 days; failed lookups are
   pinned for 24 h via `metadata_fetch_failed_at` so we don't hammer
   APIs for tracks that will never resolve.

---

## 2 · Data model

```mermaid
erDiagram
  djs ||--o{ dj_uploads : owns
  djs ||--o{ dj_clips : owns
  djs ||--o{ pending_uploads : reserves
  tracks ||--o{ dj_uploads : "tracklist[]"
  app_config ||--|| service_tokens : "lives alongside"

  djs {
    uuid id PK
    uuid claimed_by_user_id
    text slug
    text name
    text tier "free|pro|label"
    bigint storage_bytes_used
    int uploads_count
    int clips_count
    bool is_accepting_bookings
  }

  tracks {
    uuid id PK
    text isrc
    text spotify_id
    int bpm
    text key_signature
    text camelot
    real energy
    jsonb streaming_links
    timestamptz metadata_fetched_at
    timestamptz metadata_fetch_failed_at
    int metadata_fetch_attempts
    text metadata_source
  }

  dj_uploads {
    uuid id PK
    uuid dj_id FK
    text kind "track|set|mix|edit|bootleg"
    text r2_bucket
    text r2_key
    int size_bytes
    int duration_sec
    text visibility "public|unlisted|private|followers"
    text status "active|processing|failed|removed"
    jsonb tracklist
    timestamptz deleted_at
  }

  dj_clips {
    uuid id PK
    uuid dj_id FK
    text r2_bucket
    text r2_key
    int duration_sec "<=60"
    text visibility
    text status
  }

  pending_uploads {
    uuid id PK
    uuid dj_id FK
    text target_table "dj_uploads|dj_clips"
    text r2_bucket
    text r2_key
    bigint size_bytes
    timestamptz expires_at
    timestamptz finalized_at
  }
```

### Triggers and bookkeeping

```mermaid
flowchart TD
  ins[INSERT INTO dj_uploads] --> trgU[sync_dj_storage_on_upload_change]
  upd[UPDATE deleted_at / size_bytes] --> trgU
  del[DELETE FROM dj_uploads] --> trgU
  trgU --> djs[UPDATE djs SET storage_bytes_used += / -=, uploads_count]

  ins2[INSERT INTO dj_clips] --> trgC[sync_dj_counters]
  del2[DELETE FROM dj_clips] --> trgC
  trgC --> djs

  any[Any UPDATE on djs / dj_uploads / dj_clips] --> trgT[touch_updated_at]
  trgT --> djs
```

`storage_bytes_used`, `uploads_count`, `clips_count`, and `updated_at`
are never written by application code — triggers maintain them so the
counters can't drift from the source of truth.

---

## 3 · Track metadata flow

```mermaid
sequenceDiagram
  autonumber
  participant App
  participant GTM as get-track-metadata
  participant DB as tracks
  participant Spotify
  participant Odesli

  App->>GTM: { track_id | isrc | spotify_id }
  GTM->>DB: SELECT by id/isrc/spotify_id

  alt fresh row (< 90d) and no failure
    DB-->>GTM: track row
    GTM-->>App: track (cache hit)
  else negative-cached (< 24h)
    GTM-->>App: 404 (cache miss, do not retry)
  else stale or missing
    par
      GTM->>Spotify: /tracks/{id}
      GTM->>Spotify: /audio-features/{id}
      GTM->>Odesli: /links?url={spotify}
    end
    alt all succeed
      GTM->>DB: UPSERT tracks SET bpm, key, camelot,<br/>streaming_links, metadata_fetched_at = now()
      GTM-->>App: track (fresh)
    else any failure
      GTM->>DB: UPDATE metadata_fetch_failed_at = now(),<br/>metadata_fetch_attempts += 1
      GTM-->>App: 404
    end
  end
```

**Cost ceiling.** Spotify is called at most once per `(spotify_id, 90d)`.
Odesli is unauthenticated and free. A user identifying the same song
twice in the same week never touches an external API.

---

## 4 · DJ upload flow (audio or video)

```mermaid
sequenceDiagram
  autonumber
  participant App
  participant GU as get-r2-upload-url
  participant DB
  participant R2 as Cloudflare R2
  participant FN as finalize-dj-upload

  App->>GU: { dj_id, target, content_type, size_bytes, filename }
  GU->>DB: SELECT djs WHERE claimed_by_user_id = auth.uid()
  alt not owner
    GU-->>App: 403
  end
  GU->>DB: SELECT check_dj_storage_quota(dj_id, size_bytes)
  alt quota exceeded
    GU-->>App: 413
  end
  GU->>DB: SELECT count(*) FROM pending_uploads + dj_uploads<br/>WHERE created_at >= today
  alt rate cap hit
    GU-->>App: 429
  end
  GU->>DB: INSERT pending_uploads (expires_at = now() + 5min)
  GU->>GU: SigV4 sign PUT to R2 (Content-Type, Content-Length)
  GU-->>App: { upload.url, upload.headers, r2.key, reservation }

  App->>R2: PUT {file} with signed headers
  R2-->>App: 200

  App->>FN: { r2_bucket, r2_key, title, kind, duration_sec, ... }
  FN->>DB: SELECT pending_uploads WHERE r2_key matches AND not expired
  alt mismatch / expired
    FN-->>App: 410
  end
  FN->>DB: INSERT dj_uploads or dj_clips (status=active)
  FN->>DB: UPDATE pending_uploads SET finalized_at = now()
  Note over DB: Trigger updates djs.storage_bytes_used,<br/>uploads_count / clips_count
  FN-->>App: { upload }
```

### Quota reservation — why it matters

```mermaid
flowchart LR
  subgraph Without["Without pending_uploads"]
    P1[Parallel call 1: 4 GiB allowed?] --> Y1[Yes, 4 free]
    P2[Parallel call 2: 4 GiB allowed?] --> Y2[Yes, 4 free]
    P3[Parallel call 3: 4 GiB allowed?] --> Y3[Yes, 4 free]
    Y1 & Y2 & Y3 --> Bust[12 GiB uploaded → quota busted]
  end
  subgraph With["With pending_uploads"]
    Q1[Call 1] --> R1[Reserve 4, used=4]
    Q2[Call 2] --> R2[Reserve 4, used=8]
    Q3[Call 3] --> R3[Reject — would exceed 5 GiB]
  end
```

The reservation row is consumed when `finalize-dj-upload` succeeds, or
swept by `cleanup_expired_pending_uploads()` (pg_cron, hourly) if the
client never finishes the PUT.

---

## 5 · Auth + RLS posture

```mermaid
flowchart TD
  call[Edge function call] --> svc[getServiceClient<br/>service_role JWT]
  svc --> bypass[RLS bypassed for trusted writes]

  read[Direct PostgREST read from app] --> anon[anon JWT]
  anon --> rls[RLS enforced]
  rls --> pub[Public-readable rows only:<br/>visibility=public AND status=active AND deleted_at IS NULL]
  rls --> own[Owner-editable rows:<br/>claimed_by_user_id = auth.uid]

  call --> ownerCheck["Owner verification inside the function:<br/>SELECT djs.claimed_by_user_id == user.id"]
```

- **Service-role client** is used inside edge functions so triggers and
  cross-table updates work uniformly. Each function re-checks ownership
  in code before any mutation.
- **Anon clients** going through PostgREST hit RLS directly — they can
  only read public rows, never write DJ content.
- **Sensitive fields** (`storage_bytes_used`, `tier`, `booking_email`)
  are stripped server-side in `get-dj-uploads` for non-owners.

---

## 6 · Cost model (current defaults)

| Lever | Default | Knob |
|---|---|---|
| Spotify metadata refresh | 90 d | `track_metadata_refresh_days` |
| Negative cache | 24 h | `track_metadata_negative_ttl_hours` |
| Free tier storage | 5 GiB | `dj_storage_quota_bytes_free` |
| Pro tier storage | 100 GiB | `dj_storage_quota_bytes_pro` |
| Label tier storage | 1 TiB | `dj_storage_quota_bytes_label` |
| Audio upload cap | 250 MiB | `dj_upload_max_size_bytes` |
| Video clip cap | 25 MiB / 60 s | `dj_clip_max_size_bytes` / `dj_clip_max_duration_sec` |
| Daily uploads / DJ | 20 | `dj_upload_rate_per_day` |
| Presigned URL TTL | 5 min | (constant in `_shared/r2.ts`) |

All knobs live in `app_config` and can be tuned with one SQL update —
no redeploy.

---

## 7 · Music recognition — pluggable layer

Today: **ACRCloud** (`identify-clip` edge function). Tomorrow: any
model that takes audio → `{ isrc?, spotify_id?, title, artists }`.

```mermaid
flowchart LR
  clip[Audio clip<br/>10–30 s] --> id[identify-clip]
  id -->|today| ACR[ACRCloud REST API]
  id -.->|future| AI[AI model<br/>Shazam-style fingerprint /<br/>OpenAI audio /<br/>self-hosted Wav2Vec]
  ACR --> match[match: isrc, spotify_id, ...]
  AI --> match
  match --> mt[get-track-metadata]
  mt --> richTrack[BPM, key, artwork, streaming links]
```

To swap the recognizer, only `identify-clip` changes. Every downstream
function (`get-track-metadata`, the UI) consumes the same
`{ track_id | isrc | spotify_id }` contract. Candidates:

- **AudD** — paid, works like ACRCloud, simpler API.
- **OpenAI Whisper + audio embeddings** — for *vocals*, not full
  fingerprint matching. Useful as a fallback when fingerprint fails.
- **Self-hosted Olaf / Panako** — open-source acoustic fingerprinting
  if you want zero per-call cost at the price of running a worker.
- **Shazam (RapidAPI proxy)** — unofficial but cheap and accurate;
  contractual risk.

The cleanest migration path: keep ACRCloud as primary, add a fallback
chain in `identify-clip` that tries the new model on ACR misses and
records which engine produced the match in `tracks.metadata_source`.

---

## 8 · File map

```
supabase/
├── migrations/
│   ├── 20260421_track_metadata_and_dj_content.sql   ← schema
│   └── _manual/point_r2_to_dev_domains.sql          ← one-shot config
├── functions/
│   ├── _shared/
│   │   ├── spotify.ts          token cache + audio-features mapping
│   │   ├── r2.ts               pure-Deno SigV4 presigner
│   │   ├── auth.ts             requireAuth / getOptionalUser
│   │   ├── errors.ts           typed Errors.* + errorResponse
│   │   ├── validation.ts       parseBody, requireUUID, optionalEnum, …
│   │   ├── cors.ts             corsResponse + headers
│   │   └── logging.ts          createLogger
│   ├── identify-clip/          (existing — ACRCloud)
│   ├── get-track-metadata/     cache-first metadata enrichment
│   ├── get-r2-upload-url/      presigned PUT + quota reservation
│   ├── finalize-dj-upload/     reservation → dj_uploads / dj_clips row
│   ├── update-dj-profile/      whitelisted DJ profile patch
│   ├── get-dj-uploads/         paginated public/owner DJ feed
│   └── DJ_METADATA_DEPLOY.md   deploy runbook
docs/
└── BACKEND_ARCHITECTURE.md     ← this file
```

---

## 9 · Operational checklist

- **Cleanup job** — `cleanup_expired_pending_uploads()` on pg_cron
  hourly. Drops dead reservations so quota frees up.
- **Spotify token** — refreshed by `get-track-metadata` on demand,
  cached in `service_tokens` table (60 min TTL).
- **R2 buckets** — `tracklist-dj-uploads`, `tracklist-dj-clips`. CORS
  pre-set for PUT/GET/HEAD from any origin (PUTs are gated by SigV4,
  not CORS).
- **CDN domains** — `app_config.r2_public_domain_uploads` and
  `r2_public_domain_clips`. Either Cloudflare custom domains
  (`uploads.tracklist.app`, `clips.tracklist.app`) or the auto-issued
  `pub-xxxxxxxx.r2.dev` hostnames.

---

## 10 · Diagrams render where?

This file uses [Mermaid](https://mermaid.js.org/) code blocks. They
render natively on:

- GitHub (web) — every `mermaid` fence becomes an SVG.
- VS Code with the *Markdown Preview Mermaid Support* extension.
- Obsidian, Notion (via paste-as-Mermaid), most modern wikis.

If you ever need static images (slide deck, PDF), copy the fenced
block into <https://mermaid.live> and export SVG/PNG.
