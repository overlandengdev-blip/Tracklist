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

import { invoke, type FeedClip, type UserFeedResponse } from '@/lib/api';

export default function MyClipsScreen() {
  const router = useRouter();
  const [clips, setClips] = useState<FeedClip[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await invoke<UserFeedResponse>('get-user-feed', { limit: 30, offset: 0 });
      setClips(data.clips ?? []);
      setUnread(data.unread_notifications ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load clips');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            load();
          }}
        />
      }
      ListHeaderComponent={
        <Pressable
          style={styles.notifRow}
          onPress={() => router.push({ pathname: '/notifications' })}
        >
          <Ionicons name="notifications-outline" size={20} color="#0a7ea4" />
          <Text style={styles.notifText}>
            {unread > 0 ? `${unread} unread notification${unread === 1 ? '' : 's'}` : 'Notifications'}
          </Text>
          {unread > 0 && (
            <View style={styles.unreadBadge}>
              <Text style={styles.unreadBadgeText}>{unread}</Text>
            </View>
          )}
          <Ionicons name="chevron-forward" size={18} color="#999" />
        </Pressable>
      }
      ListEmptyComponent={
        <View style={styles.emptyInner}>
          <Ionicons name="musical-note-outline" size={48} color="#bbb" />
          <Text style={styles.emptyTitle}>{error ? 'Could not load' : 'No clips yet'}</Text>
          <Text style={styles.emptyText}>
            {error ?? 'Record or upload a clip from the Identify tab.'}
          </Text>
        </View>
      }
      renderItem={({ item }) => (
        <Pressable
          style={styles.card}
          onPress={() => router.push({ pathname: '/clip/[id]', params: { id: item.id } })}
        >
          <View style={styles.artwork}>
            {item.tracks?.artwork_url ? (
              <Image source={{ uri: item.tracks.artwork_url }} style={styles.artImg} />
            ) : (
              <View style={[styles.artImg, styles.artPlaceholder]}>
                <Ionicons name="musical-note" size={24} color="#bbb" />
              </View>
            )}
          </View>
          <View style={styles.cardBody}>
            <Text style={styles.trackTitle} numberOfLines={1}>
              {item.tracks?.title ?? 'Unidentified'}
            </Text>
            <Text style={styles.trackArtist} numberOfLines={1}>
              {item.tracks?.artist ?? 'Tap to help ID'}
            </Text>
            <View style={styles.metaRow}>
              <Text style={styles.meta}>{new Date(item.created_at).toLocaleDateString()}</Text>
              <View
                style={[
                  styles.statusPill,
                  item.is_public ? styles.pillPublic : styles.pillPrivate,
                ]}
              >
                <Text style={styles.statusPillText}>{item.is_public ? 'public' : 'private'}</Text>
              </View>
            </View>
          </View>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  listContent: { paddingVertical: 8 },
  emptyContainer: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  emptyInner: { alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 18, fontWeight: '700', marginTop: 12 },
  emptyText: { fontSize: 14, color: '#888', textAlign: 'center' },

  notifRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 12,
    marginTop: 8,
    marginBottom: 4,
    padding: 12,
    backgroundColor: '#f5f9fb',
    borderRadius: 10,
  },
  notifText: { flex: 1, fontSize: 14, fontWeight: '600', color: '#0a7ea4' },
  unreadBadge: {
    backgroundColor: '#e00',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  unreadBadgeText: { color: '#fff', fontSize: 12, fontWeight: '700' },

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
  artwork: { width: 56, height: 56, borderRadius: 8, overflow: 'hidden' },
  artImg: { width: 56, height: 56, borderRadius: 8 },
  artPlaceholder: { backgroundColor: '#f2f2f2', alignItems: 'center', justifyContent: 'center' },
  cardBody: { flex: 1, justifyContent: 'center' },
  trackTitle: { fontSize: 16, fontWeight: '700', color: '#111' },
  trackArtist: { fontSize: 14, color: '#666', marginTop: 2 },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  meta: { fontSize: 12, color: '#999' },
  statusPill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  statusPillText: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', color: '#fff' },
  pillPublic: { backgroundColor: '#0a7ea4' },
  pillPrivate: { backgroundColor: '#888' },
});
