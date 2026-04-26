/**
 * Minimal Cloudflare R2 (S3-compatible) presigner.
 * Uses AWS SigV4 implemented against Deno's Web Crypto — no SDK dependency.
 *
 * R2 endpoint shape:  https://<account_id>.r2.cloudflarestorage.com/<bucket>/<key>
 * Region must be literally "auto" for R2.
 *
 * Required env:
 *   R2_ACCOUNT_ID         — from Cloudflare dashboard
 *   R2_ACCESS_KEY_ID      — R2 API token access key
 *   R2_SECRET_ACCESS_KEY  — R2 API token secret
 */

import { Errors } from "./errors.ts";

interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function getR2Config(): R2Config {
  const accountId = Deno.env.get("R2_ACCOUNT_ID");
  const accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID");
  const secretAccessKey = Deno.env.get("R2_SECRET_ACCESS_KEY");
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw Errors.serviceUnavailable(
      "R2 storage is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.",
    );
  }
  return { accountId, accessKeyId, secretAccessKey };
}

export interface PresignUploadOptions {
  bucket: string;
  key: string;
  contentType: string;
  /** Max bytes — enforced server-side via Content-Length header. */
  contentLength: number;
  /** Expiry window in seconds (max 7 days for SigV4). */
  expiresIn?: number;
}

export interface PresignedUpload {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
}

/**
 * Generate a presigned PUT URL so the client can upload straight to R2.
 * Signs Content-Type and Content-Length — server can trust those.
 */
export async function presignR2Put(
  opts: PresignUploadOptions,
): Promise<PresignedUpload> {
  const { accountId, accessKeyId, secretAccessKey } = getR2Config();
  const expiresIn = Math.min(Math.max(opts.expiresIn ?? 300, 60), 604_800);

  const host = `${accountId}.r2.cloudflarestorage.com`;
  const encodedKey = opts.key.split("/").map(encodeURIComponent).join("/");
  const canonicalUri = `/${opts.bucket}/${encodedKey}`;

  const now = new Date();
  const amzDate = toAmzDate(now);
  const datestamp = amzDate.slice(0, 8);
  const credentialScope = `${datestamp}/auto/s3/aws4_request`;

  // Signed headers (client must send these exactly at upload time)
  const signedHeaders = "content-length;content-type;host";
  const canonicalHeaders =
    `content-length:${opts.contentLength}\n` +
    `content-type:${opts.contentType}\n` +
    `host:${host}\n`;

  const qs = new URLSearchParams();
  qs.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  qs.set(
    "X-Amz-Credential",
    `${accessKeyId}/${credentialScope}`,
  );
  qs.set("X-Amz-Date", amzDate);
  qs.set("X-Amz-Expires", String(expiresIn));
  qs.set("X-Amz-SignedHeaders", signedHeaders);
  // R2 requires "UNSIGNED-PAYLOAD" placeholder in canonical request
  const payloadHash = "UNSIGNED-PAYLOAD";

  // URLSearchParams sorts insertion order; canonical query string must be
  // lexicographically sorted by key.
  const canonicalQueryString = Array.from(qs.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .join("&");

  const canonicalRequest = [
    "PUT",
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = await deriveSigningKey(
    secretAccessKey,
    datestamp,
    "auto",
    "s3",
  );
  const signature = await hmacHex(signingKey, stringToSign);

  const signedQs = canonicalQueryString + `&X-Amz-Signature=${signature}`;
  const url = `https://${host}${canonicalUri}?${signedQs}`;

  return {
    url,
    method: "PUT",
    headers: {
      "Content-Type": opts.contentType,
      "Content-Length": String(opts.contentLength),
    },
    expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
  };
}

/**
 * Schedule deletion of an R2 object by enqueueing a work row.
 * A background worker (or pg_cron job hitting an edge function) processes
 * these — we don't block the request path on DELETE.
 */
export function buildR2PublicUrl(
  publicDomain: string,
  key: string,
): string {
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return `https://${publicDomain}/${encoded}`;
}

// ─────────────────────────────────────────────────────────────
// Crypto helpers
// ─────────────────────────────────────────────────────────────

function toAmzDate(d: Date): string {
  // YYYYMMDDTHHMMSSZ
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

async function sha256Hex(data: string): Promise<string> {
  const buf = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return bufferToHex(hash);
}

async function hmac(
  key: ArrayBuffer | Uint8Array,
  data: string,
): Promise<ArrayBuffer> {
  const keyBuf =
    key instanceof Uint8Array ? key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBuf,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

async function hmacHex(
  key: ArrayBuffer | Uint8Array,
  data: string,
): Promise<string> {
  return bufferToHex(await hmac(key, data));
}

async function deriveSigningKey(
  secret: string,
  datestamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kDate = await hmac(
    new TextEncoder().encode("AWS4" + secret),
    datestamp,
  );
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

function bufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}
