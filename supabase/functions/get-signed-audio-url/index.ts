import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAuth } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import { parseBody, requireUUID } from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";

/**
 * Generate a short-lived signed URL for a clip's audio file.
 * Public clips: any authenticated user. Private clips: owner only.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("get-signed-audio-url");

  try {
    const user = await requireAuth(req);
    const body = await parseBody(req);
    const clipId = requireUUID(body, "clip_id");

    const supabase = getServiceClient();

    const { data: clip, error: clipError } = await supabase
      .from("clips")
      .select("id, user_id, audio_url, is_public")
      .eq("id", clipId)
      .single();

    if (clipError || !clip) throw Errors.notFound("Clip");

    if (!clip.is_public && clip.user_id !== user.id) {
      throw Errors.forbidden("This clip is private");
    }

    if (!clip.audio_url) {
      throw Errors.notFound("Audio file");
    }

    // Extract the storage path from the audio_url
    // audio_url format: "audio-clips/<user_id>/<filename>"
    const storagePath = clip.audio_url;

    const { data: signedUrl, error: signError } = await supabase.storage
      .from("audio-clips")
      .createSignedUrl(storagePath, 3600); // 1 hour expiry

    if (signError || !signedUrl) {
      throw Errors.internal("Failed to generate signed URL");
    }

    return jsonResponse({ signed_url: signedUrl.signedUrl, expires_in: 3600 });
  } catch (err) {
    log.error("Get signed audio URL failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});
