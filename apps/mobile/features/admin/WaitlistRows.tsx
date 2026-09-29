/**
 * The Waitlist tab's rows: a table on a pointer, stacked rows on a phone.
 *
 * On a phone the checkbox sits on the left and Let in on the right of each
 * row, with the email and the answer stacked between them, so the one action
 * somebody came to do is under a thumb without scrolling sideways. The table
 * does not shrink to fit a phone; it is not drawn there at all.
 */

import { Pressable, StyleSheet, View } from "react-native";
import { Button, Text, leading, radii, space, useColors, useThemedStyles, type Colors } from "../design";
import { Icon } from "../design/components/Icon";
import { pointerType } from "../design/tokens";
import { useCompact, usePanelPad } from "./AdminKit";
import { TableRow, type Column } from "./AdminTable";
import { shortDate, type WaitlistRow, type WaitlistStatus } from "./waitlist";

/** What a row can do, which depends on the list it is in. */
export interface RowActions {
  /** Selection is offered where there is a bulk action to take. */
  selectable: boolean;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  /** Let one person in; absent on the lists where that is not the errand. */
  onAdmit?: (id: string) => void;
  busy: boolean;
}

export function WaitlistRows({
  rows,
  status,
  actions,
}: {
  rows: readonly WaitlistRow[];
  status: WaitlistStatus;
  actions: RowActions;
}) {
  const compact = useCompact();
  return compact ? (
    <>
      {rows.map((row, index) => (
        <StackedRow key={row.id} row={row} status={status} actions={actions} first={index === 0} />
      ))}
    </>
  ) : (
    <WideTable rows={rows} status={status} actions={actions} />
  );
}

function WideTable({
  rows,
  status,
  actions,
}: {
  rows: readonly WaitlistRow[];
  status: WaitlistStatus;
  actions: RowActions;
}) {
  const styles = useThemedStyles(makeStyles);
  // The header is a `TableRow` rather than `TableHead` so it can hold the
  // select-all box; `TableHead` draws labels and nothing else.
  const columns: Column[] = [
    ...(actions.selectable ? [{ label: "", width: 16 }] : []),
    { label: "Email", flex: 2 },
    { label: "Would use it for", flex: 3 },
    { label: status === "admitted" ? "Let in" : "Joined", width: 64 },
    ...(actions.onAdmit ? [{ label: " ", width: 64, align: "right" as const }] : []),
  ];
  const allPicked = rows.length > 0 && rows.every((row) => actions.selected.has(row.id));
  const head = (label: string) => (
    <Text variant="eyebrow" numberOfLines={1}>
      {label}
    </Text>
  );
  return (
    <>
      <TableRow
          columns={columns}
          cells={[
            ...(actions.selectable
              ? [
                  <PickBox
                    key="all"
                    picked={allPicked}
                    label={allPicked ? "Clear the selection" : "Select everyone shown"}
                    onPick={actions.onToggleAll}
                    testID="admin-waitlist-pick-all"
                  />,
                ]
              : []),
            head("Email"),
            head("Would use it for"),
            head(status === "admitted" ? "Let in" : "Joined"),
            ...(actions.onAdmit ? [null] : []),
          ]}
        />
      {rows.map((row, index) => (
        <TableRow
          key={row.id}
          columns={columns}
          last={index === rows.length - 1}
          testID={`admin-waitlist-row-${row.id}`}
          cells={[
            ...(actions.selectable
              ? [
                  <PickBox
                    key="pick"
                    picked={actions.selected.has(row.id)}
                    label={`Select ${row.email}`}
                    onPick={() => actions.onToggle(row.id)}
                    testID={`admin-waitlist-pick-${row.id}`}
                  />,
                ]
              : []),
            <Text key="email" variant="rowTitle" numberOfLines={1} style={styles.email}>
              {row.email}
            </Text>,
            <UseFor key="for" text={row.useFor} />,
            <Text key="when" variant="meta" numberOfLines={1}>
              {shortDate(status === "admitted" && row.admittedAt !== null ? row.admittedAt : row.joinedAt)}
            </Text>,
            ...(actions.onAdmit
              ? [<AdmitButton key="admit" row={row} onAdmit={actions.onAdmit} busy={actions.busy} />]
              : []),
          ]}
        />
      ))}
    </>
  );
}

function StackedRow({
  row,
  status,
  actions,
  first,
}: {
  row: WaitlistRow;
  status: WaitlistStatus;
  actions: RowActions;
  first: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const pad = usePanelPad();
  const when =
    status === "admitted" && row.admittedAt !== null
      ? `let in ${shortDate(row.admittedAt)}`
      : `joined ${shortDate(row.joinedAt)}`;
  return (
    <View
      style={[styles.stacked, { paddingHorizontal: pad.x }, !first && styles.ruled]}
      testID={`admin-waitlist-row-${row.id}`}
    >
      {actions.selectable ? (
        <PickBox
          picked={actions.selected.has(row.id)}
          label={`Select ${row.email}`}
          onPick={() => actions.onToggle(row.id)}
          testID={`admin-waitlist-pick-${row.id}`}
        />
      ) : null}
      <View style={styles.main}>
        <Text variant="rowTitle" style={styles.emailCompact}>
          {row.email}
        </Text>
        {row.useFor ? <UseFor text={row.useFor} /> : null}
        <Text variant="meta">{when}</Text>
      </View>
      {actions.onAdmit ? <AdmitButton row={row} onAdmit={actions.onAdmit} busy={actions.busy} /> : null}
    </View>
  );
}

/** Their answer to "what would you use it for?", or a dash for no answer. */
function UseFor({ text }: { text: string | null }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  return (
    <Text
      variant="meta"
      numberOfLines={compact ? 3 : 2}
      style={[compact ? styles.useForCompact : styles.useFor, text ? null : styles.none]}
    >
      {text ?? "—"}
    </Text>
  );
}

function AdmitButton({
  row,
  onAdmit,
  busy,
}: {
  row: WaitlistRow;
  onAdmit: (id: string) => void;
  busy: boolean;
}) {
  return (
    <Button
      label="Let in"
      accessibilityLabel={`Let ${row.email} in`}
      disabled={busy}
      onPress={() => onAdmit(row.id)}
      testID={`admin-waitlist-admit-${row.id}`}
    />
  );
}

/** A checkbox, drawn the way the task list draws its selection. */
function PickBox({
  picked,
  label,
  onPick,
  testID,
}: {
  picked: boolean;
  label: string;
  onPick: () => void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <Pressable
      onPress={onPick}
      role="checkbox"
      aria-checked={picked}
      accessibilityLabel={label}
      hitSlop={10}
      style={[styles.box, picked && styles.boxOn]}
      testID={testID}
    >
      {picked ? <Icon name="check" size={10} color={colors.white} /> : null}
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    email: { fontSize: pointerType.ui, lineHeight: leading(pointerType.ui, 1.55) },
    emailCompact: { fontSize: pointerType.lede, lineHeight: leading(pointerType.lede, 1.4) },
    useFor: { color: colors.text2 },
    useForCompact: { color: colors.text2, fontSize: pointerType.ui, lineHeight: leading(pointerType.ui, 1.55) },
    none: { color: colors.muted },

    stacked: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      paddingVertical: space.x3,
    },
    ruled: { borderTopWidth: 1, borderTopColor: colors.line },
    main: { flex: 1, minWidth: 0, gap: 2 },

    box: {
      width: 16,
      height: 16,
      flexShrink: 0,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1.5,
      borderColor: colors.lineStrong,
      borderRadius: radii.xs,
    },
    boxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  });
