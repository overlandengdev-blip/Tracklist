import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAuth, getOptionalUser } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import { parseBody, optionalUUID } from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("get-profile");

  try {
    const caller = await getOptionalUser(req);
    const body = await parseBody(req);

    // If no user_id provided, return the caller's profile
    const targetUserId = optionalUUID(body, "user_id") ?? caller?.id;
    if (!targetUserId) {
      throw Errors.unauthorized("Must be authenticated or provide user_id");
    }

    const isOwnProfile = caller?.id === targetUserId;

    const supabase = getServiceClient();

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("id, display_name, avatar_url, bio, reputation, is_admin, notification_preferences, created_at, updated_at")
      .eq("id", targetUserId)
      .single();

    if (error || !profile) throw Errors.notFound("Profile");

    // Strip private fields for other users
    if (!isOwnProfile) {
      delete (profile as Record<string, unknown>).notification_preferences;
    }

    // Stats
    const [clipsResult, proposalsResult, acceptedResult, badgesResult] = await Promise.all([
      supabase.from("clips").select("id", { count: "exact", head: true }).eq("user_id", targetUserId).eq("is_public", true),
      supabase.from("community_ids").select("id", { count: "exact", head: true }).eq("proposed_by", targetUserId),
      supabase.from("community_ids").select("id", { count: "exact", head: true }).eq("proposed_by", targetUserId).eq("is_accepted", true),
      supabase.from("user_badges").select("badge_id, awarded_at, badges!user_badges_badge_id_fkey(name, slug, icon_url, description)").eq("user_id", targetUserId),
    ]);

    return jsonResponse({
      profile,
      stats: {
        public_clips: clipsResult.count ?? 0,
        proposals: proposalsResult.count ?? 0,
        accepted_ids: acceptedResult.count ?? 0,
      },
      badges: badgesResult.data ?? [],
    });
  } catch (err) {
    log.error("Get profile failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});
