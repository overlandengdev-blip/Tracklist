import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAuth } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import { parseBody, optionalUUIDArray } from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("mark-notifications-read");

  try {
    const user = await requireAuth(req);
    const body = await parseBody(req);

    // If notification_ids provided, mark those specific ones.
    // Otherwise mark ALL unread notifications for this user.
    const notificationIds = optionalUUIDArray(body, "notification_ids");

    const supabase = getServiceClient();

    let query = supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("user_id", user.id)
      .is("read_at", null);

    if (notificationIds && notificationIds.length > 0) {
      query = query.in("id", notificationIds);
    }

    const { error, count } = await query.select("id").then((res) => ({
      error: res.error,
      count: res.data?.length ?? 0,
    }));

    if (error) {
      throw Errors.internal(`Failed to mark notifications read: ${error.message}`);
    }

    log.info("Notifications marked read", {
      user_id: user.id,
      count,
      specific: !!notificationIds,
    });

    return jsonResponse({ marked_read: count });
  } catch (err) {
    log.error("Mark notifications read failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});
