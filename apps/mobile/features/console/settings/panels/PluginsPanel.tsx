import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { Dot } from "../../../design/components/Dot";
import { Hint } from "../../../design/components/Field";
import { FormError, TextField } from "../../../design/components/Input";
import { Pill } from "../../../design/components/Pill";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { ContextPluginsCard } from "./ContextPluginsCard";
import { PluginBrowse } from "./PluginBrowse";
import { PluginGrantCard } from "./PluginGrantCard";
import { PluginManagedCard } from "./PluginManagedCard";
import { PluginRuntimeCard } from "./PluginRuntimeCard";
import type { RuntimeView } from "../../plugins/runtime";
import type { BrowseView } from "../../plugins/lifecycle";
import type { GrantsView } from "../../plugins/grants";
import {
  PLUGIN_FILTERS,
  matchesVaultQuery,
  showsContext,
  showsObsidian,
  type ContextPluginsView,
  type PluginFilter,
} from "../../plugins/contextPlugins";
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
 * Every plugin this context has, from either place, behind one search box.
 *
 * ## Why this is one panel and not two
 *
 * Context ships plugins of its own — forms, image uploads, meetings, chat days,
 * drawings — and a customer's bucket may be a vault full of somebody else's.
 * Those were two different screens and two vocabularies for one question: a
 * person looking for "the forms thing" and a person looking for Templater are
 * both asking what this context can do. So: one box, one filter, two blocks
 * drawn from the same card vocabulary, the Context half first because it is the
 * half that is definitely working.
 *
 * ## The Context block is outside every one of the vault block's states
 *
 * This is the structural change and it is load-bearing rather than tidy. Each
 * of the five states below used to *end the panel* — a member got "only an
 * owner can read this", a bucket with no `.obsidian/` got "no plugins in this
 * bucket" — in a context that was running five plugins the whole time. Nothing
 * about the built-ins depends on reading somebody's plugin directory, so
 * nothing about them sits behind that read.
 *
 * ## The box filters what is here; the registry is still a deliberate press
 *
 * Typing narrows the two local lists and sends nothing anywhere. Reaching the
 * community registry is a request to a third party on somebody's behalf, and
 * `PluginBrowse`'s rule — nothing without a deliberate press — is unchanged:
 * what the box does is put the words on that press, so "Browse" becomes
 * "Search the registry for …" and opens already looking for it.
 *
 * Four states, four different screens for the vault half, because they answer
 * four different questions — collapsing them is how "no plugins" ends up
 * meaning "your storage key expired". A successful read that found nothing is
 * **not** one of the four: it is `ready` with `found: 0`, and it gets its own
 * words inside the ready branch rather than a failure-shaped state of its own.
 */
export function PluginsPanel({
  view,
  contextPlugins,
  grants,
  browse,
  runtime,
}: {
  view: PluginsView;
  contextPlugins: ContextPluginsView;
  grants: GrantsView;
  browse: BrowseView;
  runtime: RuntimeView;
}) {
  const styles = useThemedStyles(makeStyles);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PluginFilter>("all");

  return (
    <View testID="plugins-panel">
      <Card>
        <TextField
          label="Search plugins"
          testID="plugins-query"
          value={query}
          onChangeText={setQuery}
          placeholder="Name, what it does, or a tool name"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Row style={styles.filters}>
          {PLUGIN_FILTERS.map((entry) => (
            <Button
              key={entry.value}
              label={entry.label}
              variant="mini"
              style={filter === entry.value ? styles.filterActive : undefined}
              // A leading glyph as well as the tint: the accent is the same hue
              // links use, which is not a safe distinguisher on its own — the
              // rule `AppearancePanel`'s own chips follow.
              leading={
                filter === entry.value ? <Text style={styles.check}>{"\u2713 "}</Text> : undefined
              }
              accessibilityLabel={
                filter === entry.value ? `${entry.label}, showing` : `Show ${entry.label}`
              }
              onPress={() => setFilter(entry.value)}
              testID={`plugins-filter-${entry.value}`}
            />
          ))}
        </Row>
      </Card>

      {showsContext(filter) ? <ContextPluginsCard view={contextPlugins} query={query} /> : null}
      {showsObsidian(filter) ? (
        /*
          Wrapped so the vault half is addressable on its own. The panel's own
          chrome is three chips and a box, and a check that counts "the controls
          on this screen" has to be able to mean the section it is about — see
          `pluginsPanel.test.ts`, where three assertions about a scan offering
          nothing to press would otherwise be counting the filter.
        */
        <View testID="plugins-vault">
          <VaultPlugins
            view={view}
            grants={grants}
            browse={browse}
            runtime={runtime}
            query={query}
          />
        </View>
      ) : null}
    </View>
  );
}

/**
 * The vault half: what `.obsidian/plugins/` holds and what each one would do here.
 *
 * Unchanged in what it says — every verdict, every named finding and every host
 * still comes from the gateway's read, and the wording for all five states still
 * lives in `../../plugins/plugins.ts`. What changed is that it is a section of a
 * panel rather than the panel, so its refusals and its empty state no longer
 * take the built-ins down with them.
 */
function VaultPlugins({
  view,
  grants,
  browse,
  runtime,
  query,
}: {
  view: PluginsView;
  grants: GrantsView;
  browse: BrowseView;
  runtime: RuntimeView;
  query: string;
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
  /*
    The box narrows the rows; the head keeps describing the bucket.

    Deliberately not recounted against the filtered set. `foundLabel` and the
    verdict chips are a statement about what is installed — the one place this
    panel has ever been careful to report a floor honestly — and making them
    follow a search box would turn "3 won't run here" into a number that means
    "3 of the ones matching what you typed", which is the note-count trap in a
    new costume.
  */
  const shown = inventory.plugins.filter((plugin) => matchesVaultQuery(plugin, query));
  const filtered = shown.length !== inventory.plugins.length;

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

      <PluginBrowse view={browse} installed={inventory.plugins} seed={query} />

      {filtered && shown.length === 0 ? (
        <Card style={styles.group} testID="plugins-no-match">
          <Text variant="rowSub">
            {`Nothing in this vault matches "${query.trim()}". The registry search above looks past it.`}
          </Text>
        </Card>
      ) : null}

      {groupPlugins(shown).map((group) => (
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
  // Wrapping rather than a fixed row: three chips and their gaps can exceed a
  // phone's width, and wrapping is what keeps this a settings row instead of a
  // horizontal scroller.
  filters: { flexWrap: "wrap", gap: space.x2, marginTop: 12 },
  filterActive: { backgroundColor: colors.accentDim, borderColor: colors.accent },
  check: { color: colors.accentText },
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
