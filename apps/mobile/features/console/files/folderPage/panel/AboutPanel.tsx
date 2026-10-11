/**
 * A folder's whole about note, beside its page in the side panel: what Read
 * more opens on a desktop page (`AboutBlock.tsx`), so the list stays where it
 * is. "About Projects", Expand to the note's own page, ✕ (and Escape); then
 * the words, which a writer types in through the console's one editor, as
 * the task panel's are (`PanelBody.tsx`).
 */

import { StyleSheet, View } from "react-native";
import { Text } from "../../../../design/components/Text";
import { space } from "../../../../design/tokens";
import { useThemedStyles } from "../../../../design/theme";
import { useConsoleNav } from "../../../ConsoleNavContext";
import type { FolderListSource } from "../../listBlock/model";
import { PanelBody } from "./PanelBody";
import { PanelHead } from "./PanelHead";
import type { PeekEditing } from "./peekEditing";

export function AboutPanel({
  path,
  title,
  source,
  width,
  editing,
  onNavigate,
  onClose,
}: {
  path: string;
  /** The folder's title, which the panel is about. */
  title: string;
  source: FolderListSource | undefined;
  width: number;
  /** The console's editor, lent to the panel; absent for a member. */
  editing?: PeekEditing;
  onNavigate: (path: string) => void;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const nav = useConsoleNav();
  return (
    <View style={styles.panel} role="complementary" aria-label={`About ${title}`} testID="about-panel">
      <PanelHead
        where="About this folder"
        parent={null}
        onShow={() => {}}
        onExpand={() => onNavigate(path)}
        onNewTab={nav === null ? null : () => nav.follow(path, "background")}
        onClose={onClose}
      />
      <Text variant="paneTitle" testID="about-panel-title">
        {`About ${title}`}
      </Text>
      <PanelBody
        source={source}
        path={path}
        title={title}
        width={width}
        onOpenNote={(to, mode) => (mode === "background" && nav !== null ? nav.follow(to, "background") : onNavigate(to))}
        onExpand={() => onNavigate(path)}
        {...(editing === undefined ? {} : { editing })}
      />
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    panel: { gap: space.x5 },
  });
