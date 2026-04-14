import { useState, useRef, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  Alert,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Video, ResizeMode } from 'expo-av';

import { useAuth } from '@/lib/auth-context';
import { uploadAndCreateClip, uploadTempVideo, identifyClip } from '@/lib/identify';

const WINDOW_WIDTH = Dimensions.get('window').width;
const MIN_CLIP = 10; // seconds
const MAX_CLIP = 30; // seconds
const STEP = 5; // step size for +/- buttons

export default function TrimVideoScreen() {
  const { session } = useAuth();
  const router = useRouter();
  const videoRef = useRef<Video>(null);
  const params = useLocalSearchParams<{
    videoUri: string;
    videoDuration: string;
    fileName: string;
  }>();

  const videoUri = params.videoUri!;
  const videoDuration = parseFloat(params.videoDuration ?? '60');
  const fileName = params.fileName ?? 'video.mp4';

  // Clip window state
  const [clipStart, setClipStart] = useState(0);
  const [clipLength, setClipLength] = useState(Math.min(MAX_CLIP, videoDuration));
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');

  const clipEnd = Math.min(clipStart + clipLength, videoDuration);
  const actualClipLength = clipEnd - clipStart;

  const adjustStart = useCallback(
    (delta: number) => {
      setClipStart((prev) => {
        const maxStart = videoDuration - MIN_CLIP;
        const next = Math.max(0, Math.min(prev + delta, maxStart));
        // Seek video to new start
        videoRef.current?.setPositionAsync(next * 1000);
        // Shrink clip length if it would overshoot
        setClipLength((len) => {
          const maxLen = Math.min(MAX_CLIP, videoDuration - next);
          return Math.min(len, maxLen);
        });
        return next;
      });
    },
    [videoDuration],
  );

  const adjustLength = useCallback(
    (delta: number) => {
      setClipLength((prev) => {
        const maxLen = Math.min(MAX_CLIP, videoDuration - clipStart);
        return Math.max(MIN_CLIP, Math.min(prev + delta, maxLen));
      });
    },
    [videoDuration, clipStart],
  );

  async function handleIdentify() {
    if (!session) {
      Alert.alert('Error', 'You must be logged in.');
      return;
    }

    try {
      setUploading(true);
      setUploadStatus('Uploading video...');

      const clipId = crypto.randomUUID();

      // Upload the video to temp-video bucket
      await uploadTempVideo({
        userId: session.user.id,
        clipId,
        videoUri,
      });

      setUploadStatus('Creating clip...');

      // Create the clip row — server will extract audio later
      await uploadAndCreateClip({
        userId: session.user.id,
        audioUri: videoUri, // Placeholder — server extracts real audio
        durationSeconds: Math.round(actualClipLength),
        sourceType: 'camera_roll_upload',
        originalFilename: fileName,
        clipStartOffsetSeconds: clipStart,
      });

      setUploadStatus('Identifying...');
      const result = await identifyClip(clipId);

      setUploading(false);
      setUploadStatus('');

      router.replace({
        pathname: '/result',
        params: {
          clipId,
          status: result.status,
          trackTitle: result.trackTitle ?? '',
          trackArtist: result.trackArtist ?? '',
          sourceType: 'camera_roll_upload',
        },
      });
    } catch (err: unknown) {
      setUploading(false);
      setUploadStatus('');
      const message = err instanceof Error ? err.message : 'Unknown error';
      Alert.alert('Error', message);
      console.error(err);
    }
  }

  if (uploading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#0a7ea4" />
        <Text style={styles.statusText}>{uploadStatus}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Video preview */}
      <View style={styles.videoContainer}>
        <Video
          ref={videoRef}
          source={{ uri: videoUri }}
          style={styles.video}
          resizeMode={ResizeMode.CONTAIN}
          shouldPlay
          isLooping
          isMuted={false}
        />
      </View>

      {/* Trim controls */}
      <View style={styles.controls}>
        <Text style={styles.sectionLabel}>Select clip window</Text>

        {/* Start time control */}
        <View style={styles.controlRow}>
          <Text style={styles.controlLabel}>Start</Text>
          <Pressable
            style={[styles.stepButton, clipStart <= 0 && styles.stepButtonDisabled]}
            onPress={() => adjustStart(-STEP)}
            disabled={clipStart <= 0}
          >
            <Ionicons name="remove" size={20} color={clipStart <= 0 ? '#ccc' : '#0a7ea4'} />
          </Pressable>
          <Text style={styles.controlValue}>{formatTime(clipStart)}</Text>
          <Pressable
            style={[
              styles.stepButton,
              clipStart >= videoDuration - MIN_CLIP && styles.stepButtonDisabled,
            ]}
            onPress={() => adjustStart(STEP)}
            disabled={clipStart >= videoDuration - MIN_CLIP}
          >
            <Ionicons
              name="add"
              size={20}
              color={clipStart >= videoDuration - MIN_CLIP ? '#ccc' : '#0a7ea4'}
            />
          </Pressable>
        </View>

        {/* Length control */}
        <View style={styles.controlRow}>
          <Text style={styles.controlLabel}>Length</Text>
          <Pressable
            style={[styles.stepButton, clipLength <= MIN_CLIP && styles.stepButtonDisabled]}
            onPress={() => adjustLength(-STEP)}
            disabled={clipLength <= MIN_CLIP}
          >
            <Ionicons name="remove" size={20} color={clipLength <= MIN_CLIP ? '#ccc' : '#0a7ea4'} />
          </Pressable>
          <Text style={styles.controlValue}>{Math.round(clipLength)}s</Text>
          <Pressable
            style={[
              styles.stepButton,
              clipLength >= Math.min(MAX_CLIP, videoDuration - clipStart) &&
                styles.stepButtonDisabled,
            ]}
            onPress={() => adjustLength(STEP)}
            disabled={clipLength >= Math.min(MAX_CLIP, videoDuration - clipStart)}
          >
            <Ionicons
              name="add"
              size={20}
              color={
                clipLength >= Math.min(MAX_CLIP, videoDuration - clipStart) ? '#ccc' : '#0a7ea4'
              }
            />
          </Pressable>
        </View>

        {/* Window summary */}
        <Text style={styles.windowSummary}>
          {formatTime(clipStart)} - {formatTime(clipEnd)} ({Math.round(actualClipLength)}s)
        </Text>

        {/* Identify button */}
        <Pressable style={styles.identifyButton} onPress={handleIdentify}>
          <Ionicons name="search" size={22} color="#fff" />
          <Text style={styles.identifyButtonText}>Identify Track</Text>
        </Pressable>

        {/* Back button */}
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backButtonText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  statusText: {
    marginTop: 16,
    fontSize: 16,
    color: '#666',
  },
  videoContainer: {
    width: WINDOW_WIDTH,
    height: WINDOW_WIDTH * 0.75,
    backgroundColor: '#000',
  },
  video: {
    width: '100%',
    height: '100%',
  },
  controls: {
    flex: 1,
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    marginTop: -16,
    paddingHorizontal: 24,
    paddingTop: 24,
    alignItems: 'center',
  },
  sectionLabel: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 20,
    color: '#333',
  },
  controlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    marginBottom: 16,
    justifyContent: 'center',
    gap: 12,
  },
  controlLabel: {
    width: 55,
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
  },
  stepButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: '#0a7ea4',
    justifyContent: 'center',
    alignItems: 'center',
  },
  stepButtonDisabled: {
    borderColor: '#ddd',
  },
  controlValue: {
    width: 60,
    fontSize: 18,
    fontWeight: '700',
    color: '#333',
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  windowSummary: {
    fontSize: 16,
    fontWeight: '600',
    color: '#0a7ea4',
    marginTop: 4,
    marginBottom: 24,
  },
  identifyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0a7ea4',
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 12,
    gap: 10,
    width: '100%',
  },
  identifyButtonText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#fff',
  },
  backButton: {
    marginTop: 16,
    paddingVertical: 12,
  },
  backButtonText: {
    fontSize: 16,
    color: '#999',
  },
});
