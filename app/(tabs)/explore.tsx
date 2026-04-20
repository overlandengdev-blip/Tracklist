import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { invoke, type SearchEverythingResponse } from '@/lib/api';

export default function ExploreScreen() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchEverythingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback(async (q: string) => {
    if (q.trim().length < 2) {
      setResults(null);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const res = await invoke<SearchEverythingResponse>('search-everything', { query: q.trim() });
      setResults(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(query), 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, runSearch]);

  const hasResults =
    results &&
    (results.tracks.length > 0 ||
      results.venues.length > 0 ||
      results.djs.length > 0 ||
      results.events.length > 0);

  return (
    <View style={styles.container}>
      <View style={styles.searchBar}>
        <Ionicons name="search" size={18} color="#888" />
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Search tracks, venues, DJs, events"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        {query.length > 0 && (
          <Pressable onPress={() => setQuery('')}>
            <Ionicons name="close-circle" size={18} color="#bbb" />
          </Pressable>
        )}
      </View>

      {loading && (
        <View style={styles.loadingBar}>
          <ActivityIndicator size="small" color="#0a7ea4" />
        </View>
      )}

      {error && <Text style={styles.errorText}>{error}</Text>}

      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {!query && (
          <View style={styles.hint}>
            <Ionicons name="search-outline" size={40} color="#ccc" />
            <Text style={styles.hintText}>Start typing to search</Text>
          </View>
        )}

        {query && !loading && !hasResults && !error && (
          <View style={styles.hint}>
            <Ionicons name="sad-outline" size={40} color="#ccc" />
            <Text style={styles.hintText}>No results for &quot;{query}&quot;</Text>
          </View>
        )}

        {results && (
          <>
            {results.tracks.length > 0 && (
              <Section title="Tracks">
                {results.tracks.map((t) => (
                  <View key={t.id} style={styles.row}>
                    {t.artwork_url ? (
                      <Image source={{ uri: t.artwork_url }} style={styles.thumb} />
                    ) : (
                      <View style={[styles.thumb, styles.thumbPlaceholder]}>
                        <Ionicons name="musical-note" size={20} color="#bbb" />
                      </View>
                    )}
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {t.title}
                      </Text>
                      <Text style={styles.rowSub} numberOfLines={1}>
                        {t.artist}
                      </Text>
                    </View>
                  </View>
                ))}
              </Section>
            )}

            {results.venues.length > 0 && (
              <Section title="Venues">
                {results.venues.map((v) => (
                  <View key={v.id} style={styles.row}>
                    <View style={[styles.thumb, styles.thumbPlaceholder]}>
                      <Ionicons name="location" size={20} color="#bbb" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {v.name}
                      </Text>
                      {v.city && (
                        <Text style={styles.rowSub} numberOfLines={1}>
                          {v.city}
                        </Text>
                      )}
                    </View>
                  </View>
                ))}
              </Section>
            )}

            {results.djs.length > 0 && (
              <Section title="DJs">
                {results.djs.map((d) => (
                  <View key={d.id} style={styles.row}>
                    {d.avatar_url ? (
                      <Image source={{ uri: d.avatar_url }} style={styles.thumb} />
                    ) : (
                      <View style={[styles.thumb, styles.thumbPlaceholder]}>
                        <Ionicons name="disc" size={20} color="#bbb" />
                      </View>
                    )}
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {d.name}
                      </Text>
                    </View>
                  </View>
                ))}
              </Section>
            )}

            {results.events.length > 0 && (
              <Section title="Events">
                {results.events.map((e) => (
                  <View key={e.id} style={styles.row}>
                    <View style={[styles.thumb, styles.thumbPlaceholder]}>
                      <Ionicons name="calendar" size={20} color="#bbb" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {e.name}
                      </Text>
                      {e.start_time && (
                        <Text style={styles.rowSub} numberOfLines={1}>
                          {new Date(e.start_time).toLocaleDateString()}
                        </Text>
                      )}
                    </View>
                  </View>
                ))}
              </Section>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#f3f3f3',
  },
  searchInput: { flex: 1, fontSize: 15, color: '#111' },
  loadingBar: { paddingVertical: 8 },
  errorText: { color: '#c00', textAlign: 'center', padding: 12 },
  scroll: { paddingBottom: 40 },
  hint: { alignItems: 'center', gap: 8, padding: 40 },
  hintText: { color: '#888' },
  section: { paddingHorizontal: 16, paddingTop: 12 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  thumb: { width: 40, height: 40, borderRadius: 6 },
  thumbPlaceholder: {
    backgroundColor: '#f5f5f5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: { fontSize: 15, fontWeight: '600', color: '#111' },
  rowSub: { fontSize: 13, color: '#777', marginTop: 2 },
});
