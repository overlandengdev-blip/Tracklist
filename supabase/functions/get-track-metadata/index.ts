import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAuth } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import { parseBody, optionalUUID, optionalString } from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";
import { getConfigValue } from "../_shared/rate-limit.ts";
import {
  getSpotifyToken,
  fetchSpotifyTrack,
  fetchSpotifyAudioFeatures,
  type SpotifyAudioFeatures,
  type SpotifyTrackMeta,
} from "../_shared/spotify.ts";

/**
 * get-track-metadata
 *
 * Given a track identifier (`track_id`, `isrc`, or `spotify_id`), return the
 * enriched metadata (artwork, BPM, key, camelot, streaming links…). On cache
 * miss, fetch from Spotify + Odesli exactly once and persist to `tracks`.
 *
 * Cost model:
 *   • Cache hit  → 1 DB read, 0 external calls.
 *   • Cache miss → 1 Spotify token fetch (cached 1h), 2 Spotify API calls,
 *                  1 Odesli call — all free tier, then persisted forever.
 *
 * Negative caching:
 *   If external APIs fail, `metadata_fetch_failed_at` is written so we don't
 *   hammer them; re-attempts after `track_metadata_negative_ttl_hours`.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("get-track-metadata");

  try {
    await requireAuth(req);
    const body = await parseBody(req);

    const trackId = optionalUUID(body, "track_id");
    const isrc = optionalString(body, "isrc", { maxLength: 20 });
    const spotifyId = optionalString(body, "spotify_id", { maxLength: 40 });
    const forceRefresh = body.force_refresh === true;

    if (!trackId && !isrc && !spotifyId) {
      throw Errors.badRequest(
        "Must provide one of: track_id, isrc, spotify_id",
      );
    }

    const supabase = getServiceClient();

    // ── 1. Lookup existing track row ─────────────────────────
    let query = supabase.from("tracks").select("*").limit(1);
    if (trackId) query = query.eq("id", trackId);
    else if (isrc) query = query.eq("isrc", isrc.toUpperCase());
    else if (spotifyId) query = query.eq("spotify_id", spotifyId);

    const { data: existing } = await query.maybeSingle();

    // ── 2. Freshness check ──────────────────────────────────
    const refreshDays = await getConfigValue("track_metadata_refresh_days", 90);
    const negativeTtlHours = await getConfigValue(
      "track_metadata_negative_ttl_hours",
      24,
    );
    const refreshMs = refreshDays * 86_400_000;
    const negativeTtlMs = negativeTtlHours * 3_600_000;

    if (existing && !forceRefresh) {
      const fetchedAt = existing.metadata_fetched_at
        ? new Date(existing.metadata_fetched_at).getTime()
        : 0;
      const failedAt = existing.metadata_fetch_failed_at
        ? new Date(existing.metadata_fetch_failed_at).getTime()
        : 0;

      // Cache hit: fresh metadata
      if (fetchedAt && Date.now() - fetchedAt < refreshMs) {
        return jsonResponse({ track: existing, cache: "hit" });
      }

      // Negative cache: recent failure, don't retry yet
      if (failedAt && Date.now() - failedAt < negativeTtlMs) {
        return jsonResponse({ track: existing, cache: "negative" });
      }
    }

    // ── 3. Fetch fresh metadata from Spotify ────────────────
    const spotifyIdToFetch =
      spotifyId || existing?.spotify_id || null;

    if (!spotifyIdToFetch) {
      // Without a Spotify ID we can't enrich. If we have an existing row
      // return it as-is; otherwise 404.
      if (existing) {
        return jsonResponse({ track: existing, cache: "no_spotify_id" });
      }
      throw Errors.notFound("Track");
    }

    const token = await getSpotifyToken();
    if (!token) {
      // Spotify disabled — fall back to existing row or 503
      if (existing) {
        return jsonResponse({ track: existing, cache: "spotify_disabled" });
      }
      throw Errors.serviceUnavailable(
        "Spotify credentials not configured; track metadata unavailable.",
      );
    }

    const [trackMeta, features] = await Promise.all([
      fetchSpotifyTrack(spotifyIdToFetch, token),
      fetchSpotifyAudioFeatures(spotifyIdToFetch, token),
    ]);

    if (!trackMeta) {
      // Record failure for negative caching
      if (existing) {
        await supabase
          .from("tracks")
          .update({
            metadata_fetch_failed_at: new Date().toISOString(),
            metadata_fetch_attempts: (existing.metadata_fetch_attempts ?? 0) + 1,
          })
          .eq("id", existing.id);
      }
      throw Errors.notFound("Track on Spotify");
    }

    // ── 4. Fetch universal streaming links from Odesli (best-effort) ──
    const streamingLinks = await fetchOdesliLinks(spotifyIdToFetch);

    // ── 5. Upsert enriched data ─────────────────────────────
    const upsertPayload = buildUpsertPayload(trackMeta, features, streamingLinks, existing);

    let saved;
    if (existing) {
      const { data, error } = await supabase
        .from("tracks")
        .update(upsertPayload)
        .eq("id", existing.id)
        .select()
        .single();
      if (error) throw Errors.internal(`Failed to save metadata: ${error.message}`);
      saved = data;
    } else {
      const { data, error } = await supabase
        .from("tracks")
        .insert(upsertPayload)
        .select()
        .single();
      if (error) throw Errors.internal(`Failed to save metadata: ${error.message}`);
      saved = data;
    }

    log.info("Track metadata refreshed", {
      track_id: saved.id,
      spotify_id: spotifyIdToFetch,
      had_features: !!features,
      had_odesli: Object.keys(streamingLinks).length > 0,
    });

    return jsonResponse({ track: saved, cache: "miss" });
  } catch (err) {
    log.error("get-track-metadata failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});

// ─────────────────────────────────────────────────────────────

function buildUpsertPayload(
  meta: SpotifyTrackMeta,
  features: SpotifyAudioFeatures | null,
  streamingLinks: Record<string, string>,
  existing: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return {
    // Identity (only set if missing — never overwrite a manual correction)
    title: existing?.title ?? meta.title,
    artist: existing?.artist ?? meta.artist,
    release: existing?.release ?? meta.album,
    isrc: meta.isrc ?? existing?.isrc ?? null,
    spotify_id: meta.spotify_id,
    artwork_url: meta.artwork_url ?? existing?.artwork_url ?? null,
    release_date: meta.release_date ?? existing?.release_date ?? null,
    duration_ms: meta.duration_ms ?? existing?.duration_ms ?? null,
    preview_url: meta.preview_url,

    // Audio features (always refresh; Spotify may improve over time)
    bpm: features?.bpm ?? existing?.bpm ?? null,
    key: features?.key ?? existing?.key ?? null,
    camelot: features?.camelot ?? null,
    energy: features?.energy ?? null,
    danceability: features?.danceability ?? null,
    valence: features?.valence ?? null,
    time_signature: features?.time_signature ?? null,

    // Streaming links merged (don't drop manually-added URLs)
    streaming_links: {
      ...(typeof existing?.streaming_links === "object" && existing?.streaming_links ? existing.streaming_links : {}),
      ...streamingLinks,
    },

    // Cache bookkeeping
    metadata_fetched_at: new Date().toISOString(),
    metadata_fetch_failed_at: null,
    metadata_source: "spotify",
  };
}

/**
 * Odesli (song.link) — free, no API key.
 *   https://api.song.link/v1-alpha.1/links?platform=spotify&id=<id>&type=song
 * Returns a map of { spotify, appleMusic, youtube, soundcloud, tidal, deezer, amazonMusic }
 * where each value is the public URL on that platform.
 * Best-effort — silent empty-map on any failure.
 */
async function fetchOdesliLinks(
  spotifyId: string,
): Promise<Record<string, string>> {
  try {
    const url = new URL("https://api.song.link/v1-alpha.1/links");
    url.searchParams.set("platform", "spotify");
    url.searchParams.set("type", "song");
    url.searchParams.set("id", spotifyId);

    const r = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!r.ok) return {};

    const data = await r.json();
    const out: Record<string, string> = {};
    const links = data?.linksByPlatform ?? {};
    for (const [platform, info] of Object.entries(links)) {
      const entry = info as { url?: string };
      if (entry?.url) out[platform] = entry.url;
    }
    return out;
  } catch {
    return {};
  }
}
