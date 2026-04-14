import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAuth } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import {
  parseBody,
  requireUUID,
  optionalEnum,
} from "../_shared/validation.ts";
import {
  enforceRateLimit,
  recordRateLimitEvent,
  getConfigValue,
} from "../_shared/rate-limit.ts";
import { createLogger } from "../_shared/logging.ts";
import { sendNotification } from "../_shared/notifications.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("vote-on-id");

  try {
    const user = await requireAuth(req);
    const body = await parseBody(req);

    const communityIdId = requireUUID(body, "community_id");
    const direction = optionalEnum(body, "direction", [
      "up",
      "down",
    ] as const);
    const remove = body.remove === true;

    // Must provide either direction or remove
    if (!direction && !remove) {
      throw Errors.badRequest(
        "Must provide 'direction' (up/down) or 'remove: true'",
      );
    }

    const supabase = getServiceClient();

    // Rate limit
    const maxVotes = await getConfigValue("max_votes_per_day", 100);
    await enforceRateLimit(user.id, "vote", maxVotes, 1440);

    // Verify community_id exists and is not deleted
    const { data: communityId, error: cidError } = await supabase
      .from("community_ids")
      .select("id, clip_id, proposed_by, is_accepted, deleted_at")
      .eq("id", communityIdId)
      .single();

    if (cidError || !communityId) {
      throw Errors.notFound("Community ID");
    }

    if (communityId.deleted_at) {
      throw Errors.conflict("This proposal has been deleted");
    }

    if (communityId.is_accepted) {
      throw Errors.conflict(
        "Cannot vote on an accepted proposal — it's already confirmed",
      );
    }

    // Prevent self-vote (also enforced by DB trigger, but fail fast)
    if (communityId.proposed_by === user.id) {
      throw Errors.forbidden("Cannot vote on your own proposal");
    }

    if (remove) {
      // Delete existing vote
      const { error: deleteError, count } = await supabase
        .from("votes")
        .delete({ count: "exact" })
        .eq("community_id", communityIdId)
        .eq("user_id", user.id);

      if (deleteError) {
        throw Errors.internal(`Failed to remove vote: ${deleteError.message}`);
      }

      if (count === 0) {
        throw Errors.notFound("Vote (you haven't voted on this proposal)");
      }

      log.info("Vote removed", {
        community_id: communityIdId,
        user_id: user.id,
      });
    } else {
      // Upsert vote (insert or update direction)
      const { data: existingVote } = await supabase
        .from("votes")
        .select("id, direction")
        .eq("community_id", communityIdId)
        .eq("user_id", user.id)
        .single();

      if (existingVote) {
        if (existingVote.direction === direction) {
          // Already voted in this direction — no-op
          return jsonResponse({
            message: `Already voted ${direction}`,
            vote: existingVote,
          });
        }

        // Change vote direction
        const { error: updateError } = await supabase
          .from("votes")
          .update({ direction })
          .eq("id", existingVote.id);

        if (updateError) {
          throw Errors.internal(
            `Failed to update vote: ${updateError.message}`,
          );
        }

        log.info("Vote changed", {
          community_id: communityIdId,
          user_id: user.id,
          from: existingVote.direction,
          to: direction,
        });
      } else {
        // New vote
        const { error: insertError } = await supabase
          .from("votes")
          .insert({
            community_id: communityIdId,
            user_id: user.id,
            direction,
          });

        if (insertError) {
          // Could be self-vote trigger error
          if (insertError.message?.includes("Cannot vote on your own")) {
            throw Errors.forbidden("Cannot vote on your own proposal");
          }
          throw Errors.internal(
            `Failed to insert vote: ${insertError.message}`,
          );
        }

        log.info("Vote cast", {
          community_id: communityIdId,
          user_id: user.id,
          direction,
        });

        // Notify proposer of upvote (not on downvote — that's rude)
        if (direction === "up") {
          const { data: voterProfile } = await supabase
            .from("profiles")
            .select("display_name")
            .eq("id", user.id)
            .single();

          await sendNotification({
            userId: communityId.proposed_by,
            type: "id_upvoted",
            actorId: user.id,
            entityType: "community_id",
            entityId: communityIdId,
            data: { clip_id: communityId.clip_id },
            title: "Your ID got an upvote!",
            body: `${voterProfile?.display_name ?? "Someone"} agreed with your track identification.`,
          });
        }
      }

      // Record rate limit event
      await recordRateLimitEvent(user.id, "vote");
    }

    // Return updated community_id with vote counts
    const { data: updated } = await supabase
      .from("community_ids")
      .select(
        "id, clip_id, proposed_by, track_id, freeform_title, freeform_artist, confidence, upvotes_count, downvotes_count, is_accepted, created_at",
      )
      .eq("id", communityIdId)
      .single();

    return jsonResponse({ community_id: updated });
  } catch (err) {
    log.error("Vote failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});
