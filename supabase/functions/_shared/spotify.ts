import { getServiceClient } from "./supabase-admin.ts";

/**
 * Shared Spotify helpers.
 * Access tokens are cached in `service_tokens` (TTL ~1h, refreshed on miss).
 * Every consumer of Spotify should go through here so we never have more than
 * one token in flight per deploy.
 */

/**
 * Client-credentials flow — returns an access token valid for ~1h.
 * Returns `null` if credentials are not configured (feature-off rather than error).
 */
export async function getSpotifyToken(): Promise<string | null> {
  const clientId = Deno.env.get("SPOTIFY_CLIENT_ID");
  const clientSecret = Deno.env.get("SPOTIFY_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;

  const supabase = getServiceClient();

  // Cached token
  const { data: cached } = await supabase
    .from("service_tokens")
    .select("access_token, expires_at")
    .eq("service", "spotify")
    .maybeSingle();

  if (cached && new Date(cached.expires_at).getTime() > Date.now() + 30_000) {
    return cached.access_token as string;
  }

  // Refresh
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

  await supabase.from("service_tokens").upsert({
    service: "spotify",
    access_token: tokenData.access_token,
    expires_at: expiresAt,
    refreshed_at: new Date().toISOString(),
  });

  return tokenData.access_token as string;
}

export interface SpotifyAudioFeatures {
  bpm: number | null;
  key: string | null;
  camelot: string | null;
  mode: "major" | "minor" | null;
  energy: number | null;
  danceability: number | null;
  valence: number | null;
  time_signature: number | null;
  duration_ms: number | null;
}

export interface SpotifyTrackMeta {
  spotify_id: string;
  title: string;
  artist: string;
  album: string | null;
  artwork_url: string | null;
  release_date: string | null;
  duration_ms: number | null;
  isrc: string | null;
  preview_url: string | null;
}

/** GET /v1/tracks/{id} */
export async function fetchSpotifyTrack(
  spotifyId: string,
  token: string,
): Promise<SpotifyTrackMeta | null> {
  const r = await fetch(`https://api.spotify.com/v1/tracks/${spotifyId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const t = await r.json();
  return {
    spotify_id: t.id,
    title: t.name,
    artist:
      t.artists?.map((a: { name: string }) => a.name).join(", ") ?? "Unknown",
    album: t.album?.name ?? null,
    artwork_url: t.album?.images?.[0]?.url ?? null,
    release_date: t.album?.release_date ?? null,
    duration_ms: t.duration_ms ?? null,
    isrc: t.external_ids?.isrc ?? null,
    preview_url: t.preview_url ?? null,
  };
}

/** GET /v1/audio-features/{id} */
export async function fetchSpotifyAudioFeatures(
  spotifyId: string,
  token: string,
): Promise<SpotifyAudioFeatures | null> {
  const r = await fetch(
    `https://api.spotify.com/v1/audio-features/${spotifyId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!r.ok) return null;
  const f = await r.json();
  return {
    bpm: typeof f.tempo === "number" ? Math.round(f.tempo) : null,
    key: pitchClassToKey(f.key, f.mode),
    camelot: pitchClassToCamelot(f.key, f.mode),
    mode: f.mode === 1 ? "major" : f.mode === 0 ? "minor" : null,
    energy: typeof f.energy === "number" ? f.energy : null,
    danceability: typeof f.danceability === "number" ? f.danceability : null,
    valence: typeof f.valence === "number" ? f.valence : null,
    time_signature: typeof f.time_signature === "number" ? f.time_signature : null,
    duration_ms: f.duration_ms ?? null,
  };
}

// Spotify returns key as pitch class 0-11, mode 0/1 (minor/major).
const PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function pitchClassToKey(pc: number, mode: number): string | null {
  if (pc < 0 || pc > 11) return null;
  return `${PITCH_NAMES[pc]} ${mode === 1 ? "maj" : "min"}`;
}

// Camelot wheel mapping — widely used in DJ software.
const CAMELOT_MAJOR = ["8B","3B","10B","5B","12B","7B","2B","9B","4B","11B","6B","1B"];
const CAMELOT_MINOR = ["5A","12A","7A","2A","9A","4A","11A","6A","1A","8A","3A","10A"];

function pitchClassToCamelot(pc: number, mode: number): string | null {
  if (pc < 0 || pc > 11) return null;
  return mode === 1 ? CAMELOT_MAJOR[pc] : CAMELOT_MINOR[pc];
}
