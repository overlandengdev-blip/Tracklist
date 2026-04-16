import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";

/**
 * STUB — video finalization (overlay, watermark) happens on-device (v1.5).
 * This endpoint is reserved for future server-side video processing.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  return errorResponse(
    Errors.serviceUnavailable(
      "Video finalization is handled on-device. This endpoint is reserved for future server-side processing.",
    ),
  );
});
