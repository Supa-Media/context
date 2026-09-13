import { StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { Dot } from "../../../design/components/Dot";
import { Hint } from "../../../design/components/Field";
import { FormError } from "../../../design/components/Input";
import { Pill } from "../../../design/components/Pill";
import { Text } from "../../../design/components/Text";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { PluginBrowse } from "./PluginBrowse";
import { PluginGrantCard } from "./PluginGrantCard";
import { PluginManagedCard } from "./PluginManagedCard";
import { PluginRuntimeCard } from "./PluginRuntimeCard";
import type { RuntimeView } from "../../plugins/runtime";
import type { BrowseView } from "../../plugins/lifecycle";
import type { GrantsView } from "../../plugins/grants";
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
  sourceNote,
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
export function PluginsPanel({
  view,
  grants,
  browse,
  runtime,
}: {
  view: PluginsView;
  grants: GrantsView;
  browse: BrowseView;
  runtime: RuntimeView;
}) {
  const styles = useThemedStyles(makeStyles);

  if (view.state === "withheld") {
    return (
      <View testID="plugins-withheld">
        <Card>
          <Text variant="rowTitle">Only an owner can read this</Text>
          <Text variant="rowSub" style={styles.lead}>
            A plugin inventory names every plugin in this context&apos;s bucket and what each one
            would be able to reach, so it is the owner&apos;s to read. Ask an owner of this
            context if you need it.
          </Text>
        </Card>
      </View>
    );
  }

  if (view.state === "idle") {
    return (
      <View testID="plugins-idle">
        <Card>
          <Text variant="rowTitle">Read the plugins in this bucket</Text>
          <Text variant="rowSub" style={styles.lead}>
            Context opens each plugin&apos;s manifest and bundle in{" "}
            <Text variant="mono">.obsidian/plugins/</Text> and tells you what it would be able to
            do here. Nothing is executed, and nothing is written — the answer carries the date it
            was read, so you ask again after you update a plugin rather than on every visit.
          </Text>
          <View style={styles.action}>
            <Button
              label="Read my plugins"
              onPress={view.actions?.read}
              disabled={view.actions === undefined}
            />
          </View>
          <Hint style={styles.hint}>
            <Text variant="hint">
              Context never writes to <Text variant="mono">.obsidian/</Text> — it is the one part
              of your bucket that belongs to another program.
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
          {view.actions ? (
            <Button label="Read again" onPress={view.actions.read} />
          ) : null}
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

      <PluginBrowse view={browse} installed={inventory.plugins} />

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
            <PluginRow
              key={plugin.id}
              plugin={plugin}
              grants={grants}
              browse={browse}
              runtime={runtime}
            />
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
function PluginRow({
  plugin,
  grants,
  browse,
  runtime,
}: {
  plugin: ConsolePlugin;
  grants: GrantsView;
  browse: BrowseView;
  runtime: RuntimeView;
}) {
  const styles = useThemedStyles(makeStyles);
  const { tone, dashed } = verdictPill(plugin.verdict);
  const findings = namedEvidence(plugin);
  const read = readLabel(plugin);
  const route = routeOut(plugin.verdict);
  const pending = installPending(plugin.verdict);
  const from = sourceNote(plugin);

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

        {from ? (
          <Text variant="rowSub" style={styles.line}>
            {from}
          </Text>
        ) : null}

        <Text variant="hint" style={styles.close}>
          {route ?? pending}
        </Text>

        <PluginRuntimeCard plugin={plugin} view={runtime} grants={grants} />
        <PluginGrantCard plugin={plugin} view={grants} />
        <PluginManagedCard plugin={plugin} view={browse} />
      </Grow>
    </Row>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  lead: { marginTop: 6 },
  action: { marginTop: 13, alignItems: "flex-start" },
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
