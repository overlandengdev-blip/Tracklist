import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { corsResponse, corsHeaders } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/supabase-admin.ts";
import { requireAuth } from "../_shared/auth.ts";
import { AppError, Errors, errorResponse, jsonResponse } from "../_shared/errors.ts";
import { parseBody, requireUUID } from "../_shared/validation.ts";
import {
  enforceRateLimit,
  recordRateLimitEvent,
  getConfigValue,
  getFeatureFlag,
} from "../_shared/rate-limit.ts";
import { createLogger } from "../_shared/logging.ts";
import { sendNotification } from "../_shared/notifications.ts";

// ── Types ──────────────────────────────────────────────────────
interface IdentifyResult {
  matched: boolean;
  title?: string;
  artist?: string;
  remixer?: string;
  label?: string;
  isrc?: string;
  spotify_id?: string;
  artwork_url?: string;
  genres?: string[];
  confidence?: number;
  raw_response?: Record<string, unknown>;
}

interface ServiceAttempt {
  service: string;
  result: IdentifyResult;
  duration_ms: number;
  cost_cents: number;
  error?: string;
}

// ── Main handler ───────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsResponse();

  const log = createLogger("identify-clip");

  try {
    const user = await requireAuth(req);
    log.info("Request received", { user_id: user.id });

    // Check master switch
    const enabled = await getFeatureFlag("identification_enabled", true);
    if (!enabled) {
      throw Errors.serviceUnavailable("Track identification is currently disabled");
    }

    const body = await parseBody(req);
    const clipId = requireUUID(body, "clip_id");

    const supabase = getServiceClient();

    // ── 1. Fetch clip and verify ownership + status ──────────
    const { data: clip, error: clipError } = await supabase
      .from("clips")
      .select("id, user_id, audio_path, status, duration_seconds")
      .eq("id", clipId)
      .single();

    if (clipError || !clip) throw Errors.notFound("Clip");
    if (clip.user_id !== user.id) throw Errors.forbidden("You do not own this clip");
    if (clip.status !== "pending") {
      throw Errors.conflict(`Clip status is '${clip.status}', expected 'pending'`);
    }

    // ── 2. Rate limit check ──────────────────────────────────
    const maxClips = await getConfigValue("max_clips_per_day_free", 10);
    await enforceRateLimit(user.id, "identify_clip", maxClips, 1440);

    // ── 3. Mark as processing ────────────────────────────────
    await supabase
      .from("clips")
      .update({ status: "processing" })
      .eq("id", clipId);

    log.info("Starting identification", { clip_id: clipId, user_id: user.id });

    // ── 4. Run identification ────────────────────────────────
    let finalResult: IdentifyResult | null = null;
    const attempts: ServiceAttempt[] = [];

    const mockEnabled = await getFeatureFlag("mock_identification_enabled", true);

    if (mockEnabled) {
      // ── MOCK MODE ──────────────────────────────────────────
      const attempt = await runMockIdentification(supabase, clipId);
      attempts.push(attempt);
      if (attempt.result.matched) finalResult = attempt.result;
    } else {
      // ── REAL MODE: ACRCloud → AudD fallback ────────────────
      const acrEnabled = await getFeatureFlag("acrcloud_enabled", false);
      const auddEnabled = await getFeatureFlag("audd_enabled", false);

      if (acrEnabled) {
        const attempt = await runACRCloud(supabase, clip.audio_path, clipId);
        attempts.push(attempt);
        if (attempt.result.matched) finalResult = attempt.result;
      }

      if (!finalResult && auddEnabled) {
        const attempt = await runAudD(supabase, clip.audio_path, clipId);
        attempts.push(attempt);
        if (attempt.result.matched) finalResult = attempt.result;
      }

      if (!acrEnabled && !auddEnabled) {
        throw Errors.serviceUnavailable(
          "No identification services enabled. Enable acrcloud_enabled or audd_enabled in app_config, or use mock_identification_enabled.",
        );
      }
    }

    // ── 5. Log all attempts to recognitions table ────────────
    for (const attempt of attempts) {
      await supabase.from("recognitions").insert({
        clip_id: clipId,
        service: attempt.service,
        request_duration_ms: attempt.duration_ms,
        success: attempt.result.matched,
        matched_track_id: null, // Updated below if matched
        confidence: attempt.result.confidence ?? null,
        raw_response: attempt.result.raw_response ?? {},
        error_message: attempt.error ?? null,
        cost_cents: attempt.cost_cents,
      });
    }

    // ── 6. Handle match / no-match ───────────────────────────
    let matchedTrackId: string | null = null;
    let resolutionSource: string | null = null;

    if (finalResult?.matched && finalResult.title && finalResult.artist) {
      // Find or create the track
      const { data: trackId, error: trackError } = await supabase.rpc(
        "find_or_create_track",
        {
          p_title: finalResult.title,
          p_artist: finalResult.artist,
          p_isrc: finalResult.isrc ?? null,
          p_spotify_id: finalResult.spotify_id ?? null,
          p_remixer: finalResult.remixer ?? null,
          p_label: finalResult.label ?? null,
          p_artwork_url: finalResult.artwork_url ?? null,
          p_genres: finalResult.genres ?? null,
          p_metadata: {},
        },
      );

      if (trackError) {
        log.error("find_or_create_track failed", {
          clip_id: clipId,
          error: trackError.message,
        });
      } else {
        matchedTrackId = trackId;
        resolutionSource = attempts[attempts.length - 1]?.service ?? "unknown";

        // Update the last recognition with the track ID
        const lastAttempt = attempts[attempts.length - 1];
        if (lastAttempt) {
          await supabase
            .from("recognitions")
            .update({ matched_track_id: matchedTrackId })
            .eq("clip_id", clipId)
            .eq("service", lastAttempt.service)
            .order("attempted_at", { ascending: false })
            .limit(1);
        }
      }
    }

    // ── 7. Update clip status ────────────────────────────────
    const newStatus = matchedTrackId ? "matched" : "unmatched";

    await supabase
      .from("clips")
      .update({
        status: newStatus,
        matched_track_id: matchedTrackId,
        resolution_source: resolutionSource,
      })
      .eq("id", clipId);

    // ── 8. Record rate limit event ───────────────────────────
    await recordRateLimitEvent(user.id, "identify_clip");

    // ── 9. Fetch final clip state ────────────────────────────
    const { data: finalClip } = await supabase
      .from("clips")
      .select(
        "id, status, matched_track_id, resolution_source, duration_seconds, source_type, created_at",
      )
      .eq("id", clipId)
      .single();

    // Fetch track info if matched
    let trackInfo = null;
    if (matchedTrackId) {
      const { data: track } = await supabase
        .from("tracks")
        .select("id, title, artist, remixer, label, artwork_url, spotify_id, isrc")
        .eq("id", matchedTrackId)
        .single();
      trackInfo = track;
    }

    // ── 10. Send notification ────────────────────────────────
    if (newStatus === "matched") {
      await sendNotification({
        userId: user.id,
        type: "clip_matched",
        entityType: "clip",
        entityId: clipId,
        data: { track_title: trackInfo?.title, track_artist: trackInfo?.artist },
        title: "Track Identified!",
        body: `${trackInfo?.title ?? "Unknown"} by ${trackInfo?.artist ?? "Unknown"}`,
      });
    } else {
      await sendNotification({
        userId: user.id,
        type: "clip_unmatched_posted_to_community",
        entityType: "clip",
        entityId: clipId,
        title: "No match found",
        body: "We couldn't identify this track. Post it to the community for help!",
      });
    }

    log.info("Identification complete", {
      clip_id: clipId,
      user_id: user.id,
      status: newStatus,
      matched_track_id: matchedTrackId,
      attempts: attempts.length,
      total_duration_ms: attempts.reduce((sum, a) => sum + a.duration_ms, 0),
    });

    return jsonResponse({
      clip: finalClip,
      track: trackInfo,
      attempts: attempts.map((a) => ({
        service: a.service,
        matched: a.result.matched,
        duration_ms: a.duration_ms,
      })),
    });
  } catch (err) {
    // If clip was set to 'processing', revert to 'pending' on error
    if (err instanceof AppError && err.code !== "CONFLICT") {
      try {
        const body2 = await req.clone().json().catch(() => null);
        if (body2?.clip_id) {
          const supabase = getServiceClient();
          await supabase
            .from("clips")
            .update({ status: "pending" })
            .eq("id", body2.clip_id)
            .eq("status", "processing");
        }
      } catch {
        // Best-effort revert
      }
    }

    log.error("Identification failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(err);
  }
});

// ── Mock Identification ──────────────────────────────────────────
async function runMockIdentification(
  supabase: ReturnType<typeof getServiceClient>,
  clipId: string,
): Promise<ServiceAttempt> {
  const start = Date.now();

  // Simulate processing time (2-3 seconds)
  await new Promise((r) => setTimeout(r, 2000 + Math.random() * 1000));

  // 40% match, 60% no-match
  const matched = Math.random() < 0.4;

  if (!matched) {
    return {
      service: "mock",
      result: {
        matched: false,
        raw_response: { mock: true, reason: "no_match" },
      },
      duration_ms: Date.now() - start,
      cost_cents: 0,
    };
  }

  // Pick a random track from the DB (if any exist)
  const { data: tracks } = await supabase
    .from("tracks")
    .select("id, title, artist, remixer, label, isrc, spotify_id, artwork_url, genres")
    .limit(50);

  if (tracks && tracks.length > 0) {
    const track = tracks[Math.floor(Math.random() * tracks.length)];
    return {
      service: "mock",
      result: {
        matched: true,
        title: track.title,
        artist: track.artist,
        remixer: track.remixer,
        label: track.label,
        isrc: track.isrc,
        spotify_id: track.spotify_id,
        artwork_url: track.artwork_url,
        genres: track.genres,
        confidence: 0.85 + Math.random() * 0.15,
        raw_response: { mock: true, source_track_id: track.id },
      },
      duration_ms: Date.now() - start,
      cost_cents: 0,
    };
  }

  // No tracks in DB — generate a fake one
  const fakeTrack = MOCK_TRACKS[Math.floor(Math.random() * MOCK_TRACKS.length)];
  return {
    service: "mock",
    result: {
      matched: true,
      title: fakeTrack.title,
      artist: fakeTrack.artist,
      label: fakeTrack.label,
      genres: fakeTrack.genres,
      confidence: 0.85 + Math.random() * 0.15,
      raw_response: { mock: true, generated: true },
    },
    duration_ms: Date.now() - start,
    cost_cents: 0,
  };
}

const MOCK_TRACKS = [
  { title: "Strobe", artist: "deadmau5", label: "mau5trap", genres: ["progressive-house"] },
  { title: "Opus", artist: "Eric Prydz", label: "Pryda", genres: ["progressive-house"] },
  { title: "Cola", artist: "CamelPhat & Elderbrook", label: "Defected", genres: ["tech-house"] },
  { title: "Losing It", artist: "Fisher", label: "Catch & Release", genres: ["tech-house"] },
  { title: "Rave", artist: "Sam Paganini", label: "Drumcode", genres: ["techno"] },
  { title: "Your Mind", artist: "Adam Beyer & Bart Skils", label: "Drumcode", genres: ["techno"] },
  { title: "Gecko", artist: "Oliver Heldens", label: "Spinnin'", genres: ["deep-house"] },
  { title: "Nobody Else", artist: "Tiga", label: "Turbo", genres: ["electro"] },
  { title: "Turn Me On", artist: "Riton & Oliver Heldens", label: "Ministry of Sound", genres: ["house"] },
  { title: "Requiem", artist: "KAS:ST", label: "Afterlife", genres: ["melodic-techno"] },
];

// ── ACRCloud Integration ─────────────────────────────────────────
async function runACRCloud(
  supabase: ReturnType<typeof getServiceClient>,
  audioPath: string,
  clipId: string,
): Promise<ServiceAttempt> {
  const start = Date.now();

  try {
    const host = Deno.env.get("ACRCLOUD_HOST");
    const accessKey = Deno.env.get("ACRCLOUD_ACCESS_KEY");
    const accessSecret = Deno.env.get("ACRCLOUD_ACCESS_SECRET");

    if (!host || !accessKey || !accessSecret) {
      return {
        service: "acrcloud",
        result: { matched: false },
        duration_ms: Date.now() - start,
        cost_cents: 0,
        error: "ACRCloud credentials not configured. Set ACRCLOUD_HOST, ACRCLOUD_ACCESS_KEY, ACRCLOUD_ACCESS_SECRET.",
      };
    }

    // Download audio from storage
    const audioData = await downloadAudio(supabase, audioPath);
    if (!audioData) {
      return {
        service: "acrcloud",
        result: { matched: false },
        duration_ms: Date.now() - start,
        cost_cents: 0,
        error: "Failed to download audio from storage",
      };
    }

    // Build ACRCloud request
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const stringToSign = `POST\n/v1/identify\n${accessKey}\naudio\n1\n${timestamp}`;

    const encoder = new TextEncoder();
    const key = encoder.encode(accessSecret);
    const data = encoder.encode(stringToSign);
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", cryptoKey, data);
    const signatureBase64 = btoa(
      String.fromCharCode(...new Uint8Array(signature)),
    );

    const formData = new FormData();
    formData.append("access_key", accessKey);
    formData.append("data_type", "audio");
    formData.append("signature_version", "1");
    formData.append("signature", signatureBase64);
    formData.append("sample_bytes", audioData.byteLength.toString());
    formData.append("timestamp", timestamp);
    formData.append("sample", new Blob([audioData]), "audio.m4a");

    const response = await fetchWithRetry(
      `https://${host}/v1/identify`,
      { method: "POST", body: formData },
      2,
    );

    const result = await response.json();
    const duration_ms = Date.now() - start;

    if (result.status?.code === 0 && result.metadata?.music?.length > 0) {
      const music = result.metadata.music[0];
      return {
        service: "acrcloud",
        result: {
          matched: true,
          title: music.title,
          artist: music.artists?.[0]?.name ?? "Unknown",
          label: music.label ?? undefined,
          isrc: music.external_ids?.isrc ?? undefined,
          confidence: (music.score ?? 80) / 100,
          raw_response: result,
        },
        duration_ms,
        cost_cents: 1, // ~$0.01 per request estimate
      };
    }

    return {
      service: "acrcloud",
      result: { matched: false, raw_response: result },
      duration_ms,
      cost_cents: 1,
    };
  } catch (err) {
    return {
      service: "acrcloud",
      result: { matched: false },
      duration_ms: Date.now() - start,
      cost_cents: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── AudD Integration ─────────────────────────────────────────────
async function runAudD(
  supabase: ReturnType<typeof getServiceClient>,
  audioPath: string,
  clipId: string,
): Promise<ServiceAttempt> {
  const start = Date.now();

  try {
    const apiToken = Deno.env.get("AUDD_API_TOKEN");

    if (!apiToken) {
      return {
        service: "audd",
        result: { matched: false },
        duration_ms: Date.now() - start,
        cost_cents: 0,
        error: "AudD API token not configured. Set AUDD_API_TOKEN.",
      };
    }

    const audioData = await downloadAudio(supabase, audioPath);
    if (!audioData) {
      return {
        service: "audd",
        result: { matched: false },
        duration_ms: Date.now() - start,
        cost_cents: 0,
        error: "Failed to download audio from storage",
      };
    }

    const formData = new FormData();
    formData.append("api_token", apiToken);
    formData.append("return", "spotify");
    formData.append("file", new Blob([audioData]), "audio.m4a");

    const response = await fetchWithRetry(
      "https://api.audd.io/",
      { method: "POST", body: formData },
      2,
    );

    const result = await response.json();
    const duration_ms = Date.now() - start;

    if (result.status === "success" && result.result) {
      const r = result.result;
      return {
        service: "audd",
        result: {
          matched: true,
          title: r.title,
          artist: r.artist,
          label: r.label ?? undefined,
          spotify_id: r.spotify?.id ?? undefined,
          artwork_url: r.spotify?.album?.images?.[0]?.url ?? undefined,
          confidence: 0.8,
          raw_response: result,
        },
        duration_ms,
        cost_cents: 2, // ~$0.02 per request estimate
      };
    }

    return {
      service: "audd",
      result: { matched: false, raw_response: result },
      duration_ms,
      cost_cents: 2,
    };
  } catch (err) {
    return {
      service: "audd",
      result: { matched: false },
      duration_ms: Date.now() - start,
      cost_cents: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────

/** Download audio file from Supabase Storage */
async function downloadAudio(
  supabase: ReturnType<typeof getServiceClient>,
  audioPath: string,
): Promise<ArrayBuffer | null> {
  const { data, error } = await supabase.storage
    .from("audio-clips")
    .download(audioPath);

  if (error || !data) {
    console.error("Audio download failed:", error?.message);
    return null;
  }

  return data.arrayBuffer();
}

/** Fetch with retry and exponential backoff */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries: number,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      // Don't retry on client errors (4xx), only server errors (5xx)
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        return response;
      }

      lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    // Exponential backoff: 1s, 2s, 4s...
    if (attempt < maxRetries) {
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError ?? new Error("All retries exhausted");
}
