import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAuth } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import { parseBody, requireUUID } from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("unaccept-community-id");

  try {
    const user = await requireAuth(req);
    const body = await parseBody(req);
    const communityIdId = requireUUID(body, "community_id");

    const supabase = getServiceClient();

    // Fetch community_id
    const { data: communityId, error: cidError } = await supabase
      .from("community_ids")
      .select("id, clip_id, proposed_by, is_accepted")
      .eq("id", communityIdId)
      .single();

    if (cidError || !communityId) throw Errors.notFound("Community ID");

    if (!communityId.is_accepted) {
      throw Errors.conflict("This proposal is not currently accepted");
    }

    // Verify caller owns the parent clip
    const { data: clip, error: clipError } = await supabase
      .from("clips")
      .select("id, user_id")
      .eq("id", communityId.clip_id)
      .single();

    if (clipError || !clip) throw Errors.notFound("Clip");

    if (clip.user_id !== user.id) {
      throw Errors.forbidden(
        "Only the clip owner can unaccept a community ID",
      );
    }

    // Set is_accepted = false
    // The on_community_id_accepted trigger handles reversal:
    //   - -10 reputation for proposer (floor at 0)
    //   - Insert reputation_event with note 'Un-accepted'
    //   - Revert clip: status='community', matched_track_id=null, resolution_source=null
    const { error: updateError } = await supabase
      .from("community_ids")
      .update({ is_accepted: false })
      .eq("id", communityIdId);

    if (updateError) {
      throw Errors.internal(
        `Failed to unaccept community ID: ${updateError.message}`,
      );
    }

    log.info("Community ID un-accepted", {
      community_id: communityIdId,
      clip_id: communityId.clip_id,
      user_id: user.id,
    });

    // Return updated state
    const { data: updatedCid } = await supabase
      .from("community_ids")
      .select(
        "id, clip_id, proposed_by, track_id, freeform_title, freeform_artist, confidence, upvotes_count, downvotes_count, is_accepted, accepted_at, created_at",
      )
      .eq("id", communityIdId)
      .single();

    const { data: updatedClip } = await supabase
      .from("clips")
      .select("id, status, matched_track_id, resolution_source")
      .eq("id", communityId.clip_id)
      .single();

    return jsonResponse({
      community_id: updatedCid,
      clip: updatedClip,
    });
  } catch (err) {
    log.error("Unaccept community ID failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});
