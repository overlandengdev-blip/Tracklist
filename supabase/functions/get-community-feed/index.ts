import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAuth } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import { parseBody, optionalPositiveInt, optionalString } from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("get-community-feed");

  try {
    await requireAuth(req);
    const body = await parseBody(req);

    const limit = optionalPositiveInt(body, "limit", { max: 50, defaultValue: 20 });
    const offset = optionalPositiveInt(body, "offset", { max: 5000, defaultValue: 0 });
    const status = optionalString(body, "status", { maxLength: 20 });

    const supabase = getServiceClient();

    let query = supabase
      .from("clips")
      .select(
        "id, user_id, audio_url, status, is_public, venue_id, event_id, dj_id, matched_track_id, resolution_source, created_at, profiles!clips_user_id_fkey(display_name, avatar_url), tracks!clips_matched_track_id_fkey(title, artist, artwork_url)",
        { count: "exact" },
      )
      .eq("is_public", true)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (status === "community") {
      query = query.eq("status", "community");
    } else if (status === "resolved" || status === "matched") {
      query = query.in("status", ["resolved", "matched"]);
    }

    const { data: clips, error, count } = await query;

    if (error) {
      throw Errors.internal(`Feed query failed: ${error.message}`);
    }

    return jsonResponse({ clips: clips ?? [], total: count ?? 0, limit, offset });
  } catch (err) {
    log.error("Get community feed failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});
