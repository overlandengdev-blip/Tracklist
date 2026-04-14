import { useState, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  Alert,
  ActivityIndicator,
  ScrollView,
  Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';

import { supabase } from '@/lib/supabase';
import { subscribeToClipStatus } from '@/lib/identify';

type ClipStatus = 'pending' | 'matched' | 'unmatched' | 'community' | 'error';

export default function ResultScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    clipId: string;
    status: string;
    trackTitle: string;
    trackArtist: string;
    sourceType: string;
  }>();

  const clipId = params.clipId!;
  const sourceType = params.sourceType ?? 'live_recording';

  const [status, setStatus] = useState<ClipStatus>((params.status as ClipStatus) ?? 'pending');
  const [trackTitle, setTrackTitle] = useState(params.trackTitle ?? '');
  const [trackArtist, setTrackArtist] = useState(params.trackArtist ?? '');
  const [posting, setPosting] = useState(false);

  // Subscribe to realtime status updates in case identification is async
  useEffect(() => {
    if (status === 'pending') {
      const unsubscribe = subscribeToClipStatus(clipId, async (newStatus, trackId) => {
        setStatus(newStatus as ClipStatus);

        if (newStatus === 'matched' && trackId) {
          // Fetch track details
          const { data } = await supabase
            .from('tracks')
            .select('title, artist')
            .eq('id', trackId)
            .single();

          if (data) {
            setTrackTitle(data.title);
            setTrackArtist(data.artist);
          }
        }
      });

      return unsubscribe;
    }
  }, [clipId, status]);

  async function handlePostToCommunity() {
    try {
      setPosting(true);
      const { error } = await supabase
        .from('clips')
        .update({ is_public: true, status: 'community' })
        .eq('id', clipId);

      if (error) throw error;

      setStatus('community');
      Alert.alert('Posted!', 'Your clip has been posted to the community feed for identification.');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      Alert.alert('Error', message);
    } finally {
      setPosting(false);
    }
  }

  function handleSaveVideoWithTrackInfo() {
    // TODO: Implement saving video with track info overlay to camera roll
    Alert.alert('Coming Soon', 'Save video with track info will be available in a future update.');
  }

  function handleDone() {
    router.replace('/(tabs)/record');
  }

  function handleViewFeed() {
    router.replace('/(tabs)/feed');
  }

  // Pending state — waiting for async identification
  if (status === 'pending') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#0a7ea4" />
        <Text style={styles.pendingTitle}>Identifying track...</Text>
        <Text style={styles.pendingSubtitle}>This may take a moment</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {/* Status icon */}
      <View style={styles.iconContainer}>
        {status === 'matched' ? (
          <View style={[styles.iconCircle, styles.matchedCircle]}>
            <Ionicons name="musical-notes" size={48} color="#fff" />
          </View>
        ) : (
          <View style={[styles.iconCircle, styles.unmatchedCircle]}>
            <Ionicons name="help" size={48} color="#fff" />
          </View>
        )}
      </View>

      {/* Result content */}
      {status === 'matched' ? (
        <View style={styles.resultSection}>
          <Text style={styles.matchLabel}>Track identified!</Text>
          <Text style={styles.trackTitle}>{trackTitle || 'Unknown Title'}</Text>
          <Text style={styles.trackArtist}>{trackArtist || 'Unknown Artist'}</Text>

          {/* Streaming links — stubbed with search URLs */}
          <View style={styles.linksSection}>
            <Text style={styles.linksLabel}>Listen on</Text>
            <View style={styles.linksRow}>
              <StreamingLink
                label="Spotify"
                icon="logo-apple" // Using available Ionicon
                color="#1DB954"
                query={`${trackTitle} ${trackArtist}`}
                baseUrl="https://open.spotify.com/search/"
              />
              <StreamingLink
                label="Apple"
                icon="logo-apple"
                color="#FA243C"
                query={`${trackTitle} ${trackArtist}`}
                baseUrl="https://music.apple.com/search?term="
              />
              <StreamingLink
                label="SoundCloud"
                icon="cloud"
                color="#FF5500"
                query={`${trackTitle} ${trackArtist}`}
                baseUrl="https://soundcloud.com/search?q="
              />
              <StreamingLink
                label="Beatport"
                icon="disc"
                color="#94D500"
                query={`${trackTitle} ${trackArtist}`}
                baseUrl="https://www.beatport.com/search?q="
              />
            </View>
          </View>

          {/* Save video button for camera roll uploads */}
          {sourceType === 'camera_roll_upload' && (
            <Pressable style={styles.saveVideoButton} onPress={handleSaveVideoWithTrackInfo}>
              <Ionicons name="download" size={20} color="#0a7ea4" />
              <Text style={styles.saveVideoButtonText}>Save Video with Track Info</Text>
            </Pressable>
          )}
        </View>
      ) : status === 'community' ? (
        <View style={styles.resultSection}>
          <Text style={styles.communityLabel}>Posted to community</Text>
          <Text style={styles.communitySubtitle}>
            Your clip is now visible in the feed. Other users can help identify the track!
          </Text>

          <Pressable style={styles.primaryButton} onPress={handleViewFeed}>
            <Ionicons name="list" size={20} color="#fff" />
            <Text style={styles.primaryButtonText}>View Feed</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.resultSection}>
          <Text style={styles.unmatchedLabel}>No match found</Text>
          <Text style={styles.unmatchedSubtitle}>
            We couldn&apos;t automatically identify this track. Post it to the community and let
            other music lovers help!
          </Text>

          <Pressable
            style={[styles.primaryButton, posting && styles.disabledButton]}
            onPress={handlePostToCommunity}
            disabled={posting}
          >
            {posting ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="people" size={20} color="#fff" />
                <Text style={styles.primaryButtonText}>Post to Community</Text>
              </>
            )}
          </Pressable>
        </View>
      )}

      {/* Done button */}
      <Pressable style={styles.doneButton} onPress={handleDone}>
        <Text style={styles.doneButtonText}>Back to Identify</Text>
      </Pressable>
    </ScrollView>
  );
}

/** Small streaming-service link button */
function StreamingLink({
  label,
  icon,
  color,
  query,
  baseUrl,
}: {
  label: string;
  icon: string;
  color: string;
  query: string;
  baseUrl: string;
}) {
  async function handlePress() {
    const url = `${baseUrl}${encodeURIComponent(query)}`;
    const canOpen = await Linking.canOpenURL(url);
    if (canOpen) {
      Linking.openURL(url);
    } else {
      Alert.alert('Cannot Open', `Unable to open ${label}.`);
    }
  }

  return (
    <Pressable style={[styles.streamingButton, { borderColor: color }]} onPress={handlePress}>
      <Ionicons name={icon as any} size={18} color={color} />
      <Text style={[styles.streamingLabel, { color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: '#fff',
    paddingHorizontal: 24,
    paddingTop: 60,
    paddingBottom: 40,
    alignItems: 'center',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  pendingTitle: {
    marginTop: 20,
    fontSize: 20,
    fontWeight: '700',
    color: '#333',
  },
  pendingSubtitle: {
    marginTop: 8,
    fontSize: 14,
    color: '#999',
  },

  // Icon
  iconContainer: {
    marginBottom: 24,
  },
  iconCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    justifyContent: 'center',
    alignItems: 'center',
  },
  matchedCircle: {
    backgroundColor: '#0a7ea4',
  },
  unmatchedCircle: {
    backgroundColor: '#e8912d',
  },

  // Result sections
  resultSection: {
    width: '100%',
    alignItems: 'center',
  },

  // Matched
  matchLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#0a7ea4',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 12,
  },
  trackTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: '#111',
    textAlign: 'center',
    marginBottom: 4,
  },
  trackArtist: {
    fontSize: 20,
    fontWeight: '500',
    color: '#666',
    textAlign: 'center',
    marginBottom: 32,
  },

  // Streaming links
  linksSection: {
    width: '100%',
    alignItems: 'center',
    marginBottom: 24,
  },
  linksLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#999',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 12,
  },
  linksRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 10,
  },
  streamingButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderWidth: 1.5,
    borderRadius: 20,
    gap: 6,
  },
  streamingLabel: {
    fontSize: 13,
    fontWeight: '600',
  },

  // Save video button
  saveVideoButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderWidth: 2,
    borderColor: '#0a7ea4',
    borderRadius: 12,
    gap: 10,
    marginTop: 8,
  },
  saveVideoButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#0a7ea4',
  },

  // Unmatched
  unmatchedLabel: {
    fontSize: 24,
    fontWeight: '700',
    color: '#333',
    marginBottom: 12,
  },
  unmatchedSubtitle: {
    fontSize: 15,
    color: '#666',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 32,
  },

  // Community posted
  communityLabel: {
    fontSize: 24,
    fontWeight: '700',
    color: '#0a7ea4',
    marginBottom: 12,
  },
  communitySubtitle: {
    fontSize: 15,
    color: '#666',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 32,
  },

  // Buttons
  primaryButton: {
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
  primaryButtonText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#fff',
  },
  disabledButton: {
    opacity: 0.6,
  },
  doneButton: {
    marginTop: 24,
    paddingVertical: 12,
  },
  doneButtonText: {
    fontSize: 16,
    color: '#999',
  },
});
