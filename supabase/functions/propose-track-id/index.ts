import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAuth } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import {
  parseBody,
  requireUUID,
  optionalUUID,
  optionalString,
  optionalEnum,
} from "../_shared/validation.ts";
import {
  enforceRateLimit,
  recordRateLimitEvent,
  getConfigValue,
  getFeatureFlag,
} from "../_shared/rate-limit.ts";
import { createLogger } from "../_shared/logging.ts";
import { sendNotification } from "../_shared/notifications.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("propose-track-id");

  try {
    const user = await requireAuth(req);
    const body = await parseBody(req);

    const clipId = requireUUID(body, "clip_id");
    const trackId = optionalUUID(body, "track_id");
    const spotifyId = optionalString(body, "spotify_id", { maxLength: 50 });
    const confidence = optionalEnum(body, "confidence", [
      "guessing",
      "pretty_sure",
      "certain",
    ] as const) ?? "pretty_sure";

    // Freeform fields
    const freeformTitle = optionalString(body, "freeform_title", {
      maxLength: 300,
    });
    const freeformArtist = optionalString(body, "freeform_artist", {
      maxLength: 300,
    });
    const freeformNotes = optionalString(body, "freeform_notes", {
      maxLength: 1000,
    });

    // Must provide at least one identification method
    if (!trackId && !spotifyId && !freeformTitle) {
      throw Errors.badRequest(
        "Must provide at least one of: track_id, spotify_id, or freeform_title",
      );
    }

    const supabase = getServiceClient();

    // Check community ID feature flag
    const communityEnabled = await getFeatureFlag(
      "community_id_enabled",
      true,
    );
    if (!communityEnabled) {
      throw Errors.serviceUnavailable(
        "Community identification is currently disabled",
      );
    }

    // Rate limit
    const maxProposals = await getConfigValue("max_proposals_per_day", 50);
    await enforceRateLimit(user.id, "propose_track_id", maxProposals, 1440);

    // Verify clip exists, is public, and not already resolved
    const { data: clip, error: clipError } = await supabase
      .from("clips")
      .select("id, user_id, status, is_public")
      .eq("id", clipId)
      .single();

    if (clipError || !clip) throw Errors.notFound("Clip");

    if (!clip.is_public) {
      throw Errors.forbidden("Clip is not public — cannot propose ID");
    }

    if (clip.status === "matched" || clip.status === "resolved") {
      throw Errors.conflict(
        `Clip already has a confirmed ID (status: ${clip.status})`,
      );
    }

    // Resolve track_id from the various input methods
    let resolvedTrackId: string | null = trackId ?? null;

    // If spotify_id provided but no track_id, look up or create track
    if (!resolvedTrackId && spotifyId) {
      // Check if track with this spotify_id already exists
      const { data: existingTrack } = await supabase
        .from("tracks")
        .select("id")
        .eq("spotify_id", spotifyId)
        .single();

      if (existingTrack) {
        resolvedTrackId = existingTrack.id;
      } else {
        // Try to fetch from Spotify if enabled
        const spotifyEnabled = await getFeatureFlag("spotify_enabled", false);

        if (spotifyEnabled) {
          const trackData = await fetchSpotifyTrack(spotifyId);
          if (trackData) {
            const { data: newTrackId } = await supabase.rpc(
              "find_or_create_track",
              {
                p_title: trackData.title,
                p_artist: trackData.artist,
                p_spotify_id: spotifyId,
                p_artwork_url: trackData.artwork_url ?? null,
                p_isrc: trackData.isrc ?? null,
                p_label: trackData.label ?? null,
                p_remixer: null,
                p_genres: null,
                p_metadata: { spotify_data: trackData.raw },
              },
            );
            resolvedTrackId = newTrackId;
          }
        }

        // If Spotify not enabled or fetch failed, create a minimal track from spotify_id
        if (!resolvedTrackId && freeformTitle) {
          const { data: newTrackId } = await supabase.rpc(
            "find_or_create_track",
            {
              p_title: freeformTitle,
              p_artist: freeformArtist ?? "Unknown",
              p_spotify_id: spotifyId,
              p_isrc: null,
              p_remixer: null,
              p_label: null,
              p_artwork_url: null,
              p_genres: null,
              p_metadata: {},
            },
          );
          resolvedTrackId = newTrackId;
        }
      }
    }

    // Insert community_id
    // The handle_community_id_dedup trigger will auto-upvote if duplicate
    const { data: communityId, error: insertError } = await supabase
      .from("community_ids")
      .insert({
        clip_id: clipId,
        proposed_by: user.id,
        track_id: resolvedTrackId,
        freeform_title: freeformTitle ?? null,
        freeform_artist: freeformArtist ?? null,
        freeform_notes: freeformNotes ?? null,
        confidence,
      })
      .select(
        "id, clip_id, proposed_by, track_id, freeform_title, freeform_artist, freeform_notes, confidence, upvotes_count, downvotes_count, is_accepted, created_at",
      )
      .single();

    // The dedup trigger returns NULL if it converted to an upvote
    if (!communityId) {
      log.info("Proposal converted to upvote by dedup trigger", {
        clip_id: clipId,
        user_id: user.id,
      });

      return jsonResponse({
        message:
          "An identical proposal already exists — your support was added as an upvote instead.",
        deduplicated: true,
      });
    }

    if (insertError) {
      throw Errors.internal(
        `Failed to insert community ID: ${insertError.message}`,
      );
    }

    // Record rate limit event
    await recordRateLimitEvent(user.id, "propose_track_id");

    // Notify clip owner (if proposer is not the owner)
    if (clip.user_id !== user.id) {
      const { data: proposerProfile } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("id", user.id)
        .single();

      await sendNotification({
        userId: clip.user_id,
        type: "id_proposed_on_your_clip",
        actorId: user.id,
        entityType: "community_id",
        entityId: communityId.id,
        data: {
          clip_id: clipId,
          freeform_title: freeformTitle,
          freeform_artist: freeformArtist,
        },
        title: "Someone ID'd your clip!",
        body: `${proposerProfile?.display_name ?? "A user"} thinks they know what track this is.`,
      });
    }

    log.info("Community ID proposed", {
      clip_id: clipId,
      user_id: user.id,
      community_id: communityId.id,
      track_id: resolvedTrackId,
      has_freeform: !!freeformTitle,
    });

    return jsonResponse({ community_id: communityId }, 201);
  } catch (err) {
    log.error("Propose track ID failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});

// ── Spotify track fetch (used when spotify_enabled=true) ─────────
interface SpotifyTrackData {
  title: string;
  artist: string;
  artwork_url?: string;
  isrc?: string;
  label?: string;
  raw: Record<string, unknown>;
}

async function fetchSpotifyTrack(
  spotifyId: string,
): Promise<SpotifyTrackData | null> {
  try {
    const token = await getSpotifyToken();
    if (!token) return null;

    const response = await fetch(
      `https://api.spotify.com/v1/tracks/${spotifyId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!response.ok) return null;

    const data = await response.json();
    return {
      title: data.name,
      artist: data.artists?.map((a: { name: string }) => a.name).join(", ") ??
        "Unknown",
      artwork_url: data.album?.images?.[0]?.url,
      isrc: data.external_ids?.isrc,
      label: data.album?.label,
      raw: data,
    };
  } catch {
    return null;
  }
}

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

  // Refresh token via Client Credentials flow
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
