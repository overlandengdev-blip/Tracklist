import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { invoke, type ClipDetailResponse, type CommunityId } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

export default function ClipDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const clipId = id!;
  const router = useRouter();
  const { session } = useAuth();
  const myUserId = session?.user.id;

  const [data, setData] = useState<ClipDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyCidId, setBusyCidId] = useState<string | null>(null);
  const [proposeOpen, setProposeOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await invoke<ClipDetailResponse>('get-clip-detail', { clip_id: clipId });
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load clip');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [clipId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleVote(cid: CommunityId, direction: 'up' | 'down') {
    try {
      setBusyCidId(cid.id);
      const current = data?.user_votes[cid.id];
      // If already voted this direction, remove the vote. Otherwise set it.
      if (current === direction) {
        await invoke('vote-on-id', { community_id: cid.id, remove: true });
      } else {
        await invoke('vote-on-id', { community_id: cid.id, direction });
      }
      await load();
    } catch (e) {
      Alert.alert('Vote failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusyCidId(null);
    }
  }

  async function handleAccept(cid: CommunityId) {
    try {
      setBusyCidId(cid.id);
      const fn = cid.is_accepted ? 'unaccept-community-id' : 'accept-community-id';
      await invoke(fn, { community_id: cid.id });
      await load();
    } catch (e) {
      Alert.alert('Could not update', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusyCidId(null);
    }
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
        <Text style={styles.errorText}>{error ?? 'Clip not found'}</Text>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backBtnText}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  const clip = data.clip;
  const isOwner = myUserId === clip.user_id;
  const matched = clip.tracks;
  const acceptedId = data.community_ids.find((c) => c.is_accepted);

  return (
    <>
      <Stack.Screen options={{ title: 'Clip' }} />
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
        {/* Track header */}
        <View style={styles.trackHeader}>
          {matched?.artwork_url ? (
            <Image source={{ uri: matched.artwork_url }} style={styles.artLarge} />
          ) : (
            <View style={[styles.artLarge, styles.artPlaceholder]}>
              <Ionicons name="musical-note" size={48} color="#bbb" />
            </View>
          )}
          <Text style={styles.trackTitle}>
            {matched?.title ?? acceptedId?.freeform_title ?? 'Unidentified track'}
          </Text>
          <Text style={styles.trackArtist}>
            {matched?.artist ?? acceptedId?.freeform_artist ?? 'Help identify it below'}
          </Text>
          {clip.resolution_source && (
            <View style={styles.sourcePill}>
              <Text style={styles.sourcePillText}>
                resolved by {clip.resolution_source.replace('_', ' ')}
              </Text>
            </View>
          )}
        </View>

        {/* Context row (venue / event / DJ / poster) */}
        <View style={styles.contextCard}>
          <ContextRow
            icon="person-outline"
            label="Posted by"
            value={clip.profiles?.display_name ?? 'Unknown'}
          />
          {clip.venues && (
            <ContextRow
              icon="location-outline"
              label="Venue"
              value={`${clip.venues.name}${clip.venues.city ? ` · ${clip.venues.city}` : ''}`}
            />
          )}
          {clip.djs && <ContextRow icon="disc-outline" label="DJ" value={clip.djs.name} />}
          {clip.events && <ContextRow icon="calendar-outline" label="Event" value={clip.events.name} />}
          <ContextRow
            icon="time-outline"
            label="Posted"
            value={new Date(clip.created_at).toLocaleString()}
          />
        </View>

        {/* Community IDs section */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Community IDs</Text>
            {!matched && (
              <Pressable
                style={styles.proposeBtn}
                onPress={() => setProposeOpen(true)}
                disabled={!myUserId}
              >
                <Ionicons name="add" size={16} color="#fff" />
                <Text style={styles.proposeBtnText}>Propose ID</Text>
              </Pressable>
            )}
          </View>

          {data.community_ids.length === 0 ? (
            <Text style={styles.emptySection}>
              {matched
                ? 'Track was auto-matched. No proposals yet.'
                : 'No proposals yet. Be the first!'}
            </Text>
          ) : (
            data.community_ids.map((cid) => (
              <CommunityIdRow
                key={cid.id}
                cid={cid}
                myVote={data.user_votes[cid.id] ?? null}
                canAccept={isOwner}
                busy={busyCidId === cid.id}
                onVote={(dir) => handleVote(cid, dir)}
                onAccept={() => handleAccept(cid)}
              />
            ))
          )}
        </View>
      </ScrollView>

      <ProposeModal
        visible={proposeOpen}
        onClose={() => setProposeOpen(false)}
        onSubmitted={async () => {
          setProposeOpen(false);
          await load();
        }}
        clipId={clipId}
      />
    </>
  );
}

function ContextRow({
  icon,
  label,
  value,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  value: string;
}) {
  return (
    <View style={styles.contextRow}>
      <Ionicons name={icon} size={16} color="#888" />
      <Text style={styles.contextLabel}>{label}</Text>
      <Text style={styles.contextValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function CommunityIdRow({
  cid,
  myVote,
  canAccept,
  busy,
  onVote,
  onAccept,
}: {
  cid: CommunityId;
  myVote: 'up' | 'down' | null;
  canAccept: boolean;
  busy: boolean;
  onVote: (dir: 'up' | 'down') => void;
  onAccept: () => void;
}) {
  const title = cid.freeform_title ?? 'Track';
  const artist = cid.freeform_artist ?? '';
  const score = cid.upvotes_count - cid.downvotes_count;

  return (
    <View style={[styles.cidCard, cid.is_accepted && styles.cidCardAccepted]}>
      <View style={styles.voteCol}>
        <Pressable
          style={[styles.voteBtn, myVote === 'up' && styles.voteBtnActiveUp]}
          onPress={() => onVote('up')}
          disabled={busy}
        >
          <Ionicons
            name="chevron-up"
            size={20}
            color={myVote === 'up' ? '#0a7ea4' : '#888'}
          />
        </Pressable>
        <Text style={styles.voteScore}>{score}</Text>
        <Pressable
          style={[styles.voteBtn, myVote === 'down' && styles.voteBtnActiveDown]}
          onPress={() => onVote('down')}
          disabled={busy}
        >
          <Ionicons
            name="chevron-down"
            size={20}
            color={myVote === 'down' ? '#e00' : '#888'}
          />
        </Pressable>
      </View>

      <View style={styles.cidBody}>
        <View style={styles.cidHeader}>
          <Text style={styles.cidTitle} numberOfLines={1}>
            {title}
          </Text>
          {cid.is_accepted && (
            <View style={styles.acceptedPill}>
              <Ionicons name="checkmark" size={12} color="#fff" />
              <Text style={styles.acceptedPillText}>Accepted</Text>
            </View>
          )}
        </View>
        {!!artist && <Text style={styles.cidArtist}>{artist}</Text>}
        <Text style={styles.cidMeta}>
          by {cid.profiles?.display_name ?? 'Unknown'} · {new Date(cid.created_at).toLocaleDateString()}
        </Text>

        {canAccept && (
          <Pressable
            style={[
              styles.acceptBtn,
              cid.is_accepted && styles.unacceptBtn,
              busy && styles.disabledBtn,
            ]}
            onPress={onAccept}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.acceptBtnText}>
                {cid.is_accepted ? 'Unaccept' : 'Accept this ID'}
              </Text>
            )}
          </Pressable>
        )}
      </View>
    </View>
  );
}

function ProposeModal({
  visible,
  onClose,
  onSubmitted,
  clipId,
}: {
  visible: boolean;
  onClose: () => void;
  onSubmitted: () => void;
  clipId: string;
}) {
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [confidence, setConfidence] = useState<'guessing' | 'pretty_sure' | 'certain'>(
    'pretty_sure',
  );
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!title.trim() || !artist.trim()) {
      Alert.alert('Missing info', 'Enter both track title and artist.');
      return;
    }
    try {
      setSubmitting(true);
      await invoke('propose-track-id', {
        clip_id: clipId,
        freeform_title: title.trim(),
        freeform_artist: artist.trim(),
        confidence,
      });
      setTitle('');
      setArtist('');
      setConfidence('pretty_sure');
      onSubmitted();
    } catch (e) {
      Alert.alert('Could not propose', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Propose a track ID</Text>

          <Text style={styles.inputLabel}>Title</Text>
          <TextInput
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            placeholder="e.g. Strings of Life"
            autoCapitalize="words"
          />

          <Text style={styles.inputLabel}>Artist</Text>
          <TextInput
            style={styles.input}
            value={artist}
            onChangeText={setArtist}
            placeholder="e.g. Derrick May"
            autoCapitalize="words"
          />

          <Text style={styles.inputLabel}>Confidence</Text>
          <View style={styles.confidenceRow}>
            {(['guessing', 'pretty_sure', 'certain'] as const).map((c) => (
              <Pressable
                key={c}
                style={[styles.confBtn, confidence === c && styles.confBtnActive]}
                onPress={() => setConfidence(c)}
              >
                <Text style={[styles.confBtnText, confidence === c && styles.confBtnTextActive]}>
                  {c === 'pretty_sure' ? 'Pretty sure' : c[0].toUpperCase() + c.slice(1)}
                </Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.modalBtns}>
            <Pressable style={styles.cancelBtn} onPress={onClose} disabled={submitting}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.primaryBtn, submitting && styles.disabledBtn]}
              onPress={submit}
              disabled={submitting}
            >
              {submitting ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.primaryBtnText}>Submit</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  container: { padding: 16, paddingBottom: 40 },
  errorText: { color: '#c00', marginBottom: 12 },
  backBtn: { paddingVertical: 10, paddingHorizontal: 16 },
  backBtnText: { color: '#0a7ea4', fontWeight: '600' },

  trackHeader: { alignItems: 'center', marginBottom: 16 },
  artLarge: { width: 160, height: 160, borderRadius: 12, marginBottom: 12 },
  artPlaceholder: { backgroundColor: '#f2f2f2', alignItems: 'center', justifyContent: 'center' },
  trackTitle: { fontSize: 22, fontWeight: '800', textAlign: 'center' },
  trackArtist: { fontSize: 16, color: '#555', marginTop: 4, textAlign: 'center' },
  sourcePill: {
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#eef5f9',
    borderRadius: 12,
  },
  sourcePillText: { color: '#0a7ea4', fontSize: 12, fontWeight: '600' },

  contextCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#eee',
    padding: 12,
    marginBottom: 16,
    gap: 8,
  },
  contextRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  contextLabel: { fontSize: 12, color: '#888', width: 72 },
  contextValue: { flex: 1, fontSize: 14, color: '#222' },

  section: { marginTop: 8 },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  sectionTitle: { fontSize: 18, fontWeight: '700' },
  proposeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#0a7ea4',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  proposeBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  emptySection: { color: '#888', fontStyle: 'italic', paddingVertical: 12 },

  cidCard: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#eee',
    padding: 10,
    marginBottom: 8,
  },
  cidCardAccepted: { borderColor: '#0a7ea4', backgroundColor: '#f5fbfe' },
  voteCol: { alignItems: 'center', justifyContent: 'center', width: 36 },
  voteBtn: {
    padding: 4,
    borderRadius: 14,
  },
  voteBtnActiveUp: { backgroundColor: '#e8f4f8' },
  voteBtnActiveDown: { backgroundColor: '#fdebeb' },
  voteScore: { fontWeight: '700', marginVertical: 2 },
  cidBody: { flex: 1 },
  cidHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cidTitle: { flex: 1, fontSize: 15, fontWeight: '700', color: '#111' },
  cidArtist: { fontSize: 14, color: '#555', marginTop: 2 },
  cidMeta: { fontSize: 12, color: '#999', marginTop: 4 },
  acceptedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: '#0a7ea4',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
  },
  acceptedPillText: { color: '#fff', fontSize: 10, fontWeight: '700' },

  acceptBtn: {
    marginTop: 8,
    backgroundColor: '#0a7ea4',
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
  },
  unacceptBtn: { backgroundColor: '#888' },
  acceptBtnText: { color: '#fff', fontWeight: '700' },
  disabledBtn: { opacity: 0.6 },

  // Modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: '#fff',
    padding: 20,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  modalTitle: { fontSize: 18, fontWeight: '800', marginBottom: 12 },
  inputLabel: { fontSize: 12, fontWeight: '600', color: '#666', marginTop: 8 },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 10,
    marginTop: 4,
    fontSize: 16,
  },
  modalBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 16 },
  cancelBtn: { paddingHorizontal: 16, paddingVertical: 10 },
  cancelBtnText: { color: '#666', fontWeight: '600' },
  primaryBtn: {
    backgroundColor: '#0a7ea4',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    minWidth: 100,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#fff', fontWeight: '700' },

  confidenceRow: { flexDirection: 'row', gap: 8, marginTop: 6 },
  confBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ddd',
    alignItems: 'center',
  },
  confBtnActive: { backgroundColor: '#0a7ea4', borderColor: '#0a7ea4' },
  confBtnText: { fontSize: 13, color: '#555', fontWeight: '600' },
  confBtnTextActive: { color: '#fff' },
});
