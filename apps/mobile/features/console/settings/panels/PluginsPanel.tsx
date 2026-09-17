import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { Dot } from "../../../design/components/Dot";
import { Hint } from "../../../design/components/Field";
import { FormError, TextField } from "../../../design/components/Input";
import { Pill } from "../../../design/components/Pill";
import { Switch } from "../../../design/components/Switch";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { ContextPluginsCard } from "./ContextPluginsCard";
import { PluginDetail } from "./PluginDetail";
import { PluginBrowse } from "./PluginBrowse";
import type { RuntimeView } from "../../plugins/runtime";
import type { BrowseView } from "../../plugins/lifecycle";
import { approvalOffer, standingFor, type GrantsView } from "../../plugins/grants";
import { runtimeFor } from "../../plugins/runtime";
import { pluginRowControl, pluginRowSummary } from "../../plugins/pluginRow";
import { usePluginPower } from "../../plugins/usePluginPower";
import {
  INSTALLED_NOTE,
  installLabel,
  installedRows,
  installsFailureNote,
  type ManagedInstallsView,
} from "../../plugins/managedInstalls";
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
 * Every plugin this context has, from either place, behind one search box.
 *
 * ## Why this is one panel and not two
 *
 * Context ships plugins of its own — forms, images, meetings, chat days — and a
 * customer's bucket may be a vault full of somebody else's.
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
 * bucket" — in a context that was running four plugins the whole time. Nothing
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
  installs,
  grants,
  browse,
  runtime,
}: {
  view: PluginsView;
  contextPlugins: ContextPluginsView;
  /**
   * What Context has installed here, read on arrival rather than on a press.
   *
   * Separate from `view` because it is a different question with a different
   * price — see `managedInstalls.ts`. It is what lets this panel answer "what
   * have I got" before anybody has scanned anything, which is the state every
   * first visit is in and the state in which this screen used to say nothing.
   */
  installs: ManagedInstallsView;
  grants: GrantsView;
  browse: BrowseView;
  runtime: RuntimeView;
}) {
  const styles = useThemedStyles(makeStyles);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PluginFilter>("all");

  return (
    <View testID="plugins-panel">
      {/*
        A toolbar, where this was a full-width card with a labelled field and
        three chips under it — the first thing on the pane, above every plugin,
        at a moment when nobody has typed anything. A box around a search box
        is a box too many, and it pushed the only content on the screen below
        the fold on a laptop.

        The field keeps its accessible label; what it loses is the printed one,
        which said "Search plugins" directly above a placeholder reading "Name,
        what it does, or a tool name" on a pane titled Plugins.
      */}
      <Row style={styles.toolbar} testID="plugins-toolbar">
        <Grow>
          <TextField
            label="Search plugins"
            labelHidden
            testID="plugins-query"
            value={query}
            onChangeText={setQuery}
            placeholder="Name, what it does, or a tool name"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Grow>
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
            installs={installs}
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
 * The vault half: the registry you can add from, and what `.obsidian/plugins/`
 * already holds.
 *
 * ## Why the registry card is here rather than inside the scan's states
 *
 * It used to be inside them, in two of the six, and that shipped a feature
 * nobody could reach. `VaultInventory` returns early for `withheld`, `idle`,
 * `loading` and `failed`, and **`idle` is where a first visit lands** — nobody
 * has pressed "Read my plugins" yet. So the only way to the community registry
 * was to have already run a successful scan of your own bucket, and everybody
 * else saw a panel that searched the built-ins and nothing else. Which is
 * exactly how it was reported from the shipped app.
 *
 * **Browsing the registry is not a read of `.obsidian/`.** It reaches a third
 * party's list; it does not touch the customer's bucket at all. So it has no
 * business behind the outcome of a bucket read, any more than the Context
 * built-ins did — the panel's own header comment made that argument one block
 * up and this is the same argument, finished.
 *
 * One call site rather than six, and that is the point rather than tidiness: a
 * seventh state added to `VaultInventory` cannot take the registry down with
 * it, because the registry is not inside it. The same derive-rather-than-repeat
 * fix `useRuntime` uses for registrations, where a self-review found two of
 * five call sites already missed.
 *
 * `PluginBrowse` decides for itself whether to draw anything: it renders
 * nothing without `actions`, and `useLifecycle` gives those to owners only. So
 * `withheld` needs no special case — a non-owner is offered nothing because
 * they could not install it, which is a better reason than the state they are
 * looking at.
 */
function VaultPlugins({
  view,
  installs,
  grants,
  browse,
  runtime,
  query,
}: {
  view: PluginsView;
  installs: ManagedInstallsView;
  grants: GrantsView;
  browse: BrowseView;
  runtime: RuntimeView;
  query: string;
}) {
  return (
    <>
      <PluginBrowse
        view={browse}
        /*
          What is already in the bucket, from whichever read has an answer.

          The scan knows about both places and is preferred where it has run.
          Where it has not — every first visit — the pointer read still knows
          what Context installed, and that is the half this list has to get
          right: a registry row for a plugin already installed here said
          "Install" and installed it again. It cannot speak for `.obsidian/`,
          and does not: an unscanned vault plugin still reads as new, which is
          the honest shape of not having looked.
        */
        installed={
          view.state === "ready" ? view.inventory.plugins : installedRows(installs)
        }
        seed={query}
      />
      {/*
        Drawn only while the scan has nothing to show. Once it is ready every
        install is in the list below with a verdict beside it, and this card
        would be the same names twice.
      */}
      {view.state === "ready" ? null : <InstalledPlugins view={installs} query={query} />}
      <VaultInventory
        view={view}
        grants={grants}
        /*
          Still needed below, and for a different thing: a row's uninstall and
          recover controls are lifecycle actions on a plugin that is already
          here. Only the registry *search* left this component.
        */
        browse={browse}
        runtime={runtime}
        query={query}
      />
    </>
  );
}

/**
 * What Context has installed here, named before anything is scanned.
 *
 * ## Why this card exists
 *
 * Everything below it waits for a press, for a good reason: a scan opens every
 * bundle in somebody's vault. The cost of that rule was that the screen which
 * installs plugins could not name one it had installed. A person came back the
 * next day, saw "Read the plugins in this bucket" and an empty panel, and drew
 * the obvious conclusion — the install did not stick. It had; nothing read it
 * back. Some of them reasonably concluded Context only ever looks in
 * `.obsidian/`, which the wording all around this did nothing to dispel.
 *
 * So this says what is installed and, deliberately, nothing about whether any
 * of it runs. A verdict is the scan's to give, and one printed from a pointer
 * would be a claim about third-party code nobody checked.
 */
function InstalledPlugins({ view, query }: { view: ManagedInstallsView; query: string }) {
  const styles = useThemedStyles(makeStyles);

  // Nobody who cannot install needs to be told what is installed, and while the
  // first read is out there is nothing true to say yet.
  if (view.state === "withheld" || view.state === "loading") return null;

  if (view.state === "failed") {
    return (
      <Card style={styles.group} testID="plugins-installed-failed">
        <Text variant="rowTitle">Couldn&apos;t read what Context installed</Text>
        <Text variant="rowSub" style={styles.lead}>
          {installsFailureNote(view.reason)}
        </Text>
      </Card>
    );
  }

  // A bucket with nothing installed says so below, in the state that also
  // offers the scan. Two empty cards for one empty answer is one too many.
  if (view.installs.length === 0) return null;

  const shown = view.installs.filter((install) =>
    matchesVaultQuery({ id: install.id, name: install.id }, query),
  );

  return (
    <Card style={styles.group} testID="plugins-installed">
      <Row style={styles.head}>
        <Grow>
          <Text variant="rowTitle">
            {`${view.installs.length} installed by Context`}
          </Text>
          <Text variant="rowSub">{INSTALLED_NOTE}</Text>
        </Grow>
      </Row>
      {shown.length === 0 ? (
        <Text variant="rowSub" style={styles.lead} testID="plugins-installed-no-match">
          {`None of them match "${query.trim()}".`}
        </Text>
      ) : (
        shown.map((install) => (
          <Row key={install.id} style={styles.installRow}>
            <Grow>
              <Text variant="rowTitle">{installLabel(install)}</Text>
            </Grow>
            {install.version === null ? (
              /*
                A pointer with no release is an install part-way through, or one
                whose pointer will not parse. Both are worth seeing and neither
                is a version — `recoverPluginLifecycle` is the way out and lives
                on the row below once a scan has run.
              */
              <Pill tone="warn" dashed>
                Unfinished
              </Pill>
            ) : null}
          </Row>
        ))
      )}
    </Card>
  );
}

/**
 * What `.obsidian/plugins/` holds and what each one would do here.
 *
 * Unchanged in what it says — every verdict, every named finding and every host
 * still comes from the gateway's read, and the wording for all five states still
 * lives in `../../plugins/plugins.ts`. What changed is that it is a section of a
 * panel rather than the panel, so its refusals and its empty state no longer
 * take the built-ins down with them — nor, since the registry card moved out
 * above it, the one control that adds a plugin.
 */
function VaultInventory({
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
  /*
    Which plugin is open, as an id rather than the object.

    An id survives a re-scan: these rows are rebuilt whenever the vault is read
    again, and a held object would go on describing the bundle as it was before.
    It is looked up below, so a plugin that is genuinely gone falls back to the
    list rather than leaving a detail page for something that is not there.

    Here rather than in `PluginsPanel` because the panel never sees a plugin —
    it sees five states, only one of which has a list to open anything from.
  */
  const [detail, setDetail] = useState<string | null>(null);

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
          <Text variant="rowTitle">Check what these plugins can do here</Text>
          <Text variant="rowSub" style={styles.lead}>
            Context opens each plugin&apos;s manifest and bundle — the ones it installed under{" "}
            <Text variant="mono">.context/plugins/</Text> and any your vault syncs into{" "}
            <Text variant="mono">.obsidian/plugins/</Text> — and tells you what each would be able
            to do here. Nothing is executed, and nothing is written; the answer carries the date it
            was read, so you ask again after an update rather than on every visit.
          </Text>
          <View style={styles.action}>
            <Button
              label="Check my plugins"
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
          headline="Couldn't read the plugins in this bucket"
          /*
            The provider's own reason, quoted rather than paraphrased, and then
            the sentence that bounds it. `report.js` makes the same move for
            the same purpose: this is a report about somebody's Obsidian setup,
            and a storage error here says nothing about their notes.
          */
          next={`${view.reason} — this is a report about your plugins, not about your notes; nothing else is affected.`}
        />
      </View>
    );
  }

  const { inventory } = view;

  if (inventory.found === 0) {
    return (
      <View testID="plugins-empty">
        <Card>
          <Text variant="rowTitle">No plugins in this bucket</Text>
          <Text variant="rowSub" style={styles.lead}>
            Context looked in both places it keeps them:{" "}
            <Text variant="mono">.context/plugins/</Text>, where it installs, and{" "}
            <Text variant="mono">.obsidian/plugins/</Text>, where Obsidian does. If your vault
            syncs here and you expected plugins, check that your sync includes the{" "}
            <Text variant="mono">.obsidian</Text> folder — some sync tools exclude it by default.
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

  /*
    One plugin, at length, instead of the list — the list/section shape the
    settings overlay already uses one level up, for the same reason: a phone
    shows one thing at a time, and a detail drawn *under* a row is a wall with
    a fold in it rather than a screen.

    Looked up in the full inventory rather than in `shown`, so a search typed
    after opening a plugin does not close the screen underneath the reader. A
    plugin that is genuinely gone — removed, or a re-scan that no longer finds
    it — falls through to the list, which is the honest answer rather than a
    page about something that is not there.
  */
  const opened = detail === null
    ? null
    : inventory.plugins.find((plugin) => plugin.id === detail) ?? null;

  if (opened !== null) {
    return (
      <View testID="plugins-detail">
        <PluginDetail
          plugin={opened}
          grants={grants}
          browse={browse}
          runtime={runtime}
          onBack={() => setDetail(null)}
        />
      </View>
    );
  }

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
              runtime={runtime}
              onOpen={() => setDetail(plugin.id)}
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
 * One plugin, as a row: is it on, and what turns it on.
 *
 * This used to be the whole story — the blurb, the named findings, the hosts,
 * a fold of limitations, the notes, what was read, where it came from, the
 * route out, and three cards of controls, per plugin, down a phone screen.
 * Reported as "soooo much jargon text; people just want to enable or disable a
 * plugin". All of it still exists, in `PluginDetail`, one press away.
 *
 * What is left is the answer to the question a list is for. `pluginRowSummary`
 * decides both halves — see it for why a running plugin outranks the scan, why
 * a plugin Context cannot run gets no pill at all, and why some presses act and
 * others open a door.
 */
function PluginRow({
  plugin,
  grants,
  runtime,
  onOpen,
}: {
  plugin: ConsolePlugin;
  grants: GrantsView;
  runtime: RuntimeView;
  onOpen: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const power = usePluginPower(plugin, runtime);
  /*
    `undefined` while either list is still loading, which `pluginRowSummary`
    reads as "do not guess" — a row that assumed "never approved" would put an
    Enable on a plugin that is already running.
  */
  const standing =
    grants.grants === undefined ? null : standingFor(plugin, grants.grants);
  const state =
    runtime.states === undefined ? null : runtimeFor(plugin, runtime.states);
  const { status, primary } = pluginRowSummary({
    plugin,
    standing,
    state,
    canPower: runtime.actions !== undefined,
    canGrant: grants.actions !== undefined,
    approvable: approvalOffer(plugin, grants.egress).kind === "available",
  });

  const control = pluginRowControl(primary);

  return (
    <Row divided style={styles.pluginRow}>
      <Grow testID={`plugin-row-${plugin.id}`}>
        <Row style={styles.titleRow}>
          <Grow>
            <Text variant="rowTitle">{plugin.name}</Text>
            <Text variant="treeMeta" style={styles.meta}>
              {[plugin.id, plugin.version ? `v${plugin.version}` : null]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </Grow>
          {status === null ? null : (
            <Pill tone={status.tone} leading={status.live ? <Dot tone="ok" /> : undefined}>
              {status.label}
            </Pill>
          )}
          {/*
            The switch rides at the trailing edge of the row's first line,
            beside the pill rather than under it: "is it on" is the question the
            list exists to answer, and the answer belongs where the eye already
            is. The pill says what it is doing; this says what you set.
          */}
          {control?.kind === "switch" ? (
            <Switch
              value={control.on}
              /*
                The plugin's name, and the state rides on `checked`. While a
                press is in flight the label gains a word rather than losing
                one — the control is disabled, and "dimmed" on its own does not
                say whether anything is happening.
              */
              label={power.busy ? `${plugin.name}, working…` : plugin.name}
              disabled={power.busy}
              onValueChange={() => void power.act(control.action)}
              testID={`plugin-switch-${plugin.id}`}
            />
          ) : null}
        </Row>

        <Row style={styles.controls}>
          {control?.kind === "door" ? (
            <Button
              label={control.label}
              variant="mini"
              onPress={onOpen}
              testID={`plugin-primary-${plugin.id}`}
            />
          ) : null}
          {/*
            Always here, whatever the row decided, because it is the way to
            everything the row stopped saying. A plugin Context cannot run has
            no press of its own and this is its only control — which is exactly
            the row that most needs one, since the reason is what the reader
            came for.
          */}
          <Button
            label="Details"
            variant="mini"
            onPress={onOpen}
            testID={`plugin-details-${plugin.id}`}
          />
        </Row>

        {power.failure ? <Text variant="error">{power.failure}</Text> : null}
      </Grow>
    </Row>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  lead: { marginTop: 6 },
  installRow: { alignItems: "center", gap: space.x2, paddingVertical: space.x1 },
  // Wrapping rather than a fixed row: a field and three chips and their gaps
  // exceed a phone's width, and wrapping is what keeps this a settings row
  // instead of a horizontal scroller.
  toolbar: { flexWrap: "wrap", alignItems: "center", gap: space.x2 },
  filterActive: { backgroundColor: colors.accentDim, borderColor: colors.accent },
  check: { color: colors.accentText },
  action: { marginTop: 13, alignItems: "flex-start" },
  hint: { marginTop: 12 },
  group: { marginTop: 11 },
  head: { alignItems: "flex-start", gap: 12 },
  counts: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 12 },
  pluginRow: { alignItems: "flex-start" },
  // Wrapping, because two labels and their gap can exceed a narrow phone and a
  // control that has run off the edge is a control that is not there.
  controls: { flexWrap: "wrap", gap: space.x2, marginTop: 9 },
  titleRow: { alignItems: "flex-start", gap: 12 },
  meta: { marginTop: 2, color: colors.muted },
  line: { marginTop: 4 },
  close: { marginTop: 7 },
  floor: { marginTop: 14 },
});
