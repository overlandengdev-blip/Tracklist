import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAuth } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import { parseBody, requireUUID, optionalUUID } from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("attribute-clip-to-event");

  try {
    const user = await requireAuth(req);
    const body = await parseBody(req);

    const clipId = requireUUID(body, "clip_id");
    const eventId = optionalUUID(body, "event_id");
    const venueId = optionalUUID(body, "venue_id");
    const djId = optionalUUID(body, "dj_id");

    if (!eventId && !venueId && !djId) {
      throw Errors.badRequest("Must provide at least one of: event_id, venue_id, dj_id");
    }

    const supabase = getServiceClient();

    // Verify clip ownership
    const { data: clip } = await supabase
      .from("clips")
      .select("id, user_id")
      .eq("id", clipId)
      .single();

    if (!clip) throw Errors.notFound("Clip");
    if (clip.user_id !== user.id) {
      throw Errors.forbidden("Only the clip owner can attribute a clip");
    }

    // Verify referenced entities exist
    if (eventId) {
      const { data: ev } = await supabase.from("events").select("id").eq("id", eventId).single();
      if (!ev) throw Errors.notFound("Event");
    }
    if (venueId) {
      const { data: v } = await supabase.from("venues").select("id").eq("id", venueId).single();
      if (!v) throw Errors.notFound("Venue");
    }
    if (djId) {
      const { data: d } = await supabase.from("djs").select("id").eq("id", djId).single();
      if (!d) throw Errors.notFound("DJ");
    }

    // Update clip attribution
    const updatePayload: Record<string, unknown> = {};
    if (eventId) updatePayload.event_id = eventId;
    if (venueId) updatePayload.venue_id = venueId;
    if (djId) updatePayload.dj_id = djId;

    const { error } = await supabase
      .from("clips")
      .update(updatePayload)
      .eq("id", clipId);

    if (error) {
      throw Errors.internal(`Failed to attribute clip: ${error.message}`);
    }

    // Return updated clip
    const { data: updated } = await supabase
      .from("clips")
      .select("id, event_id, venue_id, dj_id")
      .eq("id", clipId)
      .single();

    log.info("Clip attributed", { user_id: user.id, clip_id: clipId, ...updatePayload });

    return jsonResponse({ clip: updated });
  } catch (err) {
    log.error("Attribute clip failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});
