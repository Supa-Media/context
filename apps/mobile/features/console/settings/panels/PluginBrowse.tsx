import { useEffect, useRef, useState } from "react";
import { StyleSheet } from "react-native";
import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { Hint } from "../../../design/components/Field";
import { FormError, TextField } from "../../../design/components/Input";
import { Pill } from "../../../design/components/Pill";
import { Text } from "../../../design/components/Text";
import { useThemedStyles, type Colors } from "../../../design/theme";
import {
  INSTALL_NOTE,
  REGISTRY_CAP_NOTE,
  REGISTRY_MAX,
  REGISTRY_NOTE,
  REGISTRY_ORDER_NOTE,
  REGISTRY_PAGE,
  annotateResults,
  atRegistryCeiling,
  browseEmptyNote,
  canAskForMore,
  installVerb,
  keepInVaultNote,
  type BrowseView,
} from "../../plugins/lifecycle";
import type { ConsolePlugin } from "../../plugins/plugins";

/**
 * How long typing rests before the registry is read again.
 *
 * `searchCommunityPlugins` re-fetches the whole community list on every call —
 * there is no server-side cache today — so a keystroke is not a cheap request
 * and search-as-you-type without this would be one registry download per
 * letter. Exported so the tests wait the same amount the component does rather
 * than a number that happens to be larger.
 */
export const REGISTRY_DEBOUNCE_MS = 350;

/**
 * Obsidian's community registry, browsed from inside Context.
 *
 * Closed until asked for, like the inventory scan beside it and for a related
 * reason: searching reaches a third party's list over the network, and a
 * settings pane that did that on open would be making a request on somebody's
 * behalf that they did not ask for.
 *
 * **Opening it is that ask.** Until 2026-09-14 opening the card sent nothing and
 * a person faced an empty box, a text field and a button before they could see
 * a single plugin — searchable, but not browsable, and no use at all to somebody
 * who does not already know the name of what they want. Pressing Browse now runs
 * an empty-query search, which is the head of the registry. The rule that moved
 * is "nothing on mount"; the rule that did not is "nothing without a deliberate
 * press", and the card is still closed when this pane opens.
 *
 * Typing filters, debounced — see `REGISTRY_DEBOUNCE_MS` for why that delay is
 * not decoration.
 *
 * Every result says what installing it would actually mean *for this bucket* —
 * a plugin already managed here says Update, one already in the vault says it
 * would add a second, managed copy. "Install" on something already installed is
 * the kind of button that gets pressed once and explained afterwards.
 */
export function PluginBrowse({
  view,
  installed,
  seed = "",
}: {
  view: BrowseView;
  installed: Array<Pick<ConsolePlugin, "id" | "source">>;
  /**
   * What the panel's own box currently holds.
   *
   * It does not search anything by itself — reaching the registry is a request
   * to a third party on somebody's behalf, and the rule above that nothing
   * happens without a deliberate press is unchanged. What it does is put the
   * words on that press, so a person who typed a name is offered a button that
   * looks for it rather than a generic "Browse" and a box to retype it into.
   */
  seed?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const actions = view.actions;
  /*
    The opening search already asked for "", so the first run of the debounce
    below would repeat it for nothing. This skips exactly that one, and is a ref
    rather than state because changing it must not draw the card again.
  */
  const typed = useRef(false);
  /*
    The search function through a ref, and the debounce below deliberately does
    NOT depend on it.

    `useLifecycle` builds its `actions` object inline on every render, so
    depending on it would make the timer restart on every render of this
    console — and this console has live subscriptions. Under a steady trickle of
    unrelated updates the 350ms would never elapse and a search would never be
    sent: a debounce that resets faster than it fires is indistinguishable from
    a search box that does nothing.
  */
  const searchRef = useRef(actions?.search);
  useEffect(() => {
    searchRef.current = actions?.search;
  });

  useEffect(() => {
    if (!open) return;
    if (!typed.current) return;
    const timer = setTimeout(() => {
      void searchRef.current?.(draft, REGISTRY_PAGE);
    }, REGISTRY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, open]);

  if (!actions) return null;

  if (!open) {
    return (
      <Card style={styles.card} testID="plugin-browse-closed">
        <Row style={styles.head}>
          <Grow>
            <Text variant="rowTitle">Add a plugin</Text>
            <Text variant="rowSub">{REGISTRY_NOTE}</Text>
          </Grow>
          <Button
            label={seed.trim() === "" ? "Browse" : `Search for "${seed.trim()}"`}
            testID="plugin-browse-open"
            onPress={() => {
              /*
                Reopening starts from the panel's box, or clean when it is
                empty. Without resetting `typed`, the previous session's text is
                still in `draft` and the debounce fires a search for it straight
                after this one — so the card would open on what was asked for
                and then replace it with an old filter nobody typed.
              */
              setDraft(seed);
              typed.current = false;
              setOpen(true);
              void actions.search(seed, REGISTRY_PAGE);
            }}
          />
        </Row>
      </Card>
    );
  }

  const rows = view.results === undefined ? null : annotateResults(view.results, installed);
  const emptyNote = browseEmptyNote(view.query, view.results, view.searching);
  const unsearched = view.query.trim() === "";

  return (
    <Card style={styles.card} testID="plugin-browse">
      <Row style={styles.head}>
        <Grow>
          <Text variant="rowTitle">Add a plugin</Text>
          <Text variant="rowSub">{REGISTRY_NOTE}</Text>
        </Grow>
        <Button label="Close" onPress={() => setOpen(false)} />
      </Row>

      <Row style={styles.search}>
        <Grow>
          <TextField
            label="Search"
            testID="plugin-browse-query"
            value={draft}
            onChangeText={(next) => {
              typed.current = true;
              setDraft(next);
            }}
            placeholder="Name, or what it does"
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={() => void actions.search(draft, REGISTRY_PAGE)}
            returnKeyType="search"
          />
        </Grow>
        <Button
          label={view.searching ? "Searching…" : "Search"}
          disabled={view.searching}
          onPress={() => void actions.search(draft, REGISTRY_PAGE)}
        />
      </Row>

      {view.failure ? (
        <FormError headline="That didn't work" next={view.failure} />
      ) : null}

      {emptyNote !== null ? (
        <Text variant="rowSub" style={styles.line} testID="plugin-browse-empty">
          {emptyNote}
        </Text>
      ) : null}

      {rows !== null && rows.length > 0 && unsearched ? (
        <Text variant="treeMeta" style={styles.order}>
          {REGISTRY_ORDER_NOTE}
        </Text>
      ) : null}

      {rows?.map((row) => (
        <Row key={row.id} divided style={styles.result}>
          <Grow>
            <Row style={styles.resultHead}>
              <Grow>
                <Text variant="rowTitle">{row.name}</Text>
              </Grow>
              {row.already === "managed" ? <Pill tone="ok">Installed here</Pill> : null}
              {row.already === "vault" ? <Pill tone="neutral">In your vault</Pill> : null}
            </Row>
            <Text variant="treeMeta" style={styles.meta}>
              {[row.id, row.author].filter(Boolean).join(" · ")}
            </Text>
            <Text variant="rowSub" style={styles.line}>
              {row.description}
            </Text>
          </Grow>
          {row.already === "vault" ? (
            <Text variant="hint" style={styles.keep} testID={`plugin-browse-keep-${row.id}`}>
              {keepInVaultNote(row.already)}
            </Text>
          ) : (
            <Button
              label={busyId === row.id ? "Working…" : installVerb(row.already)}
              disabled={busyId !== null}
              onPress={() => {
                setBusyId(row.id);
                void Promise.resolve(actions.install(row.id)).finally(() => setBusyId(null));
              }}
            />
          )}
        </Row>
      ))}

      {canAskForMore(view.results, view.limit) ? (
        <Button
          label={view.searching ? "Searching…" : "Show more"}
          disabled={view.searching}
          testID="plugin-browse-more"
          onPress={() => void actions.search(view.query, REGISTRY_MAX)}
        />
      ) : null}

      {atRegistryCeiling(view.results, view.limit) ? (
        <Text variant="rowSub" style={styles.line} testID="plugin-browse-ceiling">
          {REGISTRY_CAP_NOTE}
        </Text>
      ) : null}

      <Hint style={styles.hint}>
        <Text variant="hint">{INSTALL_NOTE}</Text>
      </Hint>
    </Card>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  card: { marginTop: 11, backgroundColor: colors.surface2 },
  head: { alignItems: "flex-start", gap: 12 },
  search: { gap: 8, marginTop: 12, alignItems: "center" },
  result: { alignItems: "flex-start", gap: 12 },
  resultHead: { alignItems: "flex-start", gap: 10 },
  meta: { marginTop: 2, color: colors.muted },
  line: { marginTop: 4 },
  order: { marginTop: 8, color: colors.muted },
  keep: { maxWidth: 260 },
  hint: { marginTop: 12 },
});
