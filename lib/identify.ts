import * as FileSystem from 'expo-file-system';
import { supabase } from '@/lib/supabase';

/**
 * Upload audio file to Supabase Storage and create a clip row.
 * Returns the clip ID.
 */
export async function uploadAndCreateClip(params: {
  userId: string;
  audioUri: string;
  durationSeconds: number;
  sourceType: 'live_recording' | 'camera_roll_upload';
  originalFilename?: string;
  clipStartOffsetSeconds?: number;
}): Promise<string> {
  const clipId = crypto.randomUUID();
  const storagePath = `${params.userId}/${clipId}.m4a`;

  // Read file as base64 for upload
  const base64 = await FileSystem.readAsStringAsync(params.audioUri, {
    encoding: 'base64',
  });

  // Convert base64 to ArrayBuffer
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // Upload to Supabase Storage
  const { error: uploadError } = await supabase.storage
    .from('audio-clips')
    .upload(storagePath, bytes.buffer, {
      contentType: 'audio/mp4',
      upsert: false,
    });

  if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

  // Insert clip row
  const { error: insertError } = await supabase
    .from('clips')
    .insert({
      id: clipId,
      user_id: params.userId,
      audio_path: storagePath,
      duration_seconds: params.durationSeconds,
      status: 'pending',
      source_type: params.sourceType,
      original_filename: params.originalFilename ?? null,
      clip_start_offset_seconds: params.clipStartOffsetSeconds ?? 0,
    });

  if (insertError) throw new Error(`Insert failed: ${insertError.message}`);

  return clipId;
}

/**
 * Upload video to temp-video bucket for server-side audio extraction.
 * Returns the storage path.
 */
export async function uploadTempVideo(params: {
  userId: string;
  clipId: string;
  videoUri: string;
}): Promise<string> {
  const storagePath = `${params.userId}/${params.clipId}.mp4`;

  const base64 = await FileSystem.readAsStringAsync(params.videoUri, {
    encoding: 'base64',
  });

  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const { error } = await supabase.storage
    .from('temp-video')
    .upload(storagePath, bytes.buffer, {
      contentType: 'video/mp4',
      upsert: false,
    });

  if (error) throw new Error(`Video upload failed: ${error.message}`);

  return storagePath;
}

/**
 * Call the identify-clip edge function.
 * For now this is stubbed — returns 'unmatched' after a delay.
 */
export async function identifyClip(clipId: string): Promise<{
  status: 'matched' | 'unmatched';
  trackTitle?: string;
  trackArtist?: string;
}> {
  const { data, error } = await supabase.functions.invoke('identify-clip', {
    body: { clip_id: clipId },
  });

  if (error) {
    // If edge function doesn't exist yet, simulate unmatched
    console.warn('identify-clip function not available, simulating unmatched:', error.message);
    // Update clip status directly as fallback
    await supabase
      .from('clips')
      .update({ status: 'unmatched' })
      .eq('id', clipId);
    return { status: 'unmatched' };
  }

  return data;
}

/**
 * Subscribe to realtime clip status changes.
 */
export function subscribeToClipStatus(
  clipId: string,
  onStatusChange: (status: string, trackId: string | null) => void,
) {
  const channel = supabase
    .channel(`clip-${clipId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'clips',
        filter: `id=eq.${clipId}`,
      },
      (payload) => {
        const { status, matched_track_id } = payload.new as {
          status: string;
          matched_track_id: string | null;
        };
        onStatusChange(status, matched_track_id);
      },
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}
