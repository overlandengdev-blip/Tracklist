import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAuth } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import { parseBody, requireString, optionalPositiveInt } from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";

/**
 * Unified search across tracks, venues, DJs, and events.
 * Returns top results from each category.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("search-everything");

  try {
    await requireAuth(req);
    const body = await parseBody(req);

    const query = requireString(body, "query", { maxLength: 200, minLength: 1 });
    const limit = optionalPositiveInt(body, "limit", { max: 20, defaultValue: 5 });

    const supabase = getServiceClient();
    const ilike = `%${query}%`;

    // Search all four entity types in parallel
    const [tracks, venues, djs, events] = await Promise.all([
      supabase
        .from("tracks")
        .select("id, title, artist, artwork_url, spotify_id")
        .or(`title.ilike.${ilike},artist.ilike.${ilike}`)
        .limit(limit),
      supabase
        .from("venues")
        .select("id, name, slug, city, country, verified")
        .or(`name.ilike.${ilike},city.ilike.${ilike}`)
        .order("verified", { ascending: false })
        .limit(limit),
      supabase
        .from("djs")
        .select("id, name, slug, avatar_url, genres")
        .ilike("name", ilike)
        .limit(limit),
      supabase
        .from("events")
        .select("id, name, venue_id, start_time, verified")
        .ilike("name", ilike)
        .order("start_time", { ascending: false })
        .limit(limit),
    ]);

    return jsonResponse({
      tracks: tracks.data ?? [],
      venues: venues.data ?? [],
      djs: djs.data ?? [],
      events: events.data ?? [],
    });
  } catch (err) {
    log.error("Search everything failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});
