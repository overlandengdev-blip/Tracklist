import { getServiceClient } from "./supabase-admin.ts";
import { Errors } from "./errors.ts";

/**
 * Check rate limit via the check_rate_limit() SQL function.
 * Throws AppError(429) if the limit is exceeded.
 * Also records the action in rate_limit_events.
 */
export async function enforceRateLimit(
  userId: string,
  actionType: string,
  maxCount: number,
  windowMinutes: number = 1440, // default 24 hours
): Promise<void> {
  const supabase = getServiceClient();

  // Check current count
  const { data, error } = await supabase.rpc("check_rate_limit", {
    p_user_id: userId,
    p_action_type: actionType,
    p_max_count: maxCount,
    p_window_minutes: windowMinutes,
  });

  if (error) {
    console.error("Rate limit check failed:", error.message);
    // Fail open on DB errors — don't block users if rate limit check breaks
    return;
  }

  if (data === false) {
    throw Errors.rateLimited(
      `Rate limit exceeded for ${actionType}. Max ${maxCount} per ${windowMinutes} minutes.`,
    );
  }
}

/**
 * Record a rate limit event (call AFTER the action succeeds).
 */
export async function recordRateLimitEvent(
  userId: string,
  actionType: string,
): Promise<void> {
  const supabase = getServiceClient();

  const { error } = await supabase
    .from("rate_limit_events")
    .insert({ user_id: userId, action_type: actionType });

  if (error) {
    // Non-critical — log and continue
    console.error("Failed to record rate limit event:", error.message);
  }
}

/**
 * Get a numeric value from app_config.
 */
export async function getConfigValue(
  key: string,
  defaultValue: number,
): Promise<number> {
  const supabase = getServiceClient();

  const { data } = await supabase
    .from("app_config")
    .select("value")
    .eq("key", key)
    .single();

  if (!data?.value) return defaultValue;

  const parsed = typeof data.value === "number"
    ? data.value
    : parseInt(String(data.value), 10);

  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Get a boolean feature flag from app_config.
 */
export async function getFeatureFlag(
  key: string,
  defaultValue = false,
): Promise<boolean> {
  const supabase = getServiceClient();

  const { data } = await supabase
    .from("app_config")
    .select("value")
    .eq("key", key)
    .single();

  if (!data?.value) return defaultValue;

  // Handle both "true"/"false" strings and actual booleans
  const val = data.value;
  if (typeof val === "boolean") return val;
  if (typeof val === "string") return val === "true";
  return defaultValue;
}
