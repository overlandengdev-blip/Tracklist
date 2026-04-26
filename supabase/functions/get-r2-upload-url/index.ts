import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAuth } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import {
  parseBody,
  requireUUID,
  requireEnum,
  requireString,
  optionalPositiveInt,
} from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";
import { getConfigValue } from "../_shared/rate-limit.ts";
import { presignR2Put, buildR2PublicUrl } from "../_shared/r2.ts";

/**
 * get-r2-upload-url
 *
 * Returns a presigned PUT URL so the client uploads straight to Cloudflare R2.
 * Edge function never touches the bytes → zero Supabase bandwidth.
 *
 * Flow:
 *   1. Client calls this with { dj_id, target: 'dj_uploads'|'dj_clips',
 *      content_type, size_bytes, filename }.
 *   2. We verify caller owns the DJ profile and has quota.
 *   3. We insert a pending_uploads row to reserve the quota slot.
 *   4. We sign a PUT URL (5 min expiry).
 *   5. Client PUTs the file to R2 with matching Content-Type/Content-Length.
 *   6. Client calls `finalize-dj-upload` to commit the row.
 *
 * Cost guards:
 *   • Per-file size cap (25 MiB video, 250 MiB audio by default).
 *   • Per-DJ daily upload cap (app_config.dj_upload_rate_per_day).
 *   • Per-DJ total storage quota (tier-based, via check_dj_storage_quota()).
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("get-r2-upload-url");

  try {
    const user = await requireAuth(req);
    const body = await parseBody(req);

    const djId = requireUUID(body, "dj_id");
    const target = requireEnum(body, "target", [
      "dj_uploads",
      "dj_clips",
    ] as const);
    const contentType = requireString(body, "content_type", { maxLength: 100 });
    const filename = requireString(body, "filename", { maxLength: 200 });
    const sizeBytes = optionalPositiveInt(body, "size_bytes", {
      max: 2_147_483_647, // 2 GiB absolute ceiling
    });

    if (sizeBytes <= 0) {
      throw Errors.badRequest("size_bytes must be a positive integer");
    }

    const supabase = getServiceClient();

    // ── 1. Authorize: caller must own the DJ profile ─────────
    const { data: dj } = await supabase
      .from("djs")
      .select("id, claimed_by_user_id, tier, storage_bytes_used")
      .eq("id", djId)
      .maybeSingle();

    if (!dj) throw Errors.notFound("DJ");
    if (dj.claimed_by_user_id !== user.id) {
      throw Errors.forbidden("You do not own this DJ profile");
    }

    // ── 2. MIME + size gating per target ────────────────────
    const audioTypes = new Set([
      "audio/mpeg",
      "audio/mp4",
      "audio/x-m4a",
      "audio/aac",
      "audio/wav",
      "audio/flac",
      "audio/ogg",
    ]);
    const videoTypes = new Set([
      "video/mp4",
      "video/quicktime",
      "video/webm",
    ]);

    const allowed = target === "dj_uploads" ? audioTypes : videoTypes;
    if (!allowed.has(contentType)) {
      throw Errors.badRequest(
        `Unsupported content_type for ${target}: ${contentType}`,
      );
    }

    const maxSize =
      target === "dj_uploads"
        ? await getConfigValue("dj_upload_max_size_bytes", 262_144_000)
        : await getConfigValue("dj_clip_max_size_bytes", 26_214_400);

    if (sizeBytes > maxSize) {
      throw Errors.badRequest(
        `File too large. Max ${Math.floor(maxSize / 1_048_576)} MiB.`,
      );
    }

    // ── 3. Daily upload rate cap (cheap guard against runaways) ──
    const dailyCap = await getConfigValue("dj_upload_rate_per_day", 20);
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const [{ count: uploadsToday }, { count: clipsToday }] = await Promise.all([
      supabase
        .from("dj_uploads")
        .select("id", { count: "exact", head: true })
        .eq("dj_id", djId)
        .gte("created_at", since),
      supabase
        .from("dj_clips")
        .select("id", { count: "exact", head: true })
        .eq("dj_id", djId)
        .gte("created_at", since),
    ]);

    if ((uploadsToday ?? 0) + (clipsToday ?? 0) >= dailyCap) {
      throw Errors.rateLimited(
        `Daily upload limit reached (${dailyCap}/day). Try again tomorrow.`,
      );
    }

    // ── 4. Storage quota check (raises on overflow) ─────────
    const { error: quotaErr } = await supabase.rpc(
      "check_dj_storage_quota",
      { p_dj_id: djId, p_additional_bytes: sizeBytes },
    );
    if (quotaErr) {
      if (quotaErr.message?.includes("Storage quota exceeded")) {
        throw Errors.conflict(
          "Storage quota exceeded. Upgrade tier or remove old uploads.",
        );
      }
      throw Errors.internal(`Quota check failed: ${quotaErr.message}`);
    }

    // ── 5. Resolve bucket + build R2 key ────────────────────
    const bucketKey =
      target === "dj_uploads" ? "r2_bucket_dj_uploads" : "r2_bucket_dj_clips";
    const domainKey =
      target === "dj_uploads"
        ? "r2_public_domain_uploads"
        : "r2_public_domain_clips";

    const { data: bucketCfg } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", bucketKey)
      .single();
    const { data: domainCfg } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", domainKey)
      .single();

    const bucket = stripQuotes(bucketCfg?.value);
    const publicDomain = stripQuotes(domainCfg?.value);
    if (!bucket) {
      throw Errors.serviceUnavailable(`R2 bucket not configured: ${bucketKey}`);
    }

    // Key shape: <dj_id>/<yyyymm>/<uuid>-<safe-filename>
    const safeName = filename
      .normalize("NFKD")
      .replace(/[^\w\-.]+/g, "_")
      .slice(0, 80);
    const ym = new Date().toISOString().slice(0, 7).replace("-", "");
    const objectId = crypto.randomUUID();
    const r2Key = `${djId}/${ym}/${objectId}-${safeName}`;

    // ── 6. Reserve quota with a pending_uploads row ─────────
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const { error: reserveErr } = await supabase.from("pending_uploads").insert({
      user_id: user.id,
      dj_id: djId,
      target_table: target,
      r2_bucket: bucket,
      r2_key: r2Key,
      max_size_bytes: sizeBytes,
      content_type: contentType,
      expires_at: expiresAt,
    });
    if (reserveErr) {
      throw Errors.internal(
        `Failed to reserve upload slot: ${reserveErr.message}`,
      );
    }

    // ── 7. Sign the PUT URL ─────────────────────────────────
    const presigned = await presignR2Put({
      bucket,
      key: r2Key,
      contentType,
      contentLength: sizeBytes,
      expiresIn: 300,
    });

    log.info("R2 upload URL issued", {
      user_id: user.id,
      dj_id: djId,
      target,
      r2_key: r2Key,
      size_bytes: sizeBytes,
    });

    return jsonResponse({
      upload: presigned,
      r2: {
        bucket,
        key: r2Key,
        public_url: publicDomain ? buildR2PublicUrl(publicDomain, r2Key) : null,
      },
      reservation: {
        expires_at: expiresAt,
        target,
      },
    });
  } catch (err) {
    log.error("get-r2-upload-url failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});

function stripQuotes(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return null;
  return String(v);
}
