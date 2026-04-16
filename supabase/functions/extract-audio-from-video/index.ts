import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";

/**
 * STUB — audio extraction happens on-device via ffmpeg-kit-react-native (v1.5).
 * This endpoint exists so the mobile client has a consistent API surface
 * if we later move extraction server-side.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  return errorResponse(
    Errors.serviceUnavailable(
      "Audio extraction is handled on-device. This endpoint is reserved for future server-side processing.",
    ),
  );
});
