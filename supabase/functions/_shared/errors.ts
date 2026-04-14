import { corsHeaders } from "./cors.ts";

/**
 * Structured application error with HTTP status code.
 */
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Common error factories */
export const Errors = {
  unauthorized: (msg = "Authentication required") =>
    new AppError("UNAUTHORIZED", msg, 401),
  forbidden: (msg = "Access denied") => new AppError("FORBIDDEN", msg, 403),
  notFound: (entity: string) =>
    new AppError("NOT_FOUND", `${entity} not found`, 404),
  badRequest: (msg: string) => new AppError("BAD_REQUEST", msg, 400),
  conflict: (msg: string) => new AppError("CONFLICT", msg, 409),
  rateLimited: (msg = "Rate limit exceeded") =>
    new AppError("RATE_LIMITED", msg, 429),
  internal: (msg = "Internal server error") =>
    new AppError("INTERNAL_ERROR", msg, 500),
  serviceUnavailable: (msg: string) =>
    new AppError("SERVICE_UNAVAILABLE", msg, 503),
};

/**
 * Convert any error into a consistent JSON response.
 * Shape: { error: { code, message } }
 */
export function errorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    return new Response(
      JSON.stringify({ error: { code: err.code, message: err.message } }),
      {
        status: err.status,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  // Unknown error — don't leak internals
  console.error("Unhandled error:", err);
  return new Response(
    JSON.stringify({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    }),
    {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    },
  );
}

/**
 * Wrap a JSON body into a successful response.
 */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
