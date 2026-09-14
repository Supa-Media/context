import { StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { Dot } from "../../../design/components/Dot";
import { FormError } from "../../../design/components/Input";
import { Hint } from "../../../design/components/Field";
import { Pill } from "../../../design/components/Pill";
import { Text } from "../../../design/components/Text";
import { useThemedStyles, type Colors } from "../../../design/theme";
import {
  CONTEXT_LEAD,
  contextCountLabel,
  contextEmptyNote,
  contextMetaLine,
  contextToolLine,
  filterContextPlugins,
  manageBlocker,
  settingsErrorNote,
  switchConsequence,
  switchLabel,
  type ContextPlugin,
  type ContextPluginsView,
} from "../../plugins/contextPlugins";

/**
 * The plugins that ship with Context, and their switches.
 *
 * ## It is drawn in every state the vault half can be in
 *
 * This is the whole reason the panel was restructured rather than extended.
 * Every early return in `PluginsPanel` used to end the screen — a member saw
 * "only an owner can read this", a bucket with no `.obsidian/` saw "no plugins
 * in this bucket" — and in each of those a context was running five plugins
 * that had no row anywhere. Nothing here depends on reading `.obsidian/`, so
 * nothing here is behind that read.
 *
 * ## Two marks per row, never colour alone
 *
 * On/off is a `Pill` with a `Dot` and a word, the same "mark it more than one
 * way" rule `AppearancePanel`'s checkmark follows. There is no `Switch`
 * primitive in this design system and this is not the screen to invent one on:
 * the control is an ordinary button whose label says what pressing it does, so
 * it reads correctly to a screen reader without an accessibility label
 * restating the state.
 *
 * ## The consequence is above the button, always
 *
 * `switchConsequence` prints for both states. A switch whose cost only appears
 * after it has been pressed is a switch somebody presses to find out, and this
 * one changes what every connected client of every member can do.
 */
export function ContextPluginsCard({
  view,
  query,
}: {
  view: ContextPluginsView;
  query: string;
}) {
  const styles = useThemedStyles(makeStyles);

  if (view.state === "loading") {
    return (
      <Card testID="context-plugins-loading">
        <Text variant="rowTitle">Reading this context&apos;s plugins</Text>
        <Text variant="rowSub" style={styles.lead}>
          One small file beside your notes records which of them you have turned off.
        </Text>
      </Card>
    );
  }

  if (view.state === "failed") {
    return (
      <View testID="context-plugins-failed">
        <FormError
          headline="Couldn't read this context's plugins"
          next={`${view.reason} — your notes are unaffected, and nothing was changed.`}
        />
      </View>
    );
  }

  const shown = filterContextPlugins(view.plugins, query);
  const blocker = manageBlocker(view.canManage);
  const settings = settingsErrorNote(view.settingsError);

  return (
    <Card testID="context-plugins" style={styles.card}>
      <Row style={styles.head}>
        <Grow>
          <Text variant="listGroup">From Context</Text>
          <Text variant="rowSub">{CONTEXT_LEAD}</Text>
        </Grow>
        <Pill tone="neutral">{contextCountLabel(view.plugins)}</Pill>
      </Row>

      {settings ? (
        <View style={styles.notice} testID="context-plugins-settings-error">
          <FormError headline="These are showing their defaults" next={settings} />
        </View>
      ) : null}

      {shown.length === 0 ? (
        <Text variant="rowSub" style={styles.empty} testID="context-plugins-empty">
          {contextEmptyNote(query)}
        </Text>
      ) : (
        shown.map((plugin) => (
          <ContextPluginRow
            key={plugin.id}
            plugin={plugin}
            canManage={view.canManage}
            busy={view.pending === plugin.id}
            onToggle={
              view.actions
                ? () => view.actions?.setEnabled(plugin.id, !plugin.enabled)
                : undefined
            }
          />
        ))
      )}

      {blocker ? (
        <Hint style={styles.hint}>
          <Text variant="hint">{blocker}</Text>
        </Hint>
      ) : null}
    </Card>
  );
}

function ContextPluginRow({
  plugin,
  canManage,
  busy,
  onToggle,
}: {
  plugin: ContextPlugin;
  canManage: boolean;
  busy: boolean;
  onToggle?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const tools = contextToolLine(plugin);

  return (
    <View testID={`context-plugin-${plugin.id}`}>
      <Row divided style={styles.pluginRow}>
        <Grow>
          <Row style={styles.titleRow}>
            <Grow>
              <Text variant="rowTitle">{plugin.name}</Text>
            </Grow>
            <Pill
              tone={plugin.enabled ? "ok" : "neutral"}
              dashed={!plugin.enabled}
              leading={plugin.enabled ? <Dot tone="ok" /> : undefined}
            >
              {plugin.enabled ? "On" : "Off"}
            </Pill>
          </Row>

          <Text variant="treeMeta" style={styles.meta}>
            {contextMetaLine(plugin)}
          </Text>

          <Text variant="rowSub" style={styles.line}>
            {plugin.description}
          </Text>

          {tools ? (
            <Text variant="rowSub" style={styles.line}>
              {tools}
            </Text>
          ) : null}

          <Text variant="hint" style={styles.close}>
            {switchConsequence(plugin)}
          </Text>

          {canManage ? (
            <View style={styles.action}>
              <Button
                label={busy ? "Saving\u2026" : switchLabel(plugin)}
                variant={plugin.enabled ? "danger" : "mini"}
                onPress={onToggle}
                disabled={onToggle === undefined}
                testID={`context-plugin-toggle-${plugin.id}`}
              />
            </View>
          ) : null}
        </Grow>
      </Row>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: { marginTop: 11 },
    lead: { marginTop: 6 },
    head: { alignItems: "flex-start", gap: 12 },
    notice: { marginTop: 11 },
    empty: { marginTop: 11 },
    pluginRow: { alignItems: "flex-start" },
    titleRow: { alignItems: "flex-start", gap: 12 },
    meta: { marginTop: 2, color: colors.muted },
    line: { marginTop: 4 },
    close: { marginTop: 7 },
    action: { marginTop: 11, alignItems: "flex-start" },
    hint: { marginTop: 12 },
  });
