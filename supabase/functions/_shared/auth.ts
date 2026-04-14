import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { getServiceClient } from "./supabase-admin.ts";
import { AppError, Errors } from "./errors.ts";

export interface AuthUser {
  id: string;
  email?: string;
}

/**
 * Extract and verify the user from the Authorization header.
 * Returns the authenticated user or throws AppError.
 */
export async function requireAuth(req: Request): Promise<AuthUser> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw Errors.unauthorized("Missing or invalid Authorization header");
  }

  const token = authHeader.replace("Bearer ", "");
  const supabase = getServiceClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  if (error || !user) {
    throw Errors.unauthorized("Invalid or expired token");
  }

  return { id: user.id, email: user.email };
}

/**
 * Require the caller to be an admin.
 * Returns the admin user or throws AppError.
 */
export async function requireAdmin(req: Request): Promise<AuthUser> {
  const user = await requireAuth(req);
  const supabase = getServiceClient();

  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .single();

  if (!profile?.is_admin) {
    throw Errors.forbidden("Admin access required");
  }

  return user;
}

/**
 * Verify the authenticated user owns a specific clip.
 * Returns the user or throws AppError.
 */
export async function requireClipOwner(
  req: Request,
  clipId: string,
): Promise<AuthUser> {
  const user = await requireAuth(req);
  const supabase = getServiceClient();

  const { data: clip } = await supabase
    .from("clips")
    .select("user_id")
    .eq("id", clipId)
    .single();

  if (!clip) {
    throw Errors.notFound("Clip");
  }

  if (clip.user_id !== user.id) {
    throw Errors.forbidden("You do not own this clip");
  }

  return user;
}

/**
 * Get the authenticated user without throwing (returns null if not authed).
 */
export async function getOptionalUser(
  req: Request,
): Promise<AuthUser | null> {
  try {
    return await requireAuth(req);
  } catch {
    return null;
  }
}
