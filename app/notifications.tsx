import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { supabase } from '@/lib/supabase';
import { invoke } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

type Notification = {
  id: string;
  user_id: string;
  type: string;
  entity_type: string | null;
  entity_id: string | null;
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string;
};

export default function NotificationsScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [marking, setMarking] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    const { data, error } = await supabase
      .from('notifications')
      .select('id, user_id, type, entity_type, entity_id, title, body, read_at, created_at')
      .eq('user_id', session.user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (!error && data) setItems(data as Notification[]);
    setLoading(false);
    setRefreshing(false);
  }, [session]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleMarkAllRead() {
    try {
      setMarking(true);
      await invoke('mark-notifications-read', {});
      await load();
    } catch (e) {
      console.warn('mark-notifications-read failed', e);
    } finally {
      setMarking(false);
    }
  }

  async function handleItemTap(n: Notification) {
    // Optimistically mark as read
    if (!n.read_at) {
      try {
        await invoke('mark-notifications-read', { notification_ids: [n.id] });
        setItems((prev) =>
          prev.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)),
        );
      } catch {
        /* ignore */
      }
    }

    // Deep-link to the entity if we know how
    if (n.entity_type === 'clip' && n.entity_id) {
      router.push({ pathname: '/clip/[id]', params: { id: n.entity_id } });
    }
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#0a7ea4" />
      </View>
    );
  }

  const unreadCount = items.filter((n) => !n.read_at).length;

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Notifications',
          headerRight: () =>
            unreadCount > 0 ? (
              <Pressable onPress={handleMarkAllRead} disabled={marking} style={{ marginRight: 12 }}>
                <Text style={{ color: '#0a7ea4', fontWeight: '600' }}>
                  {marking ? '...' : 'Mark all read'}
                </Text>
              </Pressable>
            ) : null,
        }}
      />
      <FlatList
        data={items}
        keyExtractor={(n) => n.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
          />
        }
        contentContainerStyle={items.length === 0 ? styles.emptyContainer : undefined}
        ListEmptyComponent={
          <View style={styles.emptyInner}>
            <Ionicons name="notifications-off-outline" size={48} color="#bbb" />
            <Text style={styles.emptyTitle}>No notifications</Text>
            <Text style={styles.emptyText}>You&apos;ll see updates about your clips here.</Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            style={[styles.row, !item.read_at && styles.rowUnread]}
            onPress={() => handleItemTap(item)}
          >
            <View style={[styles.dot, !item.read_at && styles.dotUnread]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.title} numberOfLines={1}>
                {item.title}
              </Text>
              {item.body && (
                <Text style={styles.body} numberOfLines={2}>
                  {item.body}
                </Text>
              )}
              <Text style={styles.time}>{new Date(item.created_at).toLocaleString()}</Text>
            </View>
            {item.entity_type === 'clip' && <Ionicons name="chevron-forward" size={18} color="#bbb" />}
          </Pressable>
        )}
      />
    </>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyContainer: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  emptyInner: { alignItems: 'center', gap: 4 },
  emptyTitle: { fontSize: 18, fontWeight: '700', marginTop: 12 },
  emptyText: { fontSize: 14, color: '#888', textAlign: 'center' },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
    backgroundColor: '#fff',
  },
  rowUnread: { backgroundColor: '#f5fbfe' },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: 'transparent' },
  dotUnread: { backgroundColor: '#0a7ea4' },
  title: { fontSize: 15, fontWeight: '700', color: '#111' },
  body: { fontSize: 13, color: '#555', marginTop: 2 },
  time: { fontSize: 11, color: '#999', marginTop: 4 },
});
