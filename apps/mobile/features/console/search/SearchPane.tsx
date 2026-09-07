import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Button, PressRow } from "../../design/components/Button";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { PaneHead } from "../ConsoleShell";
import { noteHref } from "../nav";
import {
  countLabel,
  emptyMessage,
  folderOf,
  noteworthySources,
  scopeLabel,
  toggleScope,
  type BlendedResult,
} from "./results";
import { useBlendedSearch } from "./useBlendedSearch";

/**
 * The search page: one question, every context, one list.
 *
 * ## Why it is a page and not a bigger overlay
 *
 * The palette answers "take me to that note" and it is very good at it: ten
 * rows, no scrolling, gone the moment you press Enter. It is a *navigator*.
 * This answers a different question — "what do we know about the review cycle"
 * — where the reader has no destination in mind, needs to read several results
 * next to each other, will narrow the scope halfway through, and will open one,
 * read it, and come back. Every one of those needs a URL, and none of them
 * survives an overlay that closes on the first press.
 *
 * So the overlay keeps the first ten and hands over: `See all results` and
 * Enter on that row open this, with the query already in it.
 *
 * ## What is on a row, and what is deliberately not
 *
 * A context badge, the note's title, its folder, and the line the index matched
 * on. **No author and no modified date.** The projection stores
 * `notes.uploaded` as `null` by construction and neither index carries an
 * author at all, so both would be new index fields — and a date invented from
 * something else on the page is exactly the kind of plausible fiction this
 * console has had to remove before (`ConsoleStorage.objectCount`: absent means
 * nobody looked, and a client renders nothing rather than a zero).
 *
 * ## The scope is always visible, and empty means everything
 *
 * The chips say what was searched before you read what was found, because a
 * result list is only interpretable against the set it came from. Turning every
 * chip off returns to "all fast-search contexts" rather than searching nothing
 * — see `toggleScope`.
 */
export function SearchPane({
  query,
  slugs,
  onQuery,
  onScope,
  onOpen,
}: {
  query: string;
  /** The scope, as slugs, from the URL. Empty means every eligible context. */
  slugs: string[];
  /** Both of these write the URL rather than local state — see the route. */
  onQuery: (next: string) => void;
  onScope: (next: string[]) => void;
  onOpen: (href: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const search = useBlendedSearch({ query, slugs });
  const [pickerOpen, setPickerOpen] = useState(false);

  const { state, results, answer, eligible } = search;
  const notes = useMemo(() => noteworthySources(answer), [answer]);

  const open = useCallback(
    (row: BlendedResult) => onOpen(noteHref(row.slug, row.path)),
    [onOpen],
  );

  /*
    The count sits beside the heading rather than above the list, because it is
    a property of the answer and not of the rows: it is taken after the privacy
    filter and it can be a floor, and both of those are easier to read next to
    "Search" than as a line the results push around.
  */
  const count =
    answer !== null && results.length > 0
      ? countLabel(answer.matchCount, answer.matchCountIsFloor)
      : undefined;

  return (
    <View style={styles.pane} testID="search-pane">
      <PaneHead
        title="Search"
        description="Every context you can reach, in one list."
        trailing={count ? <Pill>{count}</Pill> : undefined}
      />

      <TextInput
        value={query}
        onChangeText={onQuery}
        placeholder="Search every context"
        style={styles.field}
        accessibilityLabel="Search every context"
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        testID="search-field"
      />

      {/*
        The scope, always on screen. A control that has to be opened to say what
        it is set to makes every result list ambiguous until you open it.
      */}
      <View style={styles.scope}>
        <Pressable
          onPress={() => setPickerOpen((open) => !open)}
          accessibilityRole="button"
          accessibilityLabel={`Change which contexts are searched. Currently ${scopeLabel(slugs, eligible)}`}
          style={styles.scopeButton}
          testID="search-scope"
        >
          <Text variant="rowSub">{scopeLabel(slugs, eligible)}</Text>
        </Pressable>
        {slugs.length > 0 ? (
          <Button label="All contexts" onPress={() => onScope([])} testID="search-scope-all" />
        ) : null}
      </View>

      {pickerOpen ? (
        <View style={styles.picker} testID="search-scope-picker">
          {eligible.length === 0 ? (
            <Text variant="rowSub">Nothing to choose from yet.</Text>
          ) : (
            eligible.map((context) => {
              const on = slugs.length === 0 || slugs.includes(context.slug);
              return (
                <PressRow
                  key={context.workspaceId}
                  accessibilityLabel={`${on ? "Stop searching" : "Search"} @${context.slug}`}
                  selected={on}
                  onPress={() => onScope(toggleScope(slugs, context.slug))}
                  radius={radii.sm}
                  style={styles.chip}
                  testID={`search-chip-${context.slug}`}
                >
                  <Text variant="tree" numberOfLines={1}>
                    @{context.slug}
                  </Text>
                </PressRow>
              );
            })
          )}
        </View>
      ) : null}

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        testID="search-results"
      >
        {results.length === 0 ? (
          <Text variant="rowSub" style={styles.empty} testID="search-empty">
            {emptyMessage(state, query)}
          </Text>
        ) : (
          results.map((row) => (
            <PressRow
              key={`${row.workspaceId}:${row.path}`}
              accessibilityLabel={`${row.title} in @${row.slug}`}
              onPress={() => open(row)}
              radius={radii.sm}
              style={styles.row}
              testID={`search-result-${row.slug}-${row.path}`}
            >
              <View style={styles.rowHead}>
                {/*
                  The badge is the first thing on the row on purpose. In a
                  blended list the context is not metadata — it is what tells
                  you whose note you are about to open, and a row without it is
                  a path from nowhere.
                */}
                <Pill>@{row.slug}</Pill>
                <Text variant="tree" numberOfLines={1} style={styles.rowTitle}>
                  {row.title}
                </Text>
              </View>
              <Text variant="treeMeta" numberOfLines={1}>
                {folderOf(row.path) || row.path}
              </Text>
              {row.snippet ? (
                <Text variant="rowSub" numberOfLines={2} style={styles.snippet}>
                  {row.snippet}
                </Text>
              ) : null}
            </PressRow>
          ))
        )}

        {/*
          A context that could not be reached, and one still catching up. Under
          the results rather than over them: the rows above are real answers and
          a banner that pushes them down on a slow source makes the page jump on
          exactly the requests that are already slow.
        */}
        {notes.map((note) => (
          <View key={note.source.workspaceId} style={styles.note} testID={`search-source-${note.source.slug}`}>
            <Text variant="rowSub">{note.message}</Text>
            {note.retryable ? (
              <Button
                label={search.retrying === note.source.workspaceId ? "Retrying…" : "Retry"}
                onPress={() => search.retry(note.source.workspaceId)}
                testID={`search-retry-${note.source.slug}`}
              />
            ) : null}
          </View>
        ))}

        {search.hasMore ? (
          <Button
            label={search.loadingMore ? "Loading…" : "Load more"}
            onPress={search.loadMore}
            style={styles.more}
            testID="search-more"
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    pane: { flex: 1, gap: space.x3 },
    field: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.sm,
      paddingHorizontal: space.x3,
      paddingVertical: space.x2,
      color: colors.text,
      backgroundColor: colors.surface,
    },
    scope: { flexDirection: "row", alignItems: "center", gap: space.x3 },
    scopeButton: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.sm,
      paddingHorizontal: space.x3,
      paddingVertical: space.x1,
    },
    picker: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },
    chip: { paddingHorizontal: space.x3, paddingVertical: space.x1 },
    scroll: { flex: 1 },
    scrollContent: { gap: space.x2, paddingBottom: space.x6 },
    empty: { paddingVertical: space.x4 },
    row: { gap: space.x1, paddingVertical: space.x2, paddingHorizontal: space.x2 },
    rowHead: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    rowTitle: { flexShrink: 1 },
    snippet: { color: colors.text2 },
    note: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: space.x3,
      paddingVertical: space.x2,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    more: { alignSelf: "flex-start", marginTop: space.x3 },
  });
