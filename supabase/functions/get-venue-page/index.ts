import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { getOptionalUser } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import { parseBody, requireUUID, optionalPositiveInt } from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("get-venue-page");

  try {
    await getOptionalUser(req);
    const body = await parseBody(req);
    const venueId = requireUUID(body, "venue_id");
    const clipsLimit = optionalPositiveInt(body, "clips_limit", { max: 50, defaultValue: 20 });
    const eventsLimit = optionalPositiveInt(body, "events_limit", { max: 50, defaultValue: 10 });

    const supabase = getServiceClient();

    // Fetch venue
    const { data: venue, error: venueError } = await supabase
      .from("venues")
      .select("id, name, slug, city, country, lat, lng, capacity, genres, website, instagram, description, verified, created_at")
      .eq("id", venueId)
      .single();

    if (venueError || !venue) throw Errors.notFound("Venue");

    // Fetch recent clips and upcoming events in parallel
    const [clipsResult, eventsResult] = await Promise.all([
      supabase
        .from("clips")
        .select("id, user_id, status, matched_track_id, created_at, tracks!clips_matched_track_id_fkey(title, artist, artwork_url), profiles!clips_user_id_fkey(display_name)")
        .eq("venue_id", venueId)
        .eq("is_public", true)
        .order("created_at", { ascending: false })
        .limit(clipsLimit),
      supabase
        .from("events")
        .select("id, name, start_time, end_time, poster_url, verified")
        .eq("venue_id", venueId)
        .gte("start_time", new Date().toISOString())
        .order("start_time")
        .limit(eventsLimit),
    ]);

    return jsonResponse({
      venue,
      clips: clipsResult.data ?? [],
      upcoming_events: eventsResult.data ?? [],
    });
  } catch (err) {
    log.error("Get venue page failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});
