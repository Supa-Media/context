import { useState } from "react";
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
  REGISTRY_NOTE,
  annotateResults,
  installVerb,
  type BrowseView,
} from "../../plugins/lifecycle";
import type { ConsolePlugin } from "../../plugins/plugins";

/**
 * Obsidian's community registry, searched from inside Context.
 *
 * Closed until asked for, like the inventory scan beside it and for a related
 * reason: searching reaches a third party's list over the network, and a
 * settings pane that did that on open would be making a request on somebody's
 * behalf that they did not ask for.
 *
 * Every result says what installing it would actually mean *for this bucket* —
 * a plugin already managed here says Update, one already in the vault says it
 * would add a second, managed copy. "Install" on something already installed is
 * the kind of button that gets pressed once and explained afterwards.
 */
export function PluginBrowse({
  view,
  installed,
}: {
  view: BrowseView;
  installed: ConsolePlugin[];
}) {
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const actions = view.actions;

  if (!actions) return null;

  if (!open) {
    return (
      <Card style={styles.card} testID="plugin-browse-closed">
        <Row style={styles.head}>
          <Grow>
            <Text variant="rowTitle">Add a plugin</Text>
            <Text variant="rowSub">{REGISTRY_NOTE}</Text>
          </Grow>
          <Button label="Browse" onPress={() => setOpen(true)} />
        </Row>
      </Card>
    );
  }

  const rows = view.results === undefined ? null : annotateResults(view.results, installed);

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
            onChangeText={setDraft}
            placeholder="Name, or what it does"
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={() => void actions.search(draft)}
            returnKeyType="search"
          />
        </Grow>
        <Button
          label={view.searching ? "Searching…" : "Search"}
          disabled={view.searching}
          onPress={() => void actions.search(draft)}
        />
      </Row>

      {view.failure ? (
        <FormError headline="That didn't work" next={view.failure} />
      ) : null}

      {rows !== null && rows.length === 0 && !view.searching ? (
        <Text variant="rowSub" style={styles.line}>
          {view.query.trim() === ""
            ? "Search for a plugin by name, or by what it does."
            : `Nothing in the community list matches “${view.query.trim()}”.`}
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
          <Button
            label={busyId === row.id ? "Working…" : installVerb(row.already)}
            disabled={busyId !== null}
            onPress={() => {
              setBusyId(row.id);
              void Promise.resolve(actions.install(row.id)).finally(() => setBusyId(null));
            }}
          />
        </Row>
      ))}

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
  hint: { marginTop: 12 },
});
