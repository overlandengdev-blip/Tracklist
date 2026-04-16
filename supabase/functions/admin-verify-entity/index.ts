import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAdmin } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import { parseBody, requireUUID, requireEnum } from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";

/**
 * Unified admin verification for venues, events, and DJs.
 * Sets verified=true on the target entity.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("admin-verify-entity");

  try {
    const admin = await requireAdmin(req);
    const body = await parseBody(req);

    const entityType = requireEnum(body, "entity_type", ["venue", "event", "dj"] as const);
    const entityId = requireUUID(body, "entity_id");
    const verified = body.verified !== false; // default true

    const supabase = getServiceClient();

    const tableName = entityType === "dj" ? "djs" : `${entityType}s`;

    // Verify entity exists
    const { data: entity, error: fetchError } = await supabase
      .from(tableName)
      .select("id, verified")
      .eq("id", entityId)
      .single();

    if (fetchError || !entity) throw Errors.notFound(entityType);

    if (entity.verified === verified) {
      return jsonResponse({ message: `${entityType} already ${verified ? "verified" : "unverified"}` });
    }

    const { error } = await supabase
      .from(tableName)
      .update({ verified, updated_by: admin.id })
      .eq("id", entityId);

    if (error) {
      throw Errors.internal(`Failed to update ${entityType}: ${error.message}`);
    }

    // Log admin action
    await supabase.from("admin_actions").insert({
      admin_id: admin.id,
      action_type: verified ? "verify" : "unverify",
      entity_type: entityType,
      entity_id: entityId,
    });

    log.info(`${entityType} ${verified ? "verified" : "unverified"}`, {
      admin_id: admin.id,
      entity_type: entityType,
      entity_id: entityId,
    });

    return jsonResponse({ entity_type: entityType, entity_id: entityId, verified });
  } catch (err) {
    log.error("Admin verify entity failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});
