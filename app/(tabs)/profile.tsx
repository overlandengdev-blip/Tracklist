import { useEffect, useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  Pressable,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth-context';

type Profile = {
  display_name: string;
  bio: string | null;
  reputation: number;
};

export default function ProfileScreen() {
  const { session } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (session) {
      fetchProfile();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  async function fetchProfile() {
    setLoading(true);
    const { data, error } = await supabase
      .from('profiles')
      .select('display_name, bio, reputation')
      .eq('id', session!.user.id)
      .single();

    if (error) {
      Alert.alert('Error', error.message);
    } else {
      setProfile(data);
      setEditName(data.display_name);
    }
    setLoading(false);
  }

  async function handleSave() {
    if (!editName.trim()) {
      Alert.alert('Error', 'Display name cannot be empty.');
      return;
    }

    setSaving(true);
    const { error } = await supabase
      .from('profiles')
      .update({ display_name: editName.trim() })
      .eq('id', session!.user.id);

    setSaving(false);

    if (error) {
      Alert.alert('Error', error.message);
    } else {
      setProfile((prev) => prev ? { ...prev, display_name: editName.trim() } : prev);
      setEditing(false);
    }
  }

  async function handleLogout() {
    const { error } = await supabase.auth.signOut();
    if (error) Alert.alert('Error', error.message);
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.label}>Email</Text>
        <Text style={styles.value}>{session?.user.email}</Text>

        <Text style={styles.label}>Display Name</Text>
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
            <Pressable style={styles.cancelButton} onPress={() => {
              setEditing(false);
              setEditName(profile?.display_name ?? '');
            }}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable onPress={() => setEditing(true)}>
            <Text style={styles.editableValue}>
              {profile?.display_name} <Text style={styles.editHint}>✎</Text>
            </Text>
          </Pressable>
        )}

        <Text style={styles.label}>Reputation</Text>
        <Text style={styles.value}>{profile?.reputation ?? 0}</Text>
      </View>

      <Pressable style={styles.logoutButton} onPress={handleLogout}>
        <Text style={styles.logoutText}>Log Out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    backgroundColor: '#fff',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  card: {
    backgroundColor: '#f8f8f8',
    borderRadius: 12,
    padding: 20,
    marginBottom: 24,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 16,
    marginBottom: 4,
  },
  value: {
    fontSize: 16,
    color: '#222',
  },
  editableValue: {
    fontSize: 16,
    color: '#222',
  },
  editHint: {
    fontSize: 14,
    color: '#0a7ea4',
  },
  editRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
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
  saveButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
  cancelButton: {
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  cancelButtonText: {
    color: '#888',
  },
  logoutButton: {
    borderWidth: 1,
    borderColor: '#e00',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
  },
  logoutText: {
    color: '#e00',
    fontSize: 16,
    fontWeight: '600',
  },
});
