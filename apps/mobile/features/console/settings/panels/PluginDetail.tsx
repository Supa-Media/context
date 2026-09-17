import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Card } from "../../../design/components/Card";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { PluginGrantCard } from "./PluginGrantCard";
import { PluginManagedCard } from "./PluginManagedCard";
import { PluginRuntimeCard } from "./PluginRuntimeCard";
import type { RuntimeView } from "../../plugins/runtime";
import type { BrowseView } from "../../plugins/lifecycle";
import type { GrantsView } from "../../plugins/grants";
import {
  limitationSummary,
  namedEvidence,
  pluginBlurb,
  readLabel,
  routeOut,
  runsHereNote,
  sourceNote,
  verdictBlurb,
  verdictHeading,
  type ConsolePlugin,
} from "../../plugins/plugins";

/**
 * One plugin, at length — which is where all of this always belonged.
 *
 * ## Why this screen exists
 *
 * Every sentence below used to be on the row. A single plugin occupied most of
 * a phone screen: the author's blurb, the named findings, the hosts it calls,
 * a fold of limitations, the scan's notes, what was read, where it came from,
 * the route out, and three cards of controls. Reported as "soooo much jargon
 * text — people just want to enable or disable a plugin", and the reader is
 * right twice over: the list is for deciding which plugin, and none of this
 * helps with that.
 *
 * So the list answers "is it on, and what turns it on", and everything that
 * answers "what is this, and what will it be allowed to do" is here, one press
 * away, in the order somebody actually asks it:
 *
 *  1. **What it is** — the author's own sentence, then its id and version.
 *  2. **What the scan found** — the verdict in full, its findings, the hosts it
 *     names, and the limits, because this is what consent is given against.
 *  3. **What it can do and whether it is running** — the three cards, unchanged.
 *
 * ## Nothing was shortened to fit
 *
 * Deliberately. The wall was a placement problem, not a wording one, and the
 * wording is load-bearing: `FLOOR_NOTE` says a verdict is a floor rather than a
 * guarantee, `routeOut` keeps a row from ending on a refusal, `limitationSummary`
 * counts limits rather than claiming things are broken. Every one of those
 * survives here in full. A person who wanted the detail gets all of it; a
 * person who wanted a switch never sees it.
 */
export function PluginDetail({
  plugin,
  grants,
  browse,
  runtime,
  onBack,
}: {
  plugin: ConsolePlugin;
  grants: GrantsView;
  browse: BrowseView;
  runtime: RuntimeView;
  onBack: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  /*
    Still a fold, and still closed. The list is no longer the thing it was
    protecting — but five sentences of "not yet, so that part will not work"
    between a plugin's name and its controls is a wall wherever it is drawn.
  */
  const [limitsOpen, setLimitsOpen] = useState(false);
  const findings = namedEvidence(plugin);
  const read = readLabel(plugin);
  const route = routeOut(plugin.verdict);
  const pending = runsHereNote(plugin.verdict);
  const limits = limitationSummary(plugin.limitations);
  const blurb = pluginBlurb(plugin);
  const from = sourceNote(plugin);

  return (
    <View testID={`plugin-detail-${plugin.id}`}>
      {/*
        A breadcrumb rather than a chip reading "‹ All plugins".

        The pane above already says Plugins — that is the section you are in —
        so the old chip was a third thing on the screen naming the same place,
        and it named it differently from both of them. A crumb says where you
        are *and* where back goes in one line, which is what the settings bar
        one level up does with `@seyi / settings / plugins`.
      */}
      <View style={styles.crumbs}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to all plugins"
          onPress={onBack}
          style={styles.crumbBack}
          testID="plugin-detail-back"
        >
          <Text variant="mini" style={styles.crumbLink}>
            Plugins
          </Text>
        </Pressable>
        <Text variant="mini" style={styles.crumbSep} aria-hidden>
          /
        </Text>
        <Text variant="mini" style={styles.crumbHere} numberOfLines={1}>
          {plugin.name}
        </Text>
      </View>

      <Card>
        <Text variant="paneTitle" role="heading" aria-level={3}>
          {plugin.name}
        </Text>
        <Text variant="treeMeta" style={styles.meta}>
          {[plugin.id, plugin.version ? `v${plugin.version}` : null, plugin.author]
            .filter(Boolean)
            .join(" · ")}
        </Text>

        {blurb ? (
          <Text variant="rowSub" style={styles.line} testID={`plugin-blurb-${plugin.id}`}>
            {blurb}
          </Text>
        ) : null}

        {from ? (
          <Text variant="rowSub" style={styles.line}>
            {from}
          </Text>
        ) : null}
      </Card>

      {/*
        The scan, whole. It is one card rather than loose lines under the name
        because it is one claim — what reading this bundle found — and the
        floor under it (`FLOOR_NOTE`, on the list) applies to all of it.
      */}
      <Card style={styles.group}>
        <Text variant="listGroup">{verdictHeading(plugin.verdict)}</Text>
        <Text variant="rowSub" style={styles.line}>
          {verdictBlurb(plugin.verdict)}
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

        {limits === null || limitsOpen
          ? plugin.limitations.map((limitation, index) => (
              <Text key={`${plugin.id}-limitation-${index}`} variant="rowSub" style={styles.line}>
                {limitation}
              </Text>
            ))
          : null}

        {limits !== null ? (
          <View style={styles.action}>
            <Button
              label={limitsOpen ? "Hide the details" : limits}
              variant="mini"
              onPress={() => setLimitsOpen((was) => !was)}
            />
          </View>
        ) : null}

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

        {/*
          The closing line is exactly one of two things and never both: the
          route that still works, or — for the two verdicts Context can run —
          the note saying so. Both come from the pure module, so "a plugin is
          never left on its refusal" stays a property a test can hold.
        */}
        <Text variant="hint" style={styles.close}>
          {route ?? pending}
        </Text>
      </Card>

      <Card style={styles.group}>
        <PluginRuntimeCard plugin={plugin} view={runtime} grants={grants} />
        <PluginGrantCard plugin={plugin} view={grants} runtime={runtime} />
        <PluginManagedCard plugin={plugin} view={browse} />
      </Card>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    crumbs: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      marginBottom: space.x3,
    },
    crumbBack: { marginLeft: -space.x1, paddingHorizontal: space.x1, borderRadius: radii.xs },
    crumbLink: { color: colors.accent },
    crumbSep: { color: colors.muted },
    crumbHere: { color: colors.text2, flexShrink: 1 },
    meta: { marginTop: 2, color: colors.muted },
    line: { marginTop: 4 },
    close: { marginTop: 7 },
    action: { marginTop: 13, alignItems: "flex-start" },
    group: { marginTop: 11 },
  });
