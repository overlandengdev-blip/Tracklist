import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAdmin } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import { parseBody, requireUUID, requireEnum, optionalString } from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("admin-review-report");

  try {
    const admin = await requireAdmin(req);
    const body = await parseBody(req);

    const reportId = requireUUID(body, "report_id");
    const action = requireEnum(body, "action", ["dismiss", "warn", "ban_content", "ban_user"] as const);
    const note = optionalString(body, "admin_note", { maxLength: 2000 });

    const supabase = getServiceClient();

    const { data: report, error: reportError } = await supabase
      .from("reports")
      .select("id, status, reported_entity_type, reported_entity_id, reported_user_id")
      .eq("id", reportId)
      .single();

    if (reportError || !report) throw Errors.notFound("Report");

    if (report.status !== "pending") {
      throw Errors.conflict(`Report already resolved (status: ${report.status})`);
    }

    // Update report status
    const { error: updateError } = await supabase
      .from("reports")
      .update({
        status: action === "dismiss" ? "dismissed" : "resolved",
        resolved_by: admin.id,
        resolved_at: new Date().toISOString(),
        admin_note: note,
      })
      .eq("id", reportId);

    if (updateError) {
      throw Errors.internal(`Failed to update report: ${updateError.message}`);
    }

    // Log admin action
    await supabase.from("admin_actions").insert({
      admin_id: admin.id,
      action_type: `report_${action}`,
      entity_type: report.reported_entity_type,
      entity_id: report.reported_entity_id,
      details: { report_id: reportId, action, note },
    });

    // Execute action
    if (action === "ban_content" && report.reported_entity_type === "clip") {
      await supabase
        .from("clips")
        .update({ is_public: false })
        .eq("id", report.reported_entity_id);
    }

    log.info("Report reviewed", {
      admin_id: admin.id,
      report_id: reportId,
      action,
    });

    return jsonResponse({ report_id: reportId, action, status: "processed" });
  } catch (err) {
    log.error("Admin review report failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});
