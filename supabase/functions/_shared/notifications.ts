import { getServiceClient } from "./supabase-admin.ts";
import { logInfo, logWarn, logError } from "./logging.ts";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const LOG_CTX = { function_name: "notifications" };

export interface NotificationPayload {
  userId: string;
  type: string;
  actorId?: string;
  entityType?: string;
  entityId?: string;
  data?: Record<string, unknown>;
  /** Push notification title */
  title?: string;
  /** Push notification body text */
  body?: string;
}

/**
 * Insert a notification row and optionally send push notification.
 * Checks user's notification_preferences before sending push.
 * Fails silently — notifications should never break the main flow.
 */
export async function sendNotification(
  payload: NotificationPayload,
): Promise<void> {
  const supabase = getServiceClient();

  try {
    // Check if notifications are enabled globally
    const { data: config } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", "notifications_enabled")
      .single();

    if (config?.value === false || config?.value === "false") {
      logInfo("Notifications disabled globally, skipping", LOG_CTX);
      return;
    }

    // Insert notification row
    const { data: notification, error: insertError } = await supabase
      .from("notifications")
      .insert({
        user_id: payload.userId,
        type: payload.type,
        actor_id: payload.actorId ?? null,
        entity_type: payload.entityType ?? null,
        entity_id: payload.entityId ?? null,
        data: payload.data ?? {},
      })
      .select("id")
      .single();

    if (insertError) {
      logError("Failed to insert notification", {
        ...LOG_CTX,
        user_id: payload.userId,
        error: insertError.message,
      });
      return;
    }

    // Check user's notification preferences
    const { data: profile } = await supabase
      .from("profiles")
      .select("notification_preferences")
      .eq("id", payload.userId)
      .single();

    const prefs = (profile?.notification_preferences ?? {}) as Record<
      string,
      boolean
    >;

    // If user has explicitly disabled this notification type, skip push
    if (prefs[payload.type] === false) {
      logInfo("User disabled this notification type", {
        ...LOG_CTX,
        user_id: payload.userId,
        type: payload.type,
      });
      return;
    }

    // Send push notification if title and body provided
    if (payload.title && payload.body) {
      await sendPushToUser(
        supabase,
        payload.userId,
        payload.title,
        payload.body,
        { notificationId: notification?.id, ...payload.data },
      );

      // Mark push_sent_at
      if (notification?.id) {
        await supabase
          .from("notifications")
          .update({ push_sent_at: new Date().toISOString() })
          .eq("id", notification.id);
      }
    }
  } catch (err) {
    logError("Notification send failed", {
      ...LOG_CTX,
      user_id: payload.userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Send push notification to all of a user's registered devices.
 */
async function sendPushToUser(
  supabase: ReturnType<typeof getServiceClient>,
  userId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void> {
  // Fetch all push tokens for this user
  const { data: tokens, error } = await supabase
    .from("push_tokens")
    .select("id, token")
    .eq("user_id", userId);

  if (error || !tokens?.length) {
    return; // No tokens = no push, not an error
  }

  // Build Expo push messages
  const messages = tokens.map((t) => ({
    to: t.token,
    title,
    body,
    data: data ?? {},
    sound: "default" as const,
  }));

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messages),
    });

    if (!response.ok) {
      logWarn("Expo Push API returned non-200", {
        ...LOG_CTX,
        status: response.status,
        user_id: userId,
      });
      return;
    }

    const result = await response.json();

    // Handle per-token errors (e.g., DeviceNotRegistered)
    if (Array.isArray(result.data)) {
      for (let i = 0; i < result.data.length; i++) {
        const ticket = result.data[i];
        if (
          ticket.status === "error" &&
          ticket.details?.error === "DeviceNotRegistered"
        ) {
          // Delete the invalid token
          logInfo("Removing invalid push token (DeviceNotRegistered)", {
            ...LOG_CTX,
            user_id: userId,
            token_id: tokens[i].id,
          });
          await supabase
            .from("push_tokens")
            .delete()
            .eq("id", tokens[i].id);
        }
      }
    }
  } catch (err) {
    logError("Expo Push API request failed", {
      ...LOG_CTX,
      user_id: userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Send notification to multiple users at once.
 * Useful for notifying all upvoters when an ID is accepted.
 */
export async function sendBulkNotifications(
  payloads: NotificationPayload[],
): Promise<void> {
  // Send concurrently but cap at 10 at a time to be polite
  const BATCH_SIZE = 10;
  for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
    const batch = payloads.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(batch.map((p) => sendNotification(p)));
  }
}
