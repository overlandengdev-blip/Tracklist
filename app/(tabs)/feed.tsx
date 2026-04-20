import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { invoke, type CommunityFeedResponse, type FeedClip } from '@/lib/api';

export default function CommunityFeedScreen() {
  const router = useRouter();
  const [clips, setClips] = useState<FeedClip[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await invoke<CommunityFeedResponse>('get-community-feed', {
        limit: 20,
        offset: 0,
      });
      setClips(data.clips ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load feed');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function onRefresh() {
    setRefreshing(true);
    load();
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#0a7ea4" />
      </View>
    );
  }

  return (
    <FlatList
      data={clips}
      keyExtractor={(c) => c.id}
      contentContainerStyle={clips.length === 0 ? styles.emptyContainer : styles.listContent}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      ListEmptyComponent={
        <View style={styles.emptyInner}>
          <Ionicons name="musical-notes-outline" size={48} color="#bbb" />
          <Text style={styles.emptyTitle}>{error ? 'Could not load feed' : 'No clips yet'}</Text>
          <Text style={styles.emptyText}>
            {error ?? 'Be the first to post a clip from tonight.'}
          </Text>
        </View>
      }
      renderItem={({ item }) => (
        <ClipCard
          clip={item}
          onPress={() => router.push({ pathname: '/clip/[id]', params: { id: item.id } })}
        />
      )}
    />
  );
}

function ClipCard({ clip, onPress }: { clip: FeedClip; onPress: () => void }) {
  const title = clip.tracks?.title ?? 'Unidentified track';
  const artist = clip.tracks?.artist ?? 'Tap to help ID';
  const art = clip.tracks?.artwork_url;

  return (
    <Pressable style={styles.card} onPress={onPress}>
      <View style={styles.artwork}>
        {art ? (
          <Image source={{ uri: art }} style={styles.artImg} />
        ) : (
          <View style={[styles.artImg, styles.artPlaceholder]}>
            <Ionicons name="musical-note" size={28} color="#bbb" />
          </View>
        )}
      </View>

      <View style={styles.cardBody}>
        <Text style={styles.trackTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.trackArtist} numberOfLines={1}>
          {artist}
        </Text>

        <View style={styles.metaRow}>
          <Text style={styles.meta} numberOfLines={1}>
            {clip.profiles?.display_name ?? 'Someone'}
            {clip.venues?.name ? ` · ${clip.venues.name}` : ''}
          </Text>
          <View
            style={[
              styles.statusPill,
              clip.status === 'matched'
                ? styles.pillMatched
                : clip.status === 'community'
                  ? styles.pillCommunity
                  : styles.pillUnmatched,
            ]}
          >
            <Text style={styles.statusPillText}>{clip.status}</Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  listContent: { paddingVertical: 8 },
  emptyContainer: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  emptyInner: { alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 18, fontWeight: '700', marginTop: 12 },
  emptyText: { fontSize: 14, color: '#888', textAlign: 'center' },

  card: {
    flexDirection: 'row',
    gap: 12,
    padding: 12,
    marginHorizontal: 12,
    marginVertical: 4,
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#eee',
  },
  artwork: { width: 64, height: 64, borderRadius: 8, overflow: 'hidden' },
  artImg: { width: 64, height: 64, borderRadius: 8 },
  artPlaceholder: { backgroundColor: '#f2f2f2', alignItems: 'center', justifyContent: 'center' },
  cardBody: { flex: 1, justifyContent: 'center' },
  trackTitle: { fontSize: 16, fontWeight: '700', color: '#111' },
  trackArtist: { fontSize: 14, color: '#666', marginTop: 2 },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
    gap: 8,
  },
  meta: { flex: 1, fontSize: 12, color: '#999' },
  statusPill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  statusPillText: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', color: '#fff' },
  pillMatched: { backgroundColor: '#0a7ea4' },
  pillCommunity: { backgroundColor: '#e8912d' },
  pillUnmatched: { backgroundColor: '#888' },
});
