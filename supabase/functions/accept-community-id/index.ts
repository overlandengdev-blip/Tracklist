import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAuth } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import { parseBody, requireUUID } from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";
import { sendNotification, sendBulkNotifications } from "../_shared/notifications.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("accept-community-id");

  try {
    const user = await requireAuth(req);
    const body = await parseBody(req);
    const communityIdId = requireUUID(body, "community_id");

    const supabase = getServiceClient();

    // Fetch community_id with clip info
    const { data: communityId, error: cidError } = await supabase
      .from("community_ids")
      .select(
        "id, clip_id, proposed_by, track_id, freeform_title, freeform_artist, is_accepted, deleted_at",
      )
      .eq("id", communityIdId)
      .single();

    if (cidError || !communityId) throw Errors.notFound("Community ID");

    if (communityId.deleted_at) {
      throw Errors.conflict("This proposal has been deleted");
    }

    if (communityId.is_accepted) {
      throw Errors.conflict("This proposal is already accepted");
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
        "Only the clip owner can accept a community ID",
      );
    }

    // Set is_accepted = true
    // The on_community_id_accepted trigger handles:
    //   - +10 reputation for proposer
    //   - Insert reputation_event
    //   - Update clip: status='resolved', matched_track_id, resolution_source='community'
    const { error: updateError } = await supabase
      .from("community_ids")
      .update({ is_accepted: true })
      .eq("id", communityIdId);

    if (updateError) {
      throw Errors.internal(
        `Failed to accept community ID: ${updateError.message}`,
      );
    }

    log.info("Community ID accepted", {
      community_id: communityIdId,
      clip_id: communityId.clip_id,
      user_id: user.id,
      proposer_id: communityId.proposed_by,
    });

    // ── Notifications ────────────────────────────────────────
    const { data: ownerProfile } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", user.id)
      .single();

    const trackLabel =
      communityId.freeform_title ??
      (communityId.track_id ? "a track" : "an identification");

    // 1. Notify the proposer
    if (communityId.proposed_by !== user.id) {
      await sendNotification({
        userId: communityId.proposed_by,
        type: "id_accepted",
        actorId: user.id,
        entityType: "community_id",
        entityId: communityIdId,
        data: {
          clip_id: communityId.clip_id,
          track_id: communityId.track_id,
        },
        title: "Your ID was accepted!",
        body: `${ownerProfile?.display_name ?? "The clip owner"} confirmed your identification of ${trackLabel}. +10 reputation!`,
      });
    }

    // 2. Notify all upvoters
    const { data: upvoters } = await supabase
      .from("votes")
      .select("user_id")
      .eq("community_id", communityIdId)
      .eq("direction", "up");

    if (upvoters && upvoters.length > 0) {
      const upvoterNotifications = upvoters
        .filter((v) => v.user_id !== user.id) // don't notify clip owner if they upvoted
        .map((v) => ({
          userId: v.user_id,
          type: "your_vote_on_accepted_id" as const,
          actorId: user.id,
          entityType: "community_id",
          entityId: communityIdId,
          data: { clip_id: communityId.clip_id },
          title: "A track you upvoted was confirmed!",
          body: `The track identification you supported for ${trackLabel} was accepted.`,
        }));

      await sendBulkNotifications(upvoterNotifications);
    }

    // ── Check badges for the proposer ────────────────────────
    // Fire and forget — don't block the response
    supabase.functions
      .invoke("check-and-award-badges", {
        body: {
          user_id: communityId.proposed_by,
          trigger_event: "id_accepted",
        },
      })
      .catch(() => {
        // Badge check is optional — don't fail the accept
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
      .select(
        "id, status, matched_track_id, resolution_source",
      )
      .eq("id", communityId.clip_id)
      .single();

    return jsonResponse({
      community_id: updatedCid,
      clip: updatedClip,
    });
  } catch (err) {
    log.error("Accept community ID failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});
