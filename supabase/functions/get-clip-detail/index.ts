import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAuth, getOptionalUser } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import { parseBody, requireUUID } from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("get-clip-detail");

  try {
    const user = await getOptionalUser(req);
    const body = await parseBody(req);
    const clipId = requireUUID(body, "clip_id");

    const supabase = getServiceClient();

    const { data: clip, error } = await supabase
      .from("clips")
      .select(
        "id, user_id, audio_path, status, is_public, venue_id, event_id, dj_id, matched_track_id, resolution_source, duration_seconds, recorded_at, created_at, profiles!clips_user_id_fkey(id, display_name, avatar_url), tracks!clips_matched_track_id_fkey(id, title, artist, artwork_url, spotify_id, isrc), venues!clips_venue_id_fkey(id, name, slug, city), events!clips_event_id_fkey(id, name, start_time), djs!clips_dj_id_fkey(id, name, slug, avatar_url)",
      )
      .eq("id", clipId)
      .single();

    if (error || !clip) throw Errors.notFound("Clip");

    // If clip is private, only the owner can see it
    if (!clip.is_public && (!user || clip.user_id !== user.id)) {
      throw Errors.notFound("Clip");
    }

    // Fetch community IDs for this clip
    const { data: communityIds } = await supabase
      .from("community_ids")
      .select(
        "id, proposed_by, track_id, freeform_title, freeform_artist, confidence, upvotes_count, downvotes_count, is_accepted, created_at, profiles!community_ids_proposed_by_fkey(display_name, avatar_url)",
      )
      .eq("clip_id", clipId)
      .is("deleted_at", null)
      .order("is_accepted", { ascending: false })
      .order("upvotes_count", { ascending: false });

    // Fetch user's vote on each community ID (if authenticated)
    let userVotes: Record<string, string> = {};
    if (user && communityIds && communityIds.length > 0) {
      const cidIds = communityIds.map((c) => c.id);
      const { data: votes } = await supabase
        .from("votes")
        .select("community_id, direction")
        .eq("user_id", user.id)
        .in("community_id", cidIds);

      if (votes) {
        for (const v of votes) {
          userVotes[v.community_id] = v.direction;
        }
      }
    }

    return jsonResponse({
      clip,
      community_ids: communityIds ?? [],
      user_votes: userVotes,
    });
  } catch (err) {
    log.error("Get clip detail failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});
