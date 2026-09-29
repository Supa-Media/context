/**
 * The Waitlist tab: who asked to be let in, and letting them in.
 *
 * Context.LC is invite-only, so this is a chore somebody does most days
 * rather than a figure to read: the list is newest first, each waiting row
 * has its own Let in, and a selection gets Let in and Remove together.
 *
 * Every press is answered with what the server says changed — see
 * `./waitlist` for why the sentence counts `changed` rather than the rows
 * that were pressed. Letting somebody in mails them once, server side, so a
 * second press or an overlapping selection never mails anyone twice.
 */

import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import {
  Button,
  Card,
  Notice,
  Text,
  leading,
  radii,
  space,
  useThemedStyles,
  type Colors,
} from "../design";
import { TextLink } from "../design/components/TextLink";
import { pointerType } from "../design/tokens";
import { EmptyNote, NoticeLine, Panel, Skeleton, useCompact } from "./AdminKit";
import { messageFor } from "./SecretDialogs";
import { WaitlistAdd } from "./WaitlistAdd";
import { WaitlistRows } from "./WaitlistRows";
import {
  WAITLIST_FILTERS,
  admittedSentence,
  people,
  removedSentence,
  type WaitlistStatus,
} from "./waitlist";

/** What the last press did: a sentence, and any pasted entries that were not addresses. */
interface Outcome {
  tone: "ok" | "warn";
  sentence: string;
  invalid: readonly string[];
}

export function WaitlistSection() {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const [status, setStatus] = useState<WaitlistStatus>("waiting");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const list = useQuery(api.functions.admin.listWaitlist, { status });
  const admit = useMutation(api.functions.admin.admitWaitlist);
  const remove = useMutation(api.functions.admin.removeFromWaitlist);

  // A selection belongs to the list it was made on.
  useEffect(() => setSelected(new Set()), [status]);

  const rows = useMemo(() => list?.rows ?? [], [list]);
  // Only what is still on screen counts: a row somebody else let in drops
  // out of Waiting, and must drop out of the selection with it.
  const picked = useMemo(() => rows.filter((row) => selected.has(row.id)).map((row) => row.id), [rows, selected]);

  async function run(kind: "admit" | "remove", ids: readonly string[]) {
    setBusy(true);
    setOutcome(null);
    try {
      const args = { ids: ids as Id<"waitlist">[] };
      const result = kind === "admit" ? await admit(args) : await remove(args);
      setSelected(new Set());
      setOutcome({
        tone: "ok",
        sentence: kind === "admit" ? admittedSentence(result.changed) : removedSentence(result.changed),
        invalid: [],
      });
    } catch (caught) {
      setOutcome({ tone: "warn", sentence: messageFor(caught, "That did not work. Try again."), invalid: [] });
    } finally {
      setBusy(false);
    }
  }

  const toggle = (id: string) =>
    setSelected((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelected(picked.length === rows.length ? new Set() : new Set(rows.map((row) => row.id)));

  const counts = list?.counts;
  return (
    <View style={styles.section}>
      <View style={[styles.head, compact && styles.headCompact]}>
        <View style={styles.titles}>
          <Text variant="rowTitle" role="heading" aria-level={2} style={styles.title}>
            Waitlist
          </Text>
          <Text variant="meta" style={compact ? styles.textCompact : null}>
            People who asked to be let in. Letting someone in sends them an email.
          </Text>
        </View>
        {adding ? null : (
          <Button
            label="Add emails"
            variant="dialogPrimary"
            onPress={() => {
              setOutcome(null);
              setAdding(true);
            }}
            style={compact ? styles.addCompact : styles.add}
            testID="admin-waitlist-add-open"
          />
        )}
      </View>

      {adding ? (
        <WaitlistAdd
          onClose={() => setAdding(false)}
          onDone={(sentence, invalid) => {
            setAdding(false);
            setOutcome({ tone: invalid.length > 0 ? "warn" : "ok", sentence, invalid });
          }}
        />
      ) : null}

      {outcome ? (
        <Notice tone={outcome.tone} testID="admin-waitlist-outcome">
          <NoticeLine mark={outcome.tone === "ok" ? "✓" : "!"} tone={outcome.tone}>
            {outcome.sentence}
            {outcome.invalid.length > 0
              ? ` Not email addresses, so skipped: ${outcome.invalid.join(", ")}.`
              : ""}
          </NoticeLine>
        </Notice>
      ) : null}

      <View style={styles.filters} role="tablist">
        {WAITLIST_FILTERS.map((filter) => {
          const on = filter.key === status;
          const count =
            filter.key === "removed" || counts === undefined ? null : counts[filter.key];
          return (
            <Pressable
              key={filter.key}
              role="tab"
              aria-selected={on}
              onPress={() => setStatus(filter.key)}
              style={[styles.chip, compact && styles.chipCompact, on && styles.chipOn]}
              testID={`admin-waitlist-filter-${filter.key}`}
            >
              <Text style={[styles.chipLabel, compact && styles.chipLabelCompact, on && styles.chipLabelOn]}>
                {filter.label}
                {count === null ? "" : ` ${count}`}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {picked.length > 0 ? (
        <View style={[styles.bulk, compact && styles.bulkCompact]} testID="admin-waitlist-bulk">
          <Text style={styles.bulkCount}>{picked.length} selected</Text>
          <View style={styles.bulkActions}>
            <Button
              label="Let in"
              accessibilityLabel={`Let ${people(picked.length)} in`}
              variant="dialogPrimary"
              disabled={busy}
              onPress={() => run("admit", picked)}
              testID="admin-waitlist-bulk-admit"
            />
            {status === "waiting" ? (
              <Button
                label="Remove"
                accessibilityLabel={`Remove ${people(picked.length)}`}
                variant="danger"
                disabled={busy}
                onPress={() => run("remove", picked)}
                testID="admin-waitlist-bulk-remove"
              />
            ) : null}
            <TextLink label="Clear" onPress={() => setSelected(new Set())} />
          </View>
        </View>
      ) : null}

      {list === undefined ? (
        <Card>
          <Skeleton width={120} height={14} />
          <Skeleton width="100%" height={120} style={styles.skGap} />
        </Card>
      ) : (
        <Panel flush>
          {rows.length === 0 ? (
            <EmptyNote
              title={
                status === "waiting"
                  ? "Nobody is waiting"
                  : status === "admitted"
                    ? "Nobody has been let in yet"
                    : "Nobody has been removed"
              }
              testID="admin-waitlist-empty"
            />
          ) : (
            <WaitlistRows
              rows={rows}
              status={status}
              actions={{
                // Let in is the errand on Waiting, and the undo on Removed.
                selectable: status !== "admitted",
                selected,
                onToggle: toggle,
                onToggleAll: toggleAll,
                onAdmit: status === "waiting" ? (id) => run("admit", [id]) : undefined,
                busy,
              }}
            />
          )}
        </Panel>
      )}

      {list?.more ? (
        <Text variant="foot" style={compact ? styles.textCompact : null}>
          Showing the newest {rows.length}.
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    section: { gap: space.x4 },
    head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.x3 },
    headCompact: { flexDirection: "column", alignItems: "stretch" },
    titles: { flexShrink: 1, gap: 2 },
    title: { fontSize: pointerType.lede, lineHeight: leading(pointerType.lede, 1.4) },
    add: { paddingVertical: 6, paddingHorizontal: 13 },
    addCompact: { alignSelf: "stretch", paddingVertical: 11 },
    textCompact: { fontSize: pointerType.ui, lineHeight: leading(pointerType.ui, 1.55) },

    // The console header's segmented track, a size down.
    filters: {
      flexDirection: "row",
      alignSelf: "flex-start",
      gap: 2,
      padding: 2,
      borderRadius: radii.lg,
      backgroundColor: colors.chipFill,
    },
    chip: { paddingVertical: 3, paddingHorizontal: 10, borderRadius: 5 },
    chipCompact: { paddingVertical: 5, paddingHorizontal: 14 },
    chipOn: {
      backgroundColor: colors.surface,
      boxShadow: `0 0 0 1px ${colors.line}, 0 1px 2px rgba(0,0,0,.06)`,
    },
    chipLabel: {
      fontSize: pointerType.meta,
      lineHeight: leading(pointerType.meta, 1.55),
      fontWeight: "500",
      color: colors.muted,
      fontVariant: ["tabular-nums"],
    },
    chipLabelCompact: { fontSize: pointerType.ui, lineHeight: leading(pointerType.ui, 1.55) },
    chipLabelOn: { color: colors.text },

    bulk: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: space.x3,
      paddingVertical: space.x2,
      paddingHorizontal: space.x4,
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface,
    },
    bulkCompact: { flexWrap: "wrap" },
    bulkCount: {
      fontSize: pointerType.ui,
      lineHeight: leading(pointerType.ui, 1.55),
      fontWeight: "600",
      color: colors.text,
      fontVariant: ["tabular-nums"],
    },
    bulkActions: { flexDirection: "row", alignItems: "center", gap: space.x2 },

    skGap: { marginTop: 18 },
  });
