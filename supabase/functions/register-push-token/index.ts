import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAuth } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import { parseBody, requireString, optionalString } from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("register-push-token");

  try {
    const user = await requireAuth(req);
    const body = await parseBody(req);

    const token = requireString(body, "token", { maxLength: 500 });
    const platform = optionalString(body, "platform", { maxLength: 20 }) ?? "unknown";

    const supabase = getServiceClient();

    // Upsert: same token for same user → update, prevents duplicates
    const { error } = await supabase
      .from("push_tokens")
      .upsert(
        { user_id: user.id, token, platform, updated_at: new Date().toISOString() },
        { onConflict: "user_id,token" },
      );

    if (error) {
      throw Errors.internal(`Failed to register push token: ${error.message}`);
    }

    log.info("Push token registered", { user_id: user.id, platform });

    return jsonResponse({ registered: true });
  } catch (err) {
    log.error("Register push token failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});
