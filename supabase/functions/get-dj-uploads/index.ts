import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { getOptionalUser } from "../_shared/auth.ts";
import { Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import {
  parseBody,
  requireUUID,
  optionalEnum,
  optionalPositiveInt,
} from "../_shared/validation.ts";
import { createLogger } from "../_shared/logging.ts";
import { buildR2PublicUrl } from "../_shared/r2.ts";

/**
 * get-dj-uploads
 *
 * Return a paginated feed of a DJ's uploads and/or video clips.
 * Hides private/unlisted content unless the caller is the DJ owner.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("get-dj-uploads");

  try {
    const caller = await getOptionalUser(req);
    const body = await parseBody(req);

    const djId = requireUUID(body, "dj_id");
    const kind = optionalEnum(body, "kind", [
      "all",
      "audio",
      "video",
    ] as const) ?? "all";
    const limit = optionalPositiveInt(body, "limit", { max: 50, defaultValue: 20 });
    const offset = optionalPositiveInt(body, "offset", { max: 5000, defaultValue: 0 });

    const supabase = getServiceClient();

    const { data: dj } = await supabase
      .from("djs")
      .select(
        "id, name, slug, avatar_url, cover_image_url, bio, genres, claimed_by_user_id, tier, uploads_count, clips_count, storage_bytes_used, followers_count, is_accepting_bookings, booking_email",
      )
      .eq("id", djId)
      .maybeSingle();

    if (!dj) throw Errors.notFound("DJ");

    const isOwner = caller?.id && caller.id === dj.claimed_by_user_id;

    // Resolve public CDN domains for URL rewriting
    const { data: domains } = await supabase
      .from("app_config")
      .select("key, value")
      .in("key", ["r2_public_domain_uploads", "r2_public_domain_clips"]);

    const domainMap: Record<string, string> = {};
    for (const d of domains ?? []) {
      const v = typeof d.value === "string" ? d.value : String(d.value ?? "");
      if (v) domainMap[d.key] = v;
    }

    // ── Audio uploads ────────────────────────────────────────
    let uploads: Record<string, unknown>[] = [];
    if (kind === "all" || kind === "audio") {
      let q = supabase
        .from("dj_uploads")
        .select(
          "id, kind, title, description, artwork_r2_key, r2_bucket, r2_key, mime_type, duration_sec, bpm, key_signature, camelot, genre, tags, tracklist, recorded_at, recorded_venue_id, visibility, play_count, save_count, is_featured, created_at",
        )
        .eq("dj_id", djId)
        .is("deleted_at", null)
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (!isOwner) q = q.eq("visibility", "public");

      const { data } = await q;
      uploads = (data ?? []).map((row) => ({
        ...row,
        stream_url: publicUrl(domainMap.r2_public_domain_uploads, row.r2_key as string),
        artwork_url: row.artwork_r2_key
          ? publicUrl(domainMap.r2_public_domain_uploads, row.artwork_r2_key as string)
          : null,
      }));
    }

    // ── Video clips ──────────────────────────────────────────
    let clips: Record<string, unknown>[] = [];
    if (kind === "all" || kind === "video") {
      let q = supabase
        .from("dj_clips")
        .select(
          "id, caption, r2_bucket, r2_key, thumbnail_r2_key, mime_type, duration_sec, width, height, venue_id, event_id, visibility, play_count, like_count, comment_count, recorded_at, created_at",
        )
        .eq("dj_id", djId)
        .is("deleted_at", null)
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (!isOwner) q = q.eq("visibility", "public");

      const { data } = await q;
      clips = (data ?? []).map((row) => ({
        ...row,
        video_url: publicUrl(domainMap.r2_public_domain_clips, row.r2_key as string),
        thumbnail_url: row.thumbnail_r2_key
          ? publicUrl(domainMap.r2_public_domain_clips, row.thumbnail_r2_key as string)
          : null,
      }));
    }

    // Strip storage telemetry from non-owner responses
    const djOut = { ...dj } as Record<string, unknown>;
    if (!isOwner) {
      delete djOut.storage_bytes_used;
      delete djOut.tier;
      delete djOut.booking_email;
    }

    log.info("DJ uploads listed", {
      dj_id: djId,
      uploads: uploads.length,
      clips: clips.length,
      is_owner: !!isOwner,
    });

    return jsonResponse({
      dj: djOut,
      uploads,
      clips,
      pagination: { limit, offset },
    });
  } catch (err) {
    log.error("get-dj-uploads failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});

function publicUrl(domain: string | undefined, key: string | null): string | null {
  if (!domain || !key) return null;
  return buildR2PublicUrl(domain, key);
}
