import { StyleSheet, View } from "react-native";
import { Card, Grow, Row } from "../../../design/components/Card";
import { Dot } from "../../../design/components/Dot";
import { Hint } from "../../../design/components/Field";
import { FormError } from "../../../design/components/Input";
import { Pill } from "../../../design/components/Pill";
import { Text } from "../../../design/components/Text";
import { useThemedStyles, type Colors } from "../../../design/theme";
import {
  FLOOR_NOTE,
  SCOPE_NOTE,
  foundLabel,
  groupPlugins,
  installPending,
  namedEvidence,
  readLabel,
  routeOut,
  scanCoverage,
  verdictBlurb,
  verdictCounts,
  verdictHeading,
  verdictPill,
  VERDICT_ORDER,
  type ConsolePlugin,
  type PluginsView,
} from "../../plugins/plugins";

/**
 * The Obsidian plugins in this context's bucket, and what each one can do here.
 *
 * The panel renders `PluginsView` and decides nothing: every verdict, every
 * named finding and every host comes from the gateway's read of
 * `.obsidian/plugins/`, and the wording for all five states lives in
 * `../../plugins/plugins.ts` so it can be tested without mounting anything.
 *
 * Four states, four different screens, because they answer four different
 * questions — collapsing them is how "no plugins" ends up meaning "your
 * storage key expired". A successful read that found nothing is **not** one of
 * the four: it is `ready` with `found: 0`, and it gets its own words inside the
 * ready branch rather than a failure-shaped state of its own.
 */
export function PluginsPanel({ view }: { view: PluginsView }) {
  const styles = useThemedStyles(makeStyles);

  if (view.state === "unavailable") {
    return (
      <View testID="plugins-unavailable">
        <Card>
          <Text variant="rowTitle">Not in the console yet</Text>
          <Text variant="rowSub" style={styles.lead}>
            Context already reads the plugins in this context&apos;s bucket, and this console
            cannot ask for them yet. Any AI client you have connected can: ask it to list your
            Obsidian plugins, and it returns the same report — every plugin found, what each one
            would be able to do here, and the evidence behind it.
          </Text>
          <Hint style={styles.hint}>
            <Text variant="hint">
              Reading the inventory writes nothing at all. Context never writes to{" "}
              <Text variant="mono">.obsidian/</Text> — it is the one part of your bucket that
              belongs to another program.
            </Text>
          </Hint>
        </Card>
      </View>
    );
  }

  if (view.state === "loading") {
    return (
      <View testID="plugins-loading">
        <Card>
          <Text variant="rowTitle">Reading your plugins</Text>
          <Text variant="rowSub" style={styles.lead}>
            Each bundle is read, never executed. Results appear as they land, so one large plugin
            does not hold up the rest of the list.
          </Text>
        </Card>
      </View>
    );
  }

  if (view.state === "failed") {
    return (
      <View testID="plugins-failed">
        <FormError
          headline="Couldn't read .obsidian/plugins/ in this bucket"
          /*
            The provider's own reason, quoted rather than paraphrased, and then
            the sentence that bounds it. `report.js` makes the same move for
            the same purpose: this is a report about somebody's Obsidian setup,
            and a storage error here says nothing about their notes.
          */
          next={`${view.reason} — this is a report about your Obsidian setup, not about your notes; nothing else is affected.`}
        />
      </View>
    );
  }

  const { inventory } = view;

  if (inventory.found === 0) {
    return (
      <View testID="plugins-empty">
        <Card>
          <Text variant="rowTitle">No Obsidian plugins in this bucket</Text>
          <Text variant="rowSub" style={styles.lead}>
            Context looks in <Text variant="mono">.obsidian/plugins/</Text>, which is where
            Obsidian keeps them. If your vault syncs here and you expected plugins, check that
            your sync includes the <Text variant="mono">.obsidian</Text> folder — some sync tools
            exclude it by default.
          </Text>
        </Card>
      </View>
    );
  }

  const counts = verdictCounts(inventory.plugins);
  const coverage = scanCoverage(inventory);

  return (
    <View testID="plugins-ready">
      <Card>
        <Row style={styles.head}>
          <Grow>
            <Text variant="rowTitle">
              {`${foundLabel(inventory)} in this bucket`}
            </Text>
            <Text variant="rowSub">
              {[coverage, `checked ${inventory.checkedAt.slice(0, 10)}`, "nothing was executed"]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </Grow>
        </Row>
        <View style={styles.counts}>
          {VERDICT_ORDER.map((verdict) => {
            const { tone, dashed } = verdictPill(verdict);
            return (
              <Pill key={verdict} tone={tone} dashed={dashed}>
                {`${verdictHeading(verdict)} · ${counts[verdict]}`}
              </Pill>
            );
          })}
        </View>
      </Card>

      {groupPlugins(inventory.plugins).map((group) => (
        <Card key={group.verdict} style={styles.group}>
          <Row style={styles.head}>
            <Grow>
              <Text variant="listGroup">{verdictHeading(group.verdict)}</Text>
              <Text variant="rowSub">{verdictBlurb(group.verdict)}</Text>
            </Grow>
            <Pill tone="neutral">{`${group.plugins.length}`}</Pill>
          </Row>
          {group.plugins.map((plugin) => (
            <PluginRow key={plugin.id} plugin={plugin} />
          ))}
        </Card>
      ))}

      <Hint style={styles.hint}>
        <Text variant="hint">{SCOPE_NOTE}</Text>
      </Hint>
      <Text variant="foot" style={styles.floor}>
        {FLOOR_NOTE}
      </Text>
    </View>
  );
}

/**
 * One plugin.
 *
 * The closing line is exactly one of two things and never both: the route that
 * still works (`routeOut`), or — for the two verdicts that will one day offer
 * an install — the note saying that running plugins here is not built yet
 * (`installPending`). Both come from the pure module, so the rule that a row
 * never ends on a refusal is a property a test can hold rather than a habit
 * this component happens to have.
 */
function PluginRow({ plugin }: { plugin: ConsolePlugin }) {
  const styles = useThemedStyles(makeStyles);
  const { tone, dashed } = verdictPill(plugin.verdict);
  const findings = namedEvidence(plugin);
  const read = readLabel(plugin);
  const route = routeOut(plugin.verdict);
  const pending = installPending(plugin.verdict);

  return (
    <Row divided style={styles.pluginRow}>
      <Grow>
        <Row style={styles.titleRow}>
          <Grow>
            <Text variant="rowTitle">{plugin.name}</Text>
          </Grow>
          <Pill tone={tone} dashed={dashed} leading={tone === "ok" ? <Dot tone="ok" /> : undefined}>
            {verdictHeading(plugin.verdict)}
          </Pill>
        </Row>

        <Text variant="treeMeta" style={styles.meta}>
          {[plugin.id, plugin.version ? `v${plugin.version}` : null, plugin.author]
            .filter(Boolean)
            .join(" · ")}
        </Text>

        {plugin.manifestError ? (
          <Text variant="rowSub" style={styles.line}>
            {plugin.manifestError}
          </Text>
        ) : null}

        {findings.map((finding) => (
          <Text key={finding.id} variant="rowSub" style={styles.line}>
            {`${finding.id} — ${finding.reason}`}
          </Text>
        ))}

        {plugin.hosts && plugin.hosts.length > 0 ? (
          <Text variant="rowSub" style={styles.line}>
            {`Hosts it names: ${plugin.hosts.join(", ")}`}
          </Text>
        ) : null}

        {plugin.limitations.map((limitation, index) => (
          <Text key={`${plugin.id}-limitation-${index}`} variant="rowSub" style={styles.line}>
            {limitation}
          </Text>
        ))}

        {plugin.notes.map((note, index) => (
          <Text key={`${plugin.id}-note-${index}`} variant="rowSub" style={styles.line}>
            {note}
          </Text>
        ))}

        {read ? (
          <Text variant="rowSub" style={styles.line}>
            {read}
          </Text>
        ) : null}

        <Text variant="hint" style={styles.close}>
          {route ?? pending}
        </Text>
      </Grow>
    </Row>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  lead: { marginTop: 6 },
  hint: { marginTop: 12 },
  group: { marginTop: 11 },
  head: { alignItems: "flex-start", gap: 12 },
  counts: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 12 },
  pluginRow: { alignItems: "flex-start" },
  titleRow: { alignItems: "flex-start", gap: 12 },
  meta: { marginTop: 2, color: colors.muted },
  line: { marginTop: 4 },
  close: { marginTop: 7 },
  floor: { marginTop: 14 },
});
