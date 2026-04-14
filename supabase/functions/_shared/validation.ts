import { Errors } from "./errors.ts";

/**
 * Lightweight validation helpers — no external dependencies.
 * Each validator throws AppError on failure.
 */

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse and validate JSON body from request */
export async function parseBody<T = Record<string, unknown>>(
  req: Request,
): Promise<T> {
  try {
    const body = await req.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error("Expected JSON object");
    }
    return body as T;
  } catch {
    throw Errors.badRequest("Invalid or missing JSON body");
  }
}

/** Validate a required string field */
export function requireString(
  body: Record<string, unknown>,
  field: string,
  opts?: { maxLength?: number; minLength?: number },
): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw Errors.badRequest(`Missing or empty required field: ${field}`);
  }
  const trimmed = sanitizeText(value);
  if (opts?.minLength && trimmed.length < opts.minLength) {
    throw Errors.badRequest(
      `${field} must be at least ${opts.minLength} characters`,
    );
  }
  if (opts?.maxLength && trimmed.length > opts.maxLength) {
    throw Errors.badRequest(
      `${field} must be at most ${opts.maxLength} characters`,
    );
  }
  return trimmed;
}

/** Validate a required UUID field */
export function requireUUID(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = requireString(body, field);
  if (!UUID_REGEX.test(value)) {
    throw Errors.badRequest(`${field} must be a valid UUID`);
  }
  return value;
}

/** Validate an optional string field */
export function optionalString(
  body: Record<string, unknown>,
  field: string,
  opts?: { maxLength?: number },
): string | undefined {
  const value = body[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw Errors.badRequest(`${field} must be a string`);
  }
  const trimmed = sanitizeText(value);
  if (opts?.maxLength && trimmed.length > opts.maxLength) {
    throw Errors.badRequest(
      `${field} must be at most ${opts.maxLength} characters`,
    );
  }
  return trimmed;
}

/** Validate an optional UUID field */
export function optionalUUID(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = optionalString(body, field);
  if (!value) return undefined;
  if (!UUID_REGEX.test(value)) {
    throw Errors.badRequest(`${field} must be a valid UUID`);
  }
  return value;
}

/** Validate a required enum field */
export function requireEnum<T extends string>(
  body: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T {
  const value = requireString(body, field);
  if (!allowed.includes(value as T)) {
    throw Errors.badRequest(
      `${field} must be one of: ${allowed.join(", ")}`,
    );
  }
  return value as T;
}

/** Validate an optional enum field */
export function optionalEnum<T extends string>(
  body: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T | undefined {
  const value = optionalString(body, field);
  if (!value) return undefined;
  if (!allowed.includes(value as T)) {
    throw Errors.badRequest(
      `${field} must be one of: ${allowed.join(", ")}`,
    );
  }
  return value as T;
}

/** Validate an optional positive integer */
export function optionalPositiveInt(
  body: Record<string, unknown>,
  field: string,
  opts?: { max?: number; defaultValue?: number },
): number {
  const value = body[field];
  if (value === undefined || value === null) return opts?.defaultValue ?? 0;
  const num = typeof value === "number" ? value : parseInt(String(value), 10);
  if (isNaN(num) || num < 0 || !Number.isInteger(num)) {
    throw Errors.badRequest(`${field} must be a non-negative integer`);
  }
  if (opts?.max && num > opts.max) {
    throw Errors.badRequest(`${field} must be at most ${opts.max}`);
  }
  return num;
}

/** Validate an optional array of UUIDs */
export function optionalUUIDArray(
  body: Record<string, unknown>,
  field: string,
): string[] | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw Errors.badRequest(`${field} must be an array`);
  }
  for (const item of value) {
    if (typeof item !== "string" || !UUID_REGEX.test(item)) {
      throw Errors.badRequest(`Each item in ${field} must be a valid UUID`);
    }
  }
  return value;
}

/**
 * Strip control characters from text input.
 * Keeps newlines and tabs for multi-line content.
 */
export function sanitizeText(input: string): string {
  // deno-lint-ignore no-control-regex
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
}
