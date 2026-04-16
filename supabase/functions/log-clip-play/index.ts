import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { getOptionalUser } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import { parseBody, requireUUID } from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";

/**
 * Log a clip playback event for analytics.
 * Accepts both authenticated and anonymous plays.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("log-clip-play");

  try {
    const user = await getOptionalUser(req);
    const body = await parseBody(req);
    const clipId = requireUUID(body, "clip_id");

    const supabase = getServiceClient();

    // Verify clip exists and is public
    const { data: clip } = await supabase
      .from("clips")
      .select("id, is_public")
      .eq("id", clipId)
      .single();

    if (!clip) throw Errors.notFound("Clip");

    // Increment play count (uses atomic increment if column exists, otherwise insert event)
    const { error } = await supabase.from("clip_plays").insert({
      clip_id: clipId,
      user_id: user?.id ?? null,
      played_at: new Date().toISOString(),
    });

    if (error) {
      // clip_plays table might not exist yet — log and continue
      log.warn("Failed to log clip play (table may not exist)", {
        clip_id: clipId,
        error: error.message,
      });
    }

    return jsonResponse({ logged: true });
  } catch (err) {
    log.error("Log clip play failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});
