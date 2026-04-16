import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import { parseBody, requireUUID, requireString } from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";
import { sendNotification } from "../_shared/notifications.ts";

/**
 * Internal function — called by accept-community-id (fire-and-forget).
 * Checks badge criteria and awards any newly earned badges.
 *
 * Badge definitions are in the badges table (seeded in v1 schema).
 * Each badge has a `criteria` JSONB column describing thresholds.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("check-and-award-badges");

  try {
    const body = await parseBody(req);
    const userId = requireUUID(body, "user_id");
    const triggerEvent = requireString(body, "trigger_event", { maxLength: 50 });

    const supabase = getServiceClient();

    // Fetch user stats for badge evaluation
    const { data: profile } = await supabase
      .from("profiles")
      .select("reputation")
      .eq("id", userId)
      .single();

    if (!profile) return jsonResponse({ awarded: [] });

    // Count accepted IDs by this user
    const { count: acceptedCount } = await supabase
      .from("community_ids")
      .select("id", { count: "exact", head: true })
      .eq("proposed_by", userId)
      .eq("is_accepted", true);

    // Count total proposals
    const { count: proposalCount } = await supabase
      .from("community_ids")
      .select("id", { count: "exact", head: true })
      .eq("proposed_by", userId);

    // Count total clips
    const { count: clipCount } = await supabase
      .from("clips")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);

    const stats = {
      reputation: profile.reputation ?? 0,
      accepted_ids: acceptedCount ?? 0,
      proposals: proposalCount ?? 0,
      clips: clipCount ?? 0,
    };

    // Fetch all badges and user's existing awards
    const [{ data: allBadges }, { data: existingAwards }] = await Promise.all([
      supabase.from("badges").select("id, slug, name, criteria"),
      supabase
        .from("user_badges")
        .select("badge_id")
        .eq("user_id", userId),
    ]);

    if (!allBadges) return jsonResponse({ awarded: [] });

    const earnedBadgeIds = new Set(
      (existingAwards ?? []).map((a) => a.badge_id),
    );

    const newlyAwarded: { badge_id: string; slug: string; name: string }[] = [];

    for (const badge of allBadges) {
      if (earnedBadgeIds.has(badge.id)) continue;

      const criteria = badge.criteria as Record<string, number> | null;
      if (!criteria) continue;

      const earned = evaluateCriteria(criteria, stats);
      if (!earned) continue;

      // Award the badge
      const { error } = await supabase
        .from("user_badges")
        .insert({ user_id: userId, badge_id: badge.id });

      if (!error) {
        newlyAwarded.push({
          badge_id: badge.id,
          slug: badge.slug,
          name: badge.name,
        });
      }
    }

    // Notify user about new badges
    for (const badge of newlyAwarded) {
      await sendNotification({
        userId,
        type: "badge_earned",
        entityType: "badge",
        entityId: badge.badge_id,
        title: "New badge earned!",
        body: `You earned the "${badge.name}" badge!`,
      });
    }

    if (newlyAwarded.length > 0) {
      log.info("Badges awarded", {
        user_id: userId,
        trigger: triggerEvent,
        badges: newlyAwarded.map((b) => b.slug),
      });
    }

    return jsonResponse({ awarded: newlyAwarded });
  } catch (err) {
    log.error("Badge check failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});

/**
 * Evaluate badge criteria against user stats.
 * Criteria format from DB: { type: "ids_correct_count", threshold: 10 }
 * or { type: "veteran", clips_threshold: 50, months: 12 }
 */
function evaluateCriteria(
  criteria: Record<string, unknown>,
  stats: {
    reputation: number;
    accepted_ids: number;
    proposals: number;
    clips: number;
  },
): boolean {
  const type = criteria.type as string;
  const threshold = typeof criteria.threshold === "number" ? criteria.threshold : 0;

  switch (type) {
    case "ids_correct_count":
      return stats.accepted_ids >= threshold;
    case "reputation":
      return stats.reputation >= threshold;
    case "proposals_count":
      return stats.proposals >= threshold;
    case "clips_count":
      return stats.clips >= threshold;
    case "genre_ids_count":
      // Requires genre-specific query — not yet implemented, skip
      return false;
    case "veteran":
      // Requires account age check — not yet implemented, skip
      return false;
    default:
      // Unknown type — don't award
      return false;
  }
}
