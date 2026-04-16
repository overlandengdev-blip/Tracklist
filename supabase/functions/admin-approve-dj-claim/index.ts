import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAdmin } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import { parseBody, requireUUID, requireEnum, optionalString } from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";
import { sendNotification } from "../_shared/notifications.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("admin-approve-dj-claim");

  try {
    const admin = await requireAdmin(req);
    const body = await parseBody(req);

    const claimId = requireUUID(body, "claim_id");
    const decision = requireEnum(body, "decision", ["approved", "rejected"] as const);
    const adminNote = optionalString(body, "admin_note", { maxLength: 2000 });

    const supabase = getServiceClient();

    const { data: claim, error: claimError } = await supabase
      .from("dj_claim_requests")
      .select("id, dj_id, user_id, status")
      .eq("id", claimId)
      .single();

    if (claimError || !claim) throw Errors.notFound("DJ claim request");

    if (claim.status !== "pending") {
      throw Errors.conflict(`Claim already ${claim.status}`);
    }

    // Update claim
    const { error: updateError } = await supabase
      .from("dj_claim_requests")
      .update({
        status: decision,
        admin_note: adminNote,
        resolved_at: new Date().toISOString(),
        resolved_by: admin.id,
      })
      .eq("id", claimId);

    if (updateError) {
      throw Errors.internal(`Failed to update claim: ${updateError.message}`);
    }

    // If approved, set claimed_by_user_id on the DJ profile
    if (decision === "approved") {
      await supabase
        .from("djs")
        .update({ claimed_by_user_id: claim.user_id, updated_by: admin.id })
        .eq("id", claim.dj_id);
    }

    // Log admin action
    await supabase.from("admin_actions").insert({
      admin_id: admin.id,
      action_type: `dj_claim_${decision}`,
      entity_type: "dj_claim_request",
      entity_id: claimId,
      details: { dj_id: claim.dj_id, decision, admin_note: adminNote },
    });

    // Notify the claimant
    const { data: dj } = await supabase
      .from("djs")
      .select("name")
      .eq("id", claim.dj_id)
      .single();

    await sendNotification({
      userId: claim.user_id,
      type: decision === "approved" ? "dj_claim_approved" : "dj_claim_rejected",
      actorId: admin.id,
      entityType: "dj",
      entityId: claim.dj_id,
      title: decision === "approved" ? "DJ claim approved!" : "DJ claim update",
      body: decision === "approved"
        ? `Your claim for the ${dj?.name ?? "DJ"} profile has been approved. You can now manage it.`
        : `Your claim for the ${dj?.name ?? "DJ"} profile was not approved.${adminNote ? ` Note: ${adminNote}` : ""}`,
    });

    log.info("DJ claim resolved", {
      admin_id: admin.id,
      claim_id: claimId,
      decision,
      dj_id: claim.dj_id,
    });

    return jsonResponse({ claim_id: claimId, decision });
  } catch (err) {
    log.error("Admin approve DJ claim failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});
