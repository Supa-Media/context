import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Button, PressRow } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { PaneHead } from "../ConsoleShell";
import { noteHref, settingsHref } from "../nav";
import {
  countLabel,
  emptyMessage,
  folderOf,
  noteworthySources,
  scopeLabel,
  toggleScope,
  upsellRows,
  type BlendedResult,
  type UpsellRow,
  type UpsellTarget,
} from "./results";
import { useBlendedSearch } from "./useBlendedSearch";

/**
 * One row of the upsell: what to say about a context that answered the slow
 * way, and — only where there is a press an owner can act on — a button that
 * opens the settings section that changes it.
 *
 * A row rather than a `PressRow`: most rows here have nothing to press
 * (`href` is `null` for a member watching another owner's "off", and for a
 * context that is merely `preparing`), and a row that is not a control must
 * not look like one.
 *
 * The label comes off the row rather than being fixed here, because the two
 * destinations are different offers — "See Premium" and "Turn it on" — and a
 * single "Open settings" over both is how a paywall gets mistaken for a switch.
 */
function UpsellRowView({ row, onOpen }: { row: UpsellRow; onOpen: (href: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.nudgeRow} testID={`search-upsell-${row.slug}`}>
      <Text variant="rowSub" style={styles.nudgeText}>
        {row.message}
      </Text>
      {row.href === null || row.action === null ? null : (
        <Button
          label={row.action}
          onPress={() => onOpen(row.href as string)}
          testID={`search-upsell-open-${row.slug}`}
        />
      )}
    </View>
  );
}

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
 * chip off returns to "all your contexts" rather than searching nothing — see
 * `toggleScope`.
 *
 * ## The upsell is under the results, never instead of them
 *
 * Every context somebody belongs to is searched; the ones without a hosted
 * index answer from their own bucket, which is slower. That is worth saying and
 * worth offering to change, and the place for both is **beneath answers the
 * page has already given**. This page used to draw the offer in place of the
 * results — four lines naming a setting, over a search that had looked at
 * nothing — which is how a working product came to read as a broken one.
 */
export function SearchPane({
  query,
  slugs,
  onQuery,
  onScope,
  onOpen,
  onClose,
}: {
  query: string;
  /** The scope, as slugs, from the URL. Empty means every context in reach. */
  slugs: string[];
  /** Both of these write the URL rather than local state — see the route. */
  onQuery: (next: string) => void;
  onScope: (next: string[]) => void;
  onOpen: (href: string) => void;
  /**
   * The way out, and it is not optional furniture.
   *
   * A phone draws no rail and no bottom toolbar on an app-level pane
   * (`features/app/frame.ts`, and the `browsing` gate in the console layout),
   * so this page shipped with the context strip as its only exit — and the one
   * pill for the context you are *in* did nothing here, because it deselects a
   * note rather than navigating. A search page you can walk into and not out of
   * is the first thing anybody notices about it.
   *
   * **The route implements this as a navigation and never as `router.back()`**,
   * which looks like the obvious answer and is wrong here twice. A scope change
   * pushes a history entry — it should — so Back from a page somebody has
   * narrowed twice walks the scopes rather than leaving, which is a Close that
   * appears not to work. And this page is a URL people paste to each other, so
   * the entry behind it is often another app's, or nothing at all.
   */
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const search = useBlendedSearch({ query, slugs });
  const [pickerOpen, setPickerOpen] = useState(false);

  const { state, results, answer, contexts } = search;
  const notes = useMemo(() => noteworthySources(answer), [answer]);
  /*
    The upsell's rows, built once from the contexts that answered the slow way.

    `settingsHref` with the section the offer is actually about — Premium where
    there is no entitlement, Search where there is and the switch is off. Two
    destinations rather than one, because `lib/fastSearch.ts` keeps entitlement
    and opt-in apart and this is the surface where sending "you have not paid"
    to a switch they cannot throw would waste the one press they give us.
  */
  const upsell = useMemo(
    () => upsellRows(contexts, (slug, target: UpsellTarget) => settingsHref(slug, target)),
    [contexts],
  );
  /*
    Shown under a settled answer, and under every slow context in it rather
    than only the ones with a press behind them — see `upsellRows`. It waits
    for the answer because a sentence about how a search was served, beside no
    search, is a sentence about nothing.
  */
  const showUpsell =
    upsell.length > 0 && state !== "idle" && state !== "searching" && state !== "failed";

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
        leading={
          <Button
            label="Close"
            leading={<Icon name="close" size={14} />}
            onPress={onClose}
            accessibilityLabel="Close search"
            testID="search-close"
          />
        }
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
          accessibilityLabel={`Change which contexts are searched. Currently ${scopeLabel(slugs, contexts)}`}
          style={styles.scopeButton}
          testID="search-scope"
        >
          <Text variant="rowSub">{scopeLabel(slugs, contexts)}</Text>
        </Pressable>
        {slugs.length > 0 ? (
          <Button label="All contexts" onPress={() => onScope([])} testID="search-scope-all" />
        ) : null}
      </View>

      {pickerOpen ? (
        <View testID="search-scope-picker">
          <View style={styles.picker}>
            {contexts.length === 0 ? (
              <Text variant="rowSub">Nothing to choose from yet.</Text>
            ) : (
              contexts.map((context) => {
                const on = slugs.length === 0 || slugs.includes(context.slug);
                return (
                  <PressRow
                    key={context.workspaceId}
                    accessibilityLabel={`${on ? "Stop searching" : "Search"} @${context.slug}${
                      context.search === "slow" ? ", searched from its own bucket" : ""
                    }`}
                    selected={on}
                    onPress={() => onScope(toggleScope(slugs, context.slug))}
                    radius={radii.sm}
                    style={styles.chip}
                    testID={`search-chip-${context.slug}`}
                  >
                    <Text variant="tree" numberOfLines={1}>
                      @{context.slug}
                    </Text>
                    {/*
                      A chip says which way its context answers, because that is
                      what the person is choosing between when they narrow a
                      scope for speed. Marked on the slow ones rather than the
                      fast ones: the mark should sit on the exception, and on an
                      account paying for nothing every chip would otherwise wear
                      a badge.
                    */}
                    {context.search === "slow" ? (
                      <Text variant="treeMeta" style={styles.chipMark}>
                        slower
                      </Text>
                    ) : null}
                  </PressRow>
                );
              })
            )}
          </View>
        </View>
      ) : null}

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        testID="search-results"
      >
        {results.length === 0 ? (
          <View style={styles.empty} testID="search-empty">
            <Text variant="rowSub">{emptyMessage(state, query)}</Text>
          </View>
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

        {/*
          The offer, at the bottom of the answer it is an offer about.

          Below "Load more" on purpose: reading the results and asking for more
          of them is the thing somebody came here to do, and an upgrade prompt
          between a list and its own "more" button is an interruption of the
          one task the page has. Down here it is what a person reaches after
          the answer, which is also when "that took a moment" is a thought they
          have actually had.
        */}
        {showUpsell ? (
          <View style={styles.upsell} testID="search-upsell">
            {upsell.map((row) => (
              <UpsellRowView key={row.workspaceId} row={row} onOpen={onOpen} />
            ))}
          </View>
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
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingHorizontal: space.x3,
      paddingVertical: space.x1,
    },
    chipMark: { color: colors.text2 },
    scroll: { flex: 1 },
    scrollContent: { gap: space.x2, paddingBottom: space.x6 },
    empty: { paddingVertical: space.x4, gap: space.x3 },
    nudgeList: { gap: space.x2, marginTop: space.x3 },
    nudgeRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: space.x3,
      paddingVertical: space.x1,
    },
    nudgeText: { flexShrink: 1, color: colors.text2 },
    row: { gap: space.x1, paddingVertical: space.x2, paddingHorizontal: space.x2 },
    rowHead: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    rowTitle: { flexShrink: 1 },
    snippet: { color: colors.text2 },
    upsell: {
      gap: space.x1,
      marginTop: space.x4,
      paddingTop: space.x3,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
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
