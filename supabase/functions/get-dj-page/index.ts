import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { getOptionalUser } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import { parseBody, requireUUID, optionalPositiveInt } from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("get-dj-page");

  try {
    await getOptionalUser(req);
    const body = await parseBody(req);
    const djId = requireUUID(body, "dj_id");
    const clipsLimit = optionalPositiveInt(body, "clips_limit", { max: 50, defaultValue: 20 });

    const supabase = getServiceClient();

    const { data: dj, error: djError } = await supabase
      .from("djs")
      .select("id, name, slug, bio, avatar_url, soundcloud_url, resident_advisor_url, instagram, genres, aliases, claimed_by_user_id, created_at")
      .eq("id", djId)
      .single();

    if (djError || !dj) throw Errors.notFound("DJ");

    // Recent clips attributed to this DJ
    const { data: clips } = await supabase
      .from("clips")
      .select("id, user_id, status, matched_track_id, venue_id, created_at, tracks!clips_matched_track_id_fkey(title, artist, artwork_url), venues!clips_venue_id_fkey(name, slug)")
      .eq("dj_id", djId)
      .eq("is_public", true)
      .order("created_at", { ascending: false })
      .limit(clipsLimit);

    return jsonResponse({
      dj,
      clips: clips ?? [],
    });
  } catch (err) {
    log.error("Get DJ page failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});
