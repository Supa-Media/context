/**
 * How big the work is, on a row (the owner, 2026-09-29: "work estimates XS,
 * S, M, L, XL, XXL … and no estimate as well"): a small outlined size, and
 * for somebody who may write a button that opens the six sizes, each with
 * what it roughly means, and "No estimate", which clears the line. Unset, a
 * writer sees a quiet dashed "+" and a member nothing. The write is the row's
 * own (`onChoose(item, "estimate", …)`), said with an Undo, and lands as
 * `estimate: M` in the task's front matter.
 *
 * The column is drawn only once a task on the page has an estimate
 * (`ItemActions.sized`): a column of empty "+" on every row took the room a
 * narrow page's names need (the hover tools then covered them whole). The
 * first estimate is set from the row's right-click menu or the side panel.
 */

import { useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../../../design/components/Icon";
import { Menu } from "../../../design/components/Menu";
import { Text } from "../../../design/components/Text";
import { radii } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import type { ItemActions } from "./items";
import type { FolderItem } from "./model";
import { ESTIMATE_HINTS, ESTIMATES, estimateOf, NO_ESTIMATE, type Estimate } from "./taskProps";

/** The six sizes, each with its meaning, then No estimate: the picker's words. */
export function estimateChoices(current: Estimate | null) {
  return [
    ...ESTIMATES.map((size) => ({ id: size as string, label: size, detail: ESTIMATE_HINTS[size], checked: current === size })),
    { id: "none", label: NO_ESTIMATE, checked: current === null, separatorBefore: true },
  ];
}

/** An estimate as a screen reader and a tooltip say it: "Estimate: M, a day or two". */
export function estimateLabel(estimate: Estimate | null): string {
  return estimate === null ? NO_ESTIMATE : `Estimate: ${estimate}, ${ESTIMATE_HINTS[estimate].toLowerCase()}`;
}

export function EstimateCell({ item, actions }: { item: FolderItem; actions: ItemActions }) {
  const styles = useThemedStyles(makeStyles);
  const node = useRef<View>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null | undefined>(undefined);
  const estimate = estimateOf(item.properties);
  const edit = actions.onChoose;
  if (edit === null)
    return (
      <View style={styles.cell}>
        {estimate === null ? null : (
          <View style={styles.size} accessibilityLabel={estimateLabel(estimate)} testID="folder-item-estimate">
            <Text variant="meta" style={styles.word}>
              {estimate}
            </Text>
          </View>
        )}
      </View>
    );
  const open = anchor !== undefined;
  return (
    <View ref={node} collapsable={false} style={styles.cell}>
      <Pressable
        onPress={() => {
          setAnchor(null);
          node.current?.measureInWindow?.((x, y, _width, height) => setAnchor({ x, y: y + height + 4 }));
        }}
        role="button"
        aria-haspopup="menu"
        aria-expanded={open}
        accessibilityLabel={estimate === null ? "Set an estimate" : `Change estimate, ${estimate}`}
        {...({ title: estimate === null ? "Set an estimate" : estimateLabel(estimate) } as object)}
        hitSlop={4}
        style={[styles.size, estimate === null && styles.unset]}
        testID="folder-item-estimate"
      >
        {estimate === null ? (
          <Icon name="plus" size={10} color={styles.quiet.color} />
        ) : (
          <Text variant="meta" style={styles.word}>
            {estimate}
          </Text>
        )}
      </Pressable>
      {open ? (
        <Menu<string>
          items={estimateChoices(estimate)}
          {...(anchor === null ? {} : { anchor })}
          title="Estimate"
          onDismiss={() => setAnchor(undefined)}
          onSelect={(id) => {
            setAnchor(undefined);
            edit(item, "estimate", id === "none" ? null : id);
          }}
        />
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    // A column, so sizes line up; it gives way before the name does.
    cell: { width: 40, flexShrink: 1, minWidth: 0, alignItems: "center", overflow: "hidden" },
    size: {
      minWidth: 30,
      height: 20,
      paddingHorizontal: 5,
      borderRadius: radii.sm,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      alignItems: "center",
      justifyContent: "center",
    },
    unset: { borderStyle: "dashed", opacity: 0.7 },
    word: { color: colors.text2, fontWeight: "600" },
    quiet: { color: colors.chromeMuted },
  });
