import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAuth } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import { parseBody, requireString } from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("unregister-push-token");

  try {
    const user = await requireAuth(req);
    const body = await parseBody(req);

    const token = requireString(body, "token", { maxLength: 500 });

    const supabase = getServiceClient();

    const { error, count } = await supabase
      .from("push_tokens")
      .delete({ count: "exact" })
      .eq("user_id", user.id)
      .eq("token", token);

    if (error) {
      throw Errors.internal(`Failed to unregister push token: ${error.message}`);
    }

    if (count === 0) {
      throw Errors.notFound("Push token");
    }

    log.info("Push token unregistered", { user_id: user.id });

    return jsonResponse({ unregistered: true });
  } catch (err) {
    log.error("Unregister push token failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});
