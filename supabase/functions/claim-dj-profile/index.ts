import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAuth } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import { parseBody, requireUUID, requireEnum, optionalString } from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("claim-dj-profile");

  try {
    const user = await requireAuth(req);
    const body = await parseBody(req);

    const djId = requireUUID(body, "dj_id");
    const verificationMethod = requireEnum(body, "verification_method", [
      "social_media",
      "email_domain",
      "other",
    ] as const);
    const verificationNote = optionalString(body, "verification_note", { maxLength: 1000 });

    const supabase = getServiceClient();

    // Verify DJ exists
    const { data: dj } = await supabase
      .from("djs")
      .select("id, name, claimed_by_user_id")
      .eq("id", djId)
      .single();

    if (!dj) throw Errors.notFound("DJ");

    if (dj.claimed_by_user_id) {
      throw Errors.conflict("This DJ profile has already been claimed");
    }

    // Check for existing pending claim by this user
    const { data: existingClaim } = await supabase
      .from("dj_claim_requests")
      .select("id, status")
      .eq("dj_id", djId)
      .eq("user_id", user.id)
      .eq("status", "pending")
      .single();

    if (existingClaim) {
      throw Errors.conflict("You already have a pending claim for this DJ profile");
    }

    const { data: claim, error } = await supabase
      .from("dj_claim_requests")
      .insert({
        dj_id: djId,
        user_id: user.id,
        verification_method: verificationMethod,
        verification_data: verificationNote
          ? { note: verificationNote }
          : {},
      })
      .select("id, dj_id, status, verification_method, created_at")
      .single();

    if (error) {
      throw Errors.internal(`Failed to submit claim: ${error.message}`);
    }

    log.info("DJ claim submitted", {
      user_id: user.id,
      dj_id: djId,
      claim_id: claim.id,
    });

    return jsonResponse({ claim }, 201);
  } catch (err) {
    log.error("Claim DJ profile failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});
