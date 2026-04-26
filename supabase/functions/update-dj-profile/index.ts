import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAuth } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import {
  parseBody,
  requireUUID,
  optionalString,
} from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";

/**
 * update-dj-profile
 *
 * Update the `djs` row that `auth.uid()` has claimed. Only the owner
 * (claimed_by_user_id) may call. Unauthenticated-sensitive fields
 * (verified, claimed_by_user_id, slug) cannot be changed here — those
 * belong to admin flows.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("update-dj-profile");

  try {
    const user = await requireAuth(req);
    const body = await parseBody(req);

    const djId = requireUUID(body, "dj_id");
    const supabase = getServiceClient();

    // Ownership check
    const { data: dj } = await supabase
      .from("djs")
      .select("id, claimed_by_user_id")
      .eq("id", djId)
      .maybeSingle();

    if (!dj) throw Errors.notFound("DJ");
    if (dj.claimed_by_user_id !== user.id) {
      throw Errors.forbidden("You do not own this DJ profile");
    }

    // Whitelist of editable fields
    const patch: Record<string, unknown> = {};
    const bio = optionalString(body, "bio", { maxLength: 2000 });
    const avatarUrl = optionalString(body, "avatar_url", { maxLength: 500 });
    const coverUrl = optionalString(body, "cover_image_url", { maxLength: 500 });
    const bookingEmail = optionalString(body, "booking_email", { maxLength: 200 });
    const soundcloudUrl = optionalString(body, "soundcloud_url", { maxLength: 300 });
    const instagram = optionalString(body, "instagram", { maxLength: 100 });
    const bandcampUrl = optionalString(body, "bandcamp_url", { maxLength: 300 });
    const websiteUrl = optionalString(body, "website_url", { maxLength: 300 });
    const raUrl = optionalString(body, "resident_advisor_url", { maxLength: 300 });

    if (bio !== undefined) patch.bio = bio;
    if (avatarUrl !== undefined) patch.avatar_url = avatarUrl;
    if (coverUrl !== undefined) patch.cover_image_url = coverUrl;
    if (bookingEmail !== undefined) patch.booking_email = bookingEmail;
    if (soundcloudUrl !== undefined) patch.soundcloud_url = soundcloudUrl;
    if (instagram !== undefined) patch.instagram = instagram;
    if (bandcampUrl !== undefined) patch.bandcamp_url = bandcampUrl;
    if (websiteUrl !== undefined) patch.website_url = websiteUrl;
    if (raUrl !== undefined) patch.resident_advisor_url = raUrl;

    // Array-typed fields
    if (Array.isArray(body.genres)) {
      patch.genres = (body.genres as unknown[])
        .filter((g) => typeof g === "string" && g.length <= 50)
        .slice(0, 10);
    }
    if (typeof body.is_accepting_bookings === "boolean") {
      patch.is_accepting_bookings = body.is_accepting_bookings;
    }

    if (Object.keys(patch).length === 0) {
      throw Errors.badRequest("No valid fields provided to update");
    }

    patch.updated_by = user.id;
    patch.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from("djs")
      .update(patch)
      .eq("id", djId)
      .select()
      .single();

    if (error) {
      throw Errors.internal(`Failed to update DJ: ${error.message}`);
    }

    log.info("DJ profile updated", {
      user_id: user.id,
      dj_id: djId,
      fields: Object.keys(patch),
    });

    return jsonResponse({ dj: data });
  } catch (err) {
    log.error("update-dj-profile failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});
