import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse, corsHeaders } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { jsonResponse, errorResponse } from "../_shared/errors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const started = Date.now();

  try {
    const supabase = getServiceClient();

    const { data, error } = await supabase
      .from("schema_version")
      .select("version, description")
      .order("applied_at", { ascending: false })
      .limit(1)
      .single();

    const durationMs = Date.now() - started;

    if (error) {
      return new Response(
        JSON.stringify({
          status: "degraded",
          error: { code: "DB_ERROR", message: error.message },
          duration_ms: durationMs,
          timestamp: new Date().toISOString(),
        }),
        {
          status: 503,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        },
      );
    }

    return jsonResponse({
      status: "healthy",
      schema_version: data.version,
      schema_description: data.description,
      duration_ms: durationMs,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return errorResponse(err);
  }
});
