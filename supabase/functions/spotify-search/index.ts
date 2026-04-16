import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAuth } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import { parseBody, requireString, optionalPositiveInt } from "../_shared/validation.ts";
import { enforceRateLimit, recordRateLimitEvent, getFeatureFlag } from "../_shared/rate-limit.ts";
import { createLogger } from "../_shared/logging.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("spotify-search");

  try {
    const user = await requireAuth(req);
    const body = await parseBody(req);

    const query = requireString(body, "query", { maxLength: 200, minLength: 1 });
    const limit = optionalPositiveInt(body, "limit", { max: 50, defaultValue: 20 });
    const offset = optionalPositiveInt(body, "offset", { max: 1000, defaultValue: 0 });

    // Check if Spotify integration is enabled
    const spotifyEnabled = await getFeatureFlag("spotify_enabled", false);
    if (!spotifyEnabled) {
      throw Errors.serviceUnavailable(
        "Spotify search is currently disabled. You can still propose tracks using freeform title/artist.",
      );
    }

    // Rate limit: generous for search (100/day)
    await enforceRateLimit(user.id, "spotify_search", 100, 1440);

    // Get Spotify access token
    const token = await getSpotifyToken();
    if (!token) {
      throw Errors.serviceUnavailable(
        "Spotify credentials not configured. Use freeform title/artist to propose tracks.",
      );
    }

    // Search Spotify
    const searchUrl = new URL("https://api.spotify.com/v1/search");
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("type", "track");
    searchUrl.searchParams.set("limit", String(limit));
    searchUrl.searchParams.set("offset", String(offset));
    // Bias toward electronic/dance music genres
    searchUrl.searchParams.set("market", "US");

    const response = await fetch(searchUrl.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      const errBody = await response.text();
      log.error("Spotify API error", {
        status: response.status,
        body: errBody,
        user_id: user.id,
      });

      if (response.status === 429) {
        throw Errors.rateLimited("Spotify API rate limit reached. Please try again in a moment.");
      }

      throw Errors.internal("Spotify search failed");
    }

    const data = await response.json();
    const tracks = (data.tracks?.items ?? []).map(formatSpotifyTrack);

    // Record rate limit event
    await recordRateLimitEvent(user.id, "spotify_search");

    log.info("Spotify search completed", {
      user_id: user.id,
      query,
      results_count: tracks.length,
      total: data.tracks?.total ?? 0,
    });

    return jsonResponse({
      tracks,
      total: data.tracks?.total ?? 0,
      limit,
      offset,
    });
  } catch (err) {
    log.error("Spotify search failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});

// ── Helpers ─────────────────────────────────────────────────────

interface SpotifyTrackResult {
  spotify_id: string;
  title: string;
  artist: string;
  artists: { id: string; name: string }[];
  album: string;
  album_artwork_url: string | null;
  release_date: string | null;
  duration_ms: number;
  isrc: string | null;
  preview_url: string | null;
}

function formatSpotifyTrack(
  // deno-lint-ignore no-explicit-any
  track: any,
): SpotifyTrackResult {
  return {
    spotify_id: track.id,
    title: track.name,
    artist:
      track.artists?.map((a: { name: string }) => a.name).join(", ") ??
      "Unknown",
    artists:
      track.artists?.map((a: { id: string; name: string }) => ({
        id: a.id,
        name: a.name,
      })) ?? [],
    album: track.album?.name ?? "Unknown",
    album_artwork_url: track.album?.images?.[0]?.url ?? null,
    release_date: track.album?.release_date ?? null,
    duration_ms: track.duration_ms ?? 0,
    isrc: track.external_ids?.isrc ?? null,
    preview_url: track.preview_url ?? null,
  };
}

/**
 * Get a valid Spotify access token.
 * Uses Client Credentials flow with token caching in service_tokens table.
 */
async function getSpotifyToken(): Promise<string | null> {
  const clientId = Deno.env.get("SPOTIFY_CLIENT_ID");
  const clientSecret = Deno.env.get("SPOTIFY_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;

  const supabase = getServiceClient();

  // Check cached token
  const { data: cached } = await supabase
    .from("service_tokens")
    .select("access_token, expires_at")
    .eq("service", "spotify")
    .single();

  if (cached && new Date(cached.expires_at) > new Date()) {
    return cached.access_token;
  }

  // Refresh via Client Credentials flow
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) return null;

  const tokenData = await response.json();
  const expiresAt = new Date(
    Date.now() + (tokenData.expires_in - 60) * 1000,
  ).toISOString();

  // Upsert cached token
  await supabase.from("service_tokens").upsert({
    service: "spotify",
    access_token: tokenData.access_token,
    expires_at: expiresAt,
    refreshed_at: new Date().toISOString(),
  });

  return tokenData.access_token;
}
