import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAuth } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import { parseBody, requireUUID } from "../_shared/validation.ts";
import {
  enforceRateLimit,
  getConfigValue,
} from "../_shared/rate-limit.ts";
import { createLogger } from "../_shared/logging.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("retry-identification");

  try {
    const user = await requireAuth(req);
    const body = await parseBody(req);
    const clipId = requireUUID(body, "clip_id");

    const supabase = getServiceClient();

    // Fetch clip and verify ownership
    const { data: clip, error: clipError } = await supabase
      .from("clips")
      .select("id, user_id, status")
      .eq("id", clipId)
      .single();

    if (clipError || !clip) throw Errors.notFound("Clip");
    if (clip.user_id !== user.id) throw Errors.forbidden("You do not own this clip");

    // Only unmatched clips can be retried
    if (clip.status !== "unmatched") {
      throw Errors.conflict(
        `Cannot retry identification for clip with status '${clip.status}'. Must be 'unmatched'.`,
      );
    }

    // Anti-abuse: check last recognition attempt was > 24 hours ago
    const { data: lastRecognition } = await supabase
      .from("recognitions")
      .select("attempted_at")
      .eq("clip_id", clipId)
      .order("attempted_at", { ascending: false })
      .limit(1)
      .single();

    if (lastRecognition) {
      const lastAttempt = new Date(lastRecognition.attempted_at);
      const hoursSince =
        (Date.now() - lastAttempt.getTime()) / (1000 * 60 * 60);

      if (hoursSince < 24) {
        const hoursRemaining = Math.ceil(24 - hoursSince);
        throw Errors.rateLimited(
          `Retry available in ${hoursRemaining} hour${hoursRemaining === 1 ? "" : "s"}. Last attempt was ${Math.floor(hoursSince)} hours ago.`,
        );
      }
    }

    // Rate limit: max retries per day
    const maxRetries = await getConfigValue("max_retries_per_day", 3);
    await enforceRateLimit(user.id, "retry_identification", maxRetries, 1440);

    // Reset clip status to pending
    const { error: updateError } = await supabase
      .from("clips")
      .update({ status: "pending" })
      .eq("id", clipId);

    if (updateError) {
      throw Errors.internal(`Failed to reset clip status: ${updateError.message}`);
    }

    log.info("Clip reset for retry", { clip_id: clipId, user_id: user.id });

    // Call identify-clip internally via Supabase Functions invoke
    const { data: identifyResult, error: identifyError } =
      await supabase.functions.invoke("identify-clip", {
        body: { clip_id: clipId },
        headers: {
          Authorization: req.headers.get("Authorization")!,
        },
      });

    if (identifyError) {
      log.error("Internal identify-clip call failed", {
        clip_id: clipId,
        error: identifyError.message,
      });
      // Don't throw — the clip is already reset to pending
      // The user can check status via realtime or polling
      return jsonResponse({
        message: "Retry initiated but identification encountered an error. Check clip status.",
        clip_id: clipId,
        error: identifyError.message,
      });
    }

    return jsonResponse({
      message: "Retry identification complete",
      ...identifyResult,
    });
  } catch (err) {
    log.error("Retry identification failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});
