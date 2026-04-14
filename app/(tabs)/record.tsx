import { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  Alert,
  ActivityIndicator,
  Animated,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { useAudioRecorder, RecordingOptions, AudioModule } from 'expo-audio';

import { useAuth } from '@/lib/auth-context';
import { uploadAndCreateClip, identifyClip } from '@/lib/identify';

const RECORDING_OPTIONS: RecordingOptions = {
  extension: '.m4a',
  sampleRate: 44100,
  numberOfChannels: 1,
  bitRate: 128000,
  ios: {
    outputFormat: 'aac',
    audioQuality: 96, // medium quality
  },
  android: {
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
  },
  web: {},
};

const MAX_DURATION = 30;

export default function IdentifyScreen() {
  const { session } = useAuth();
  const router = useRouter();

  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  const recorder = useAudioRecorder(RECORDING_OPTIONS);

  // Pulse animation while recording
  useEffect(() => {
    if (isRecording) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.15, duration: 600, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
        ]),
      );
      loop.start();
      return () => loop.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [isRecording, pulseAnim]);

  // Auto-stop at MAX_DURATION
  useEffect(() => {
    if (elapsed >= MAX_DURATION && isRecording) {
      stopRecording();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsed, isRecording]);

  async function startRecording() {
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          'Microphone Access Required',
          'Tracklist needs microphone access to record audio clips. Please enable it in Settings.',
        );
        return;
      }

      recorder.record();
      setIsRecording(true);
      setElapsed(0);

      timerRef.current = setInterval(() => {
        setElapsed((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      Alert.alert('Error', 'Failed to start recording.');
      console.error(err);
    }
  }

  const stopRecording = useCallback(async () => {
    if (!isRecording) return;

    setIsRecording(false);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) throw new Error('No recording URI');

      setUploading(true);
      setUploadStatus('Uploading audio...');

      const clipId = await uploadAndCreateClip({
        userId: session!.user.id,
        audioUri: uri,
        durationSeconds: elapsed,
        sourceType: 'live_recording',
      });

      setUploadStatus('Identifying...');
      const result = await identifyClip(clipId);

      setUploading(false);
      setUploadStatus('');

      router.push({
        pathname: '/result',
        params: {
          clipId,
          status: result.status,
          trackTitle: result.trackTitle ?? '',
          trackArtist: result.trackArtist ?? '',
          sourceType: 'live_recording',
        },
      });
    } catch (err: unknown) {
      setUploading(false);
      setUploadStatus('');
      const message = err instanceof Error ? err.message : 'Unknown error';
      Alert.alert('Error', message);
      console.error(err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording, elapsed, session, recorder]);

  async function handleUploadVideo() {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          'Library Access Required',
          'Tracklist needs access to your camera roll to upload videos.',
        );
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['videos'],
        quality: 0.8,
        videoMaxDuration: 300, // 5 minute max to keep file sizes reasonable
      });

      if (result.canceled || !result.assets[0]) return;

      const asset = result.assets[0];

      router.push({
        pathname: '/trim-video',
        params: {
          videoUri: asset.uri,
          videoDuration: String(asset.duration ? asset.duration / 1000 : 60),
          fileName: asset.fileName ?? 'video.mp4',
        },
      });
    } catch (err) {
      Alert.alert('Error', 'Failed to pick video.');
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
    <ScrollView contentContainerStyle={styles.container}>
      {/* Recording UI */}
      <View style={styles.recordSection}>
        {isRecording ? (
          <>
            <Text style={styles.timer}>{elapsed}s / {MAX_DURATION}s</Text>
            <View style={styles.progressBarBg}>
              <View style={[styles.progressBarFill, { width: `${(elapsed / MAX_DURATION) * 100}%` }]} />
            </View>
            <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
              <Pressable style={styles.stopButton} onPress={stopRecording}>
                <Ionicons name="stop" size={40} color="#fff" />
              </Pressable>
            </Animated.View>
            <Text style={styles.hint}>Tap to stop, or auto-stops at 30s</Text>
          </>
        ) : (
          <>
            <Text style={styles.heading}>What&apos;s playing?</Text>

            <Pressable style={styles.recordButton} onPress={startRecording}>
              <Ionicons name="mic" size={40} color="#fff" />
            </Pressable>
            <Text style={styles.buttonLabel}>Record Now</Text>

            <View style={styles.divider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>or</Text>
              <View style={styles.dividerLine} />
            </View>

            <Pressable style={styles.uploadButton} onPress={handleUploadVideo}>
              <Ionicons name="videocam" size={24} color="#0a7ea4" />
              <Text style={styles.uploadButtonText}>Upload Video</Text>
            </Pressable>
            <Text style={styles.uploadHint}>Pick a video from last night — we&apos;ll ID the track</Text>
          </>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: '#fff',
    paddingHorizontal: 24,
    paddingTop: 40,
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
  recordSection: {
    alignItems: 'center',
  },
  heading: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 40,
    textAlign: 'center',
  },
  timer: {
    fontSize: 48,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    marginBottom: 12,
  },
  progressBarBg: {
    width: '80%',
    height: 4,
    backgroundColor: '#eee',
    borderRadius: 2,
    marginBottom: 32,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#e00',
    borderRadius: 2,
  },
  recordButton: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#0a7ea4',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  stopButton: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#e00',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  buttonLabel: {
    marginTop: 12,
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
  },
  hint: {
    marginTop: 12,
    fontSize: 14,
    color: '#999',
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '80%',
    marginVertical: 32,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#ddd',
  },
  dividerText: {
    marginHorizontal: 16,
    fontSize: 14,
    color: '#999',
  },
  uploadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderWidth: 2,
    borderColor: '#0a7ea4',
    borderRadius: 12,
    gap: 10,
  },
  uploadButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#0a7ea4',
  },
  uploadHint: {
    marginTop: 8,
    fontSize: 13,
    color: '#999',
    textAlign: 'center',
  },
});
