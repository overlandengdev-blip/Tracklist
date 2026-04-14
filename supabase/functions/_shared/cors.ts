/**
 * CORS headers for edge function responses.
 * Apply to every response. Handle OPTIONS preflight separately.
 */
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, apikey, content-type, x-client-info",
};

/** Standard CORS preflight response */
export function corsResponse(): Response {
  return new Response("ok", { status: 204, headers: corsHeaders });
}
