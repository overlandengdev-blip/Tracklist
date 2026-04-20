import { supabase } from '@/lib/supabase';

/**
 * Invoke a Supabase edge function with a typed body and return the parsed JSON.
 * Throws a descriptive Error on failure so callers can surface messages to the user.
 */
export async function invoke<T = unknown>(
  name: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });

  if (error) {
    // supabase-js wraps non-2xx responses in FunctionsHttpError; try to extract a useful message.
    const maybeMessage =
      (data as { error?: string; message?: string } | null)?.error ??
      (data as { error?: string; message?: string } | null)?.message ??
      error.message;
    throw new Error(maybeMessage || `Edge function "${name}" failed`);
  }

  return data as T;
}

// ---------- Shape types ----------

export type FeedClip = {
  id: string;
  user_id: string;
  audio_path: string | null;
  status: string;
  is_public: boolean;
  venue_id: string | null;
  event_id: string | null;
  dj_id: string | null;
  matched_track_id: string | null;
  resolution_source: string | null;
  duration_seconds: number | null;
  recorded_at: string | null;
  created_at: string;
  profiles?: { id: string; display_name: string; avatar_url: string | null } | null;
  tracks?: { id?: string; title: string; artist: string; artwork_url: string | null } | null;
  venues?: { id: string; name: string; slug: string; city: string | null } | null;
  events?: { id: string; name: string; start_time: string | null } | null;
  djs?: { id: string; name: string; slug: string; avatar_url: string | null } | null;
};

export type CommunityId = {
  id: string;
  proposed_by: string;
  track_id: string | null;
  freeform_title: string | null;
  freeform_artist: string | null;
  confidence: number | null;
  upvotes_count: number;
  downvotes_count: number;
  is_accepted: boolean;
  created_at: string;
  profiles?: { display_name: string; avatar_url: string | null } | null;
};

export type ClipDetailResponse = {
  clip: FeedClip;
  community_ids: CommunityId[];
  user_votes: Record<string, 'up' | 'down'>;
};

export type CommunityFeedResponse = {
  clips: FeedClip[];
  total: number;
  limit: number;
  offset: number;
};

export type UserFeedResponse = {
  clips: FeedClip[];
  total: number;
  unread_notifications: number;
  limit: number;
  offset: number;
};

export type Badge = {
  id: string;
  name: string;
  slug: string;
  icon_url: string | null;
  description: string | null;
  earned_at: string;
};

export type ProfileResponse = {
  profile: {
    id: string;
    display_name: string;
    avatar_url: string | null;
    bio: string | null;
    reputation: number;
    is_admin: boolean;
    notification_preferences?: Record<string, unknown>;
    created_at: string;
    updated_at: string;
  };
  stats: {
    public_clips: number;
    proposals: number;
    accepted_ids: number;
  };
  badges: Badge[];
};

export type SearchEverythingResponse = {
  tracks: { id: string; title: string; artist: string; artwork_url: string | null }[];
  venues: { id: string; name: string; slug: string; city: string | null }[];
  djs: { id: string; name: string; slug: string; avatar_url: string | null }[];
  events: { id: string; name: string; start_time: string | null; venue_id: string | null }[];
};
