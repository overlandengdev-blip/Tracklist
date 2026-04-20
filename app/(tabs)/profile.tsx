import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { invoke, type Badge, type ProfileResponse } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth-context';

export default function ProfileScreen() {
  const { session } = useAuth();
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      // No user_id → returns caller's profile with private fields
      const res = await invoke<ProfileResponse>('get-profile', {});
      setData(res);
      setEditName(res.profile.display_name);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load profile');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (session) load();
  }, [session, load]);

  async function handleSave() {
    if (!editName.trim()) {
      Alert.alert('Error', 'Display name cannot be empty.');
      return;
    }
    setSaving(true);
    const { error: upErr } = await supabase
      .from('profiles')
      .update({ display_name: editName.trim() })
      .eq('id', session!.user.id);
    setSaving(false);
    if (upErr) {
      Alert.alert('Error', upErr.message);
      return;
    }
    setEditing(false);
    await load();
  }

  async function handleLogout() {
    const { error: signOutErr } = await supabase.auth.signOut();
    if (signOutErr) Alert.alert('Error', signOutErr.message);
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#0a7ea4" />
      </View>
    );
  }

  if (error || !data) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error ?? 'Could not load profile'}</Text>
        <Pressable style={styles.logoutButton} onPress={handleLogout}>
          <Text style={styles.logoutText}>Log Out</Text>
        </Pressable>
      </View>
    );
  }

  const { profile, stats, badges } = data;

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            load();
          }}
        />
      }
    >
      {/* Header */}
      <View style={styles.header}>
        {profile.avatar_url ? (
          <Image source={{ uri: profile.avatar_url }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarPlaceholder]}>
            <Ionicons name="person" size={32} color="#bbb" />
          </View>
        )}
        {editing ? (
          <View style={styles.editRow}>
            <TextInput
              style={styles.editInput}
              value={editName}
              onChangeText={setEditName}
              autoFocus
            />
            <Pressable style={styles.saveButton} onPress={handleSave} disabled={saving}>
              {saving ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.saveButtonText}>Save</Text>
              )}
            </Pressable>
            <Pressable
              style={styles.cancelButton}
              onPress={() => {
                setEditing(false);
                setEditName(profile.display_name);
              }}
            >
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable onPress={() => setEditing(true)}>
            <Text style={styles.displayName}>
              {profile.display_name} <Text style={styles.editHint}>✎</Text>
            </Text>
          </Pressable>
        )}
        <Text style={styles.email}>{session?.user.email}</Text>
      </View>

      {/* Reputation */}
      <View style={styles.repCard}>
        <Ionicons name="star" size={28} color="#e8912d" />
        <View>
          <Text style={styles.repValue}>{profile.reputation}</Text>
          <Text style={styles.repLabel}>Reputation</Text>
        </View>
      </View>

      {/* Stats */}
      <View style={styles.statsRow}>
        <StatCell label="Clips" value={stats.public_clips} />
        <StatCell label="Proposals" value={stats.proposals} />
        <StatCell label="Accepted" value={stats.accepted_ids} />
      </View>

      {/* Badges */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Badges</Text>
        {badges.length === 0 ? (
          <Text style={styles.emptyText}>
            No badges yet. Start proposing IDs — you&apos;ll earn your first one soon.
          </Text>
        ) : (
          <View style={styles.badgeGrid}>
            {badges.map((b) => (
              <BadgeChip key={b.id} badge={b} />
            ))}
          </View>
        )}
      </View>

      {/* Logout */}
      <Pressable style={styles.logoutButton} onPress={handleLogout}>
        <Text style={styles.logoutText}>Log Out</Text>
      </Pressable>
    </ScrollView>
  );
}

function StatCell({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.statCell}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function BadgeChip({ badge }: { badge: Badge }) {
  return (
    <View style={styles.badgeChip}>
      {badge.icon_url ? (
        <Image source={{ uri: badge.icon_url }} style={styles.badgeIcon} />
      ) : (
        <View style={[styles.badgeIcon, styles.badgeIconPlaceholder]}>
          <Ionicons name="trophy" size={20} color="#e8912d" />
        </View>
      )}
      <Text style={styles.badgeName} numberOfLines={2}>
        {badge.name}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, backgroundColor: '#fff', flexGrow: 1 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  errorText: { color: '#c00', marginBottom: 16 },

  header: { alignItems: 'center', marginBottom: 20 },
  avatar: { width: 80, height: 80, borderRadius: 40, marginBottom: 12 },
  avatarPlaceholder: {
    backgroundColor: '#f2f2f2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  displayName: { fontSize: 20, fontWeight: '800' },
  email: { fontSize: 13, color: '#888', marginTop: 4 },
  editHint: { fontSize: 14, color: '#0a7ea4' },
  editRow: { flexDirection: 'row', alignItems: 'center', gap: 8, width: '100%' },
  editInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 6,
    padding: 8,
    fontSize: 16,
  },
  saveButton: {
    backgroundColor: '#0a7ea4',
    borderRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  saveButtonText: { color: '#fff', fontWeight: '600' },
  cancelButton: { paddingHorizontal: 4, paddingVertical: 8 },
  cancelButtonText: { color: '#888' },

  repCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: '#fff9ee',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#f7e3b8',
    marginBottom: 16,
  },
  repValue: { fontSize: 22, fontWeight: '800', color: '#222' },
  repLabel: { fontSize: 13, color: '#888', marginTop: 2 },

  statsRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 24,
  },
  statCell: {
    flex: 1,
    backgroundColor: '#f8f8f8',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
  },
  statValue: { fontSize: 20, fontWeight: '800', color: '#111' },
  statLabel: { fontSize: 12, color: '#888', marginTop: 4, textTransform: 'uppercase' },

  section: { marginBottom: 24 },
  sectionTitle: { fontSize: 16, fontWeight: '700', marginBottom: 10 },
  emptyText: { color: '#888', fontStyle: 'italic' },

  badgeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  badgeChip: {
    width: 88,
    alignItems: 'center',
    padding: 8,
    backgroundColor: '#f8f8f8',
    borderRadius: 10,
  },
  badgeIcon: { width: 40, height: 40, borderRadius: 20, marginBottom: 6 },
  badgeIconPlaceholder: {
    backgroundColor: '#fff5e0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeName: { fontSize: 11, textAlign: 'center', fontWeight: '600' },

  logoutButton: {
    borderWidth: 1,
    borderColor: '#e00',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  logoutText: { color: '#e00', fontSize: 16, fontWeight: '600' },
});
