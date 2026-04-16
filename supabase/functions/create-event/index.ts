import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAuth } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import {
  parseBody,
  requireString,
  optionalString,
  optionalUUID,
} from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("create-event");

  try {
    const user = await requireAuth(req);
    const body = await parseBody(req);

    const name = requireString(body, "name", { maxLength: 300, minLength: 2 });
    const venueId = optionalUUID(body, "venue_id");
    const description = optionalString(body, "description", { maxLength: 5000 });
    const externalTicketUrl = optionalString(body, "external_ticket_url", { maxLength: 500 });
    const posterUrl = optionalString(body, "poster_url", { maxLength: 500 });
    const genres = Array.isArray(body.genres) ? body.genres.filter((g: unknown) => typeof g === "string").slice(0, 20) : null;

    // Validate start_time
    const startTimeRaw = body.start_time;
    if (!startTimeRaw || typeof startTimeRaw !== "string") {
      throw Errors.badRequest("start_time is required (ISO 8601 format)");
    }
    const startTime = new Date(startTimeRaw);
    if (isNaN(startTime.getTime())) {
      throw Errors.badRequest("start_time must be a valid ISO 8601 date");
    }

    // Optional end_time
    let endTime: Date | null = null;
    if (body.end_time && typeof body.end_time === "string") {
      endTime = new Date(body.end_time);
      if (isNaN(endTime.getTime())) {
        throw Errors.badRequest("end_time must be a valid ISO 8601 date");
      }
      if (endTime <= startTime) {
        throw Errors.badRequest("end_time must be after start_time");
      }
    }

    const supabase = getServiceClient();

    // If venue_id provided, verify it exists
    if (venueId) {
      const { data: venue } = await supabase
        .from("venues")
        .select("id")
        .eq("id", venueId)
        .single();
      if (!venue) throw Errors.notFound("Venue");
    }

    const { data: event, error } = await supabase
      .from("events")
      .insert({
        name,
        venue_id: venueId ?? null,
        start_time: startTime.toISOString(),
        end_time: endTime?.toISOString() ?? null,
        description,
        genres,
        external_ticket_url: externalTicketUrl,
        poster_url: posterUrl,
        created_by: user.id,
        updated_by: user.id,
      })
      .select("id, name, venue_id, start_time, end_time, verified, created_at")
      .single();

    if (error) {
      throw Errors.internal(`Failed to create event: ${error.message}`);
    }

    log.info("Event created", { user_id: user.id, event_id: event.id, name });

    return jsonResponse({ event }, 201);
  } catch (err) {
    log.error("Create event failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});
