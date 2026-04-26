import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAuth } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import {
  parseBody,
  requireString,
  optionalString,
  optionalUUID,
  optionalPositiveInt,
  optionalEnum,
} from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";

/**
 * finalize-dj-upload
 *
 * Called after the client has PUT the file to R2. Matches the pending_uploads
 * reservation and writes the real row (dj_uploads or dj_clips). No egress is
 * paid to verify the object exists — we trust the presigned constraint (the
 * PUT only succeeds with exact Content-Length + Content-Type we signed), and
 * we rely on R2's own storage to enforce that. Orphan detection runs as a
 * separate worker against pending_uploads.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("finalize-dj-upload");

  try {
    const user = await requireAuth(req);
    const body = await parseBody(req);

    const r2Bucket = requireString(body, "r2_bucket", { maxLength: 100 });
    const r2Key = requireString(body, "r2_key", { maxLength: 500 });

    const supabase = getServiceClient();

    // ── 1. Match the pending reservation (owner + bucket/key) ──
    const { data: pending } = await supabase
      .from("pending_uploads")
      .select("*")
      .eq("r2_bucket", r2Bucket)
      .eq("r2_key", r2Key)
      .is("finalized_at", null)
      .maybeSingle();

    if (!pending) {
      throw Errors.notFound("Pending upload reservation");
    }
    if (pending.user_id !== user.id) {
      throw Errors.forbidden("You did not reserve this upload");
    }
    if (new Date(pending.expires_at).getTime() < Date.now()) {
      throw Errors.badRequest("Upload reservation expired; request a new URL");
    }

    // ── 2. Write the target row ──────────────────────────────
    let inserted: Record<string, unknown>;
    if (pending.target_table === "dj_uploads") {
      inserted = await insertDjUpload(supabase, {
        djId: pending.dj_id,
        uploadedBy: user.id,
        bucket: r2Bucket,
        key: r2Key,
        contentType: pending.content_type,
        sizeBytes: pending.max_size_bytes,
        body,
      });
    } else {
      inserted = await insertDjClip(supabase, {
        djId: pending.dj_id,
        postedBy: user.id,
        bucket: r2Bucket,
        key: r2Key,
        contentType: pending.content_type,
        sizeBytes: pending.max_size_bytes,
        body,
      });
    }

    // ── 3. Mark reservation finalized so cleanup skips it ───
    await supabase
      .from("pending_uploads")
      .update({ finalized_at: new Date().toISOString() })
      .eq("id", pending.id);

    log.info("DJ upload finalized", {
      user_id: user.id,
      dj_id: pending.dj_id,
      target: pending.target_table,
      id: inserted.id,
    });

    return jsonResponse({
      [pending.target_table === "dj_uploads" ? "upload" : "clip"]: inserted,
    }, 201);
  } catch (err) {
    log.error("finalize-dj-upload failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});

// ─────────────────────────────────────────────────────────────

async function insertDjUpload(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  args: {
    djId: string;
    uploadedBy: string;
    bucket: string;
    key: string;
    contentType: string;
    sizeBytes: number;
    body: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  const title = requireString(args.body, "title", { maxLength: 200 });
  const kind =
    optionalEnum(args.body, "kind", [
      "track",
      "set",
      "mix",
      "edit",
      "bootleg",
    ] as const) ?? "track";
  const description = optionalString(args.body, "description", {
    maxLength: 2000,
  });
  const artworkR2Key = optionalString(args.body, "artwork_r2_key", {
    maxLength: 500,
  });
  const durationSec = optionalPositiveInt(args.body, "duration_sec", {
    max: 8 * 60 * 60,
  });
  const bpm = optionalPositiveInt(args.body, "bpm", { max: 300 });
  const keySig = optionalString(args.body, "key_signature", { maxLength: 10 });
  const genre = optionalString(args.body, "genre", { maxLength: 80 });
  const venueId = optionalUUID(args.body, "recorded_venue_id");
  const visibility =
    optionalEnum(args.body, "visibility", [
      "public",
      "followers",
      "unlisted",
      "private",
    ] as const) ?? "public";

  const { data, error } = await supabase
    .from("dj_uploads")
    .insert({
      dj_id: args.djId,
      uploaded_by: args.uploadedBy,
      kind,
      title,
      description: description ?? null,
      r2_bucket: args.bucket,
      r2_key: args.key,
      artwork_r2_key: artworkR2Key ?? null,
      mime_type: args.contentType,
      size_bytes: args.sizeBytes,
      duration_sec: durationSec || null,
      bpm: bpm || null,
      key_signature: keySig ?? null,
      genre: genre ?? null,
      recorded_venue_id: venueId ?? null,
      visibility,
      status: "active",
    })
    .select()
    .single();

  if (error) throw Errors.internal(`Failed to insert dj_upload: ${error.message}`);
  return data;
}

async function insertDjClip(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  args: {
    djId: string;
    postedBy: string;
    bucket: string;
    key: string;
    contentType: string;
    sizeBytes: number;
    body: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  const durationSec = optionalPositiveInt(args.body, "duration_sec", {
    max: 120,
  });
  if (!durationSec) {
    throw Errors.badRequest("duration_sec is required for video clips");
  }

  const caption = optionalString(args.body, "caption", { maxLength: 500 });
  const thumbnailR2Key = optionalString(args.body, "thumbnail_r2_key", {
    maxLength: 500,
  });
  const width = optionalPositiveInt(args.body, "width", { max: 7680 });
  const height = optionalPositiveInt(args.body, "height", { max: 4320 });
  const venueId = optionalUUID(args.body, "venue_id");
  const eventId = optionalUUID(args.body, "event_id");
  const visibility =
    optionalEnum(args.body, "visibility", [
      "public",
      "followers",
      "unlisted",
      "private",
    ] as const) ?? "public";

  const { data, error } = await supabase
    .from("dj_clips")
    .insert({
      dj_id: args.djId,
      posted_by: args.postedBy,
      caption: caption ?? null,
      r2_bucket: args.bucket,
      r2_key: args.key,
      thumbnail_r2_key: thumbnailR2Key ?? null,
      mime_type: args.contentType,
      size_bytes: args.sizeBytes,
      duration_sec: durationSec,
      width: width || null,
      height: height || null,
      venue_id: venueId ?? null,
      event_id: eventId ?? null,
      visibility,
      status: "active",
    })
    .select()
    .single();

  if (error) throw Errors.internal(`Failed to insert dj_clip: ${error.message}`);
  return data;
}
