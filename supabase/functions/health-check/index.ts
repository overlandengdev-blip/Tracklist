import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, apikey, content-type",
      },
    });
  }

  const started = Date.now();

  try {
    // Verify Supabase connection
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

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
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    return new Response(
      JSON.stringify({
        status: "healthy",
        schema_version: data.version,
        schema_description: data.description,
        duration_ms: durationMs,
        timestamp: new Date().toISOString(),
        environment: Deno.env.get("SUPABASE_URL")?.includes("localhost")
          ? "local"
          : "remote",
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch (err) {
    const durationMs = Date.now() - started;
    return new Response(
      JSON.stringify({
        status: "error",
        error: {
          code: "INTERNAL_ERROR",
          message: err instanceof Error ? err.message : "Unknown error",
        },
        duration_ms: durationMs,
        timestamp: new Date().toISOString(),
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
});
