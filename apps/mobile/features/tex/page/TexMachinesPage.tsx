import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { useThemedStyles, type Colors } from "../../design/theme";
import type { ViewProps } from "./TexPageBody";
import { ListBox, SectionHead, SubPage, T, useWide } from "./TexPageParts";
import { Button, ButtonRow, Chevron, DotLine, GlyphSquare, Pips, RowLink } from "./TexMachineParts";
import { at12, dotOf, poolFoot, rowLine, rowRight } from "./texMachineFormat";
import type { Machine, MachinesPage as MachinesData } from "./texMachineTypes";
import { useTexMachines } from "./useTexPage";

type Go = ViewProps["go"];

/**
 * Tex › Your machines (artboard `01-machines`, light and dark; screen 8
 * `08-machine-states`, one machine in each state; the empty state under 1).
 * Each machine is one row: its icon, name, state and today's use, then its
 * slot pips and the words beside them (desktop only). A pending machine opens
 * the connect page with a Review link. Tex's cloud sits below, never pressable.
 */
export function MachinesPage(props: ViewProps) {
  const styles = useThemedStyles(makeStyles);
  const wide = useWide();
  const read = useTexMachines(props.source, props.chat, props.page.changes);
  if (read === null) {
    return (
      <View style={styles.wait}>
        <ActivityIndicator size="small" />
      </View>
    );
  }
  if (read.kind !== "ok") {
    return <SubPage title="Your machines" lead="Your machines can't be reached right now." testID="tex-machines" />;
  }
  const page = read.value;
  const connect = () => props.go({ view: "connect" });
  // The newest pairing shows as its own row only when no listed machine already is that code.
  const pairing = page.pairing && !page.machines.some((m) => m.code === page.pairing?.code) ? page.pairing : null;
  const hasRows = page.machines.length > 0 || pairing !== null;

  return (
    <SubPage
      title="Your machines"
      lead="Tex can run jobs on your own computers, with the Claude Code and Codex you are signed in to there."
      testID="tex-machines"
    >
      <View style={styles.section}>
        <SectionHead>On your machines</SectionHead>
        {hasRows ? (
          <ListBox>
            {page.machines.map((m) => (
              <MachineRow key={m.id} m={m} wide={wide} go={props.go} />
            ))}
            {pairing ? (
              <Pressable accessibilityRole="button" onPress={connect} style={styles.row} testID="tex-machine-row-pairing">
                <GlyphSquare glyph="terminal" />
                <View style={styles.body}>
                  <T size={14} weight="500" numberOfLines={1}>
                    {pairing.name}
                  </T>
                  <DotLine tone="warn">{`Wants to connect · asked ${at12(pairing.at)}`}</DotLine>
                </View>
                <View style={styles.right}>
                  <RowLink label="Review" onPress={connect} testID="tex-machine-review-pairing" />
                </View>
              </Pressable>
            ) : null}
          </ListBox>
        ) : (
          <T size={14} tone="muted" testID="tex-machines-empty">
            Run coding jobs on your own computer, with your own Claude Code.
          </T>
        )}
      </View>

      <ButtonRow aside="The Mac app, or one command on any computer." hideAsideOnPhone>
        <Button label="Connect a machine" look="primary" onPress={connect} testID="tex-machines-connect" />
      </ButtonRow>

      <View style={styles.section}>
        <SectionHead>In the cloud</SectionHead>
        <ListBox>
          <CloudRow page={page} wide={wide} />
        </ListBox>
      </View>

      <T size={13} tone="muted" testID="tex-machines-foot">
        {poolFoot(page)}
      </T>
    </SubPage>
  );
}

/** One machine's row: a pending one shows only its Review link; any other shows its pips, its words on desktop, and a chevron. */
function MachineRow({ m, wide, go }: { m: Machine; wide: boolean; go: Go }) {
  const styles = useThemedStyles(makeStyles);
  const pending = m.state === "pending";
  const off = m.state === "offline" || m.state === "paused";
  const press = () => go(pending ? { view: "connect" } : { view: "machine", machine: m.id });
  return (
    <Pressable
      accessibilityRole="button"
      onPress={press}
      style={[styles.row, m.state === "offline" ? styles.dim : null]}
      testID={`tex-machine-row-${m.id}`}
    >
      <GlyphSquare glyph={m.kind === "mac" ? "laptop" : "terminal"} />
      <View style={styles.body}>
        <T size={14} weight="500" numberOfLines={1}>
          {m.name}
        </T>
        <DotLine tone={dotOf(m.state)}>{rowLine(m)}</DotLine>
      </View>
      <View style={styles.right}>
        {pending ? (
          <RowLink label="Review" onPress={press} testID={`tex-machine-review-${m.id}`} />
        ) : (
          <>
            {/* A machine that cannot take work yet shows its words only, not empty pips. */}
            {m.state === "notReady" ? null : <Pips slots={m.slots} busy={m.running.length} off={off} />}
            {wide ? (
              <T size={13} tone="text2" numberOfLines={1}>
                {rowRight(m)}
              </T>
            ) : null}
            <Chevron />
          </>
        )}
      </View>
    </Pressable>
  );
}

/** Tex's cloud: always on, nothing to set, so no chevron and no press. */
function CloudRow({ page, wide }: { page: MachinesData; wide: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const { slots, busy } = page.cloud;
  return (
    <View style={styles.row} testID="tex-machines-cloud">
      <GlyphSquare glyph="cloud" quiet />
      <View style={styles.body}>
        <T size={14} weight="500" numberOfLines={1}>
          Tex's cloud
        </T>
        <T size={13} tone="muted">
          Always on · Tex's own computers and browser
        </T>
      </View>
      <View style={styles.right}>
        <Pips slots={slots} busy={busy} />
        {wide ? (
          <T size={13} tone="text2" numberOfLines={1}>
            {`${busy} of ${slots} busy`}
          </T>
        ) : null}
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wait: { paddingVertical: 60, alignItems: "center" },
    section: { gap: 4 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 11,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    body: { flex: 1, minWidth: 0, gap: 2 },
    right: { flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 0 },
    dim: { opacity: 0.6 },
  });
