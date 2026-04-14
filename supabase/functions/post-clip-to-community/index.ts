import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAuth } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import { parseBody, requireUUID } from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";
import { sendNotification } from "../_shared/notifications.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("post-clip-to-community");

  try {
    const user = await requireAuth(req);
    const body = await parseBody(req);
    const clipId = requireUUID(body, "clip_id");

    const supabase = getServiceClient();

    // Fetch clip and verify ownership
    const { data: clip, error: clipError } = await supabase
      .from("clips")
      .select("id, user_id, status, is_public, venue_id, dj_id")
      .eq("id", clipId)
      .single();

    if (clipError || !clip) throw Errors.notFound("Clip");
    if (clip.user_id !== user.id) throw Errors.forbidden("You do not own this clip");

    // Only unmatched or pending clips can be posted to community
    if (!["unmatched", "pending"].includes(clip.status)) {
      throw Errors.conflict(
        `Cannot post clip with status '${clip.status}' to community. Must be 'unmatched' or 'pending'.`,
      );
    }

    // Already public
    if (clip.is_public && clip.status === "community") {
      throw Errors.conflict("Clip is already posted to the community");
    }

    // Update clip
    const { error: updateError } = await supabase
      .from("clips")
      .update({ is_public: true, status: "community" })
      .eq("id", clipId);

    if (updateError) {
      throw Errors.internal(`Failed to update clip: ${updateError.message}`);
    }

    log.info("Clip posted to community", { clip_id: clipId, user_id: user.id });

    // Notify followers of the relevant venue/DJ if known
    const notificationTargets: string[] = [];

    if (clip.venue_id) {
      const { data: venueFollowers } = await supabase
        .from("follows")
        .select("follower_id")
        .eq("followable_type", "venue")
        .eq("followable_id", clip.venue_id)
        .limit(100);

      if (venueFollowers) {
        notificationTargets.push(
          ...venueFollowers.map((f) => f.follower_id),
        );
      }
    }

    if (clip.dj_id) {
      const { data: djFollowers } = await supabase
        .from("follows")
        .select("follower_id")
        .eq("followable_type", "dj")
        .eq("followable_id", clip.dj_id)
        .limit(100);

      if (djFollowers) {
        notificationTargets.push(...djFollowers.map((f) => f.follower_id));
      }
    }

    // Deduplicate and exclude the clip owner
    const uniqueTargets = [...new Set(notificationTargets)].filter(
      (id) => id !== user.id,
    );

    // Send notifications (fire and forget — don't block response)
    for (const targetId of uniqueTargets.slice(0, 50)) {
      sendNotification({
        userId: targetId,
        type: "clip_unmatched_posted_to_community",
        actorId: user.id,
        entityType: "clip",
        entityId: clipId,
        title: "New clip needs ID",
        body: "A new clip was posted to the community. Can you identify the track?",
      }).catch(() => {});
    }

    // Return updated clip
    const { data: updatedClip } = await supabase
      .from("clips")
      .select("id, status, is_public, community_ids_count, created_at")
      .eq("id", clipId)
      .single();

    return jsonResponse({ clip: updatedClip });
  } catch (err) {
    log.error("Failed to post clip to community", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});
