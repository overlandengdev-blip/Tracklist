import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAuth } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import { parseBody, optionalPositiveInt } from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("get-user-feed");

  try {
    const user = await requireAuth(req);
    const body = await parseBody(req);

    const limit = optionalPositiveInt(body, "limit", { max: 50, defaultValue: 20 });
    const offset = optionalPositiveInt(body, "offset", { max: 5000, defaultValue: 0 });

    const supabase = getServiceClient();

    // User's own clips (all statuses, including private)
    const { data: clips, error, count } = await supabase
      .from("clips")
      .select(
        "id, audio_url, status, is_public, venue_id, event_id, dj_id, matched_track_id, resolution_source, created_at, tracks!clips_matched_track_id_fkey(title, artist, artwork_url)",
        { count: "exact" },
      )
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      throw Errors.internal(`User feed query failed: ${error.message}`);
    }

    // Unread notification count
    const { count: unreadCount } = await supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .is("read_at", null);

    return jsonResponse({
      clips: clips ?? [],
      total: count ?? 0,
      unread_notifications: unreadCount ?? 0,
      limit,
      offset,
    });
  } catch (err) {
    log.error("Get user feed failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});
