import { useEffect, useState } from "react";
import { PressRow } from "../design/components/Button";
import { Text } from "../design/components/Text";
import { radii } from "../design/tokens";
import { useThemedStyles } from "../design/theme";
import { useChaosView } from "./ChaosContext";
import { ChaosFigure } from "./ChaosFigure";
import { chipLabel, chipShows, type ChaosFolder } from "./chaosModel";
import { makeChaosStyles } from "./styles";

/**
 * A folder's own chaos, under its title — only when there is something worth
 * a glance: past fine (over 30), or thin (under four items and charged for
 * it). A calm folder page has no chip at all.
 *
 * Asked for this folder by name (`chaosScore`'s `folder`), again whenever the
 * workspace's score is (`version`), so it moves when the tree does. Pressing
 * it opens the panel as a sheet.
 */
export function FolderChaosChip({ folder }: { folder: string }) {
  const view = useChaosView();
  const styles = useThemedStyles(makeChaosStyles);
  const [mine, setMine] = useState<ChaosFolder | null>(null);
  const ask = view?.folderScore;
  const version = view?.version;
  useEffect(() => {
    setMine(null);
    if (ask === undefined) return undefined;
    let live = true;
    ask(folder)
      .then((answer) => {
        if (live) setMine(answer !== null && answer.available ? answer.folder : null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [ask, folder, version]);
  if (view === undefined || !chipShows(mine)) return null;
  const label = chipLabel(mine);
  return (
    <PressRow
      accessibilityLabel={`This folder: ${label}. Show the chaos score`}
      onPress={() => view.openPanel("sheet")}
      radius={radii.pill}
      style={styles.chip}
      hoverStyle={styles.chipHover}
      testID="folder-chaos-chip"
    >
      <ChaosFigure chaos={mine.chaos} size={18} />
      <Text variant="treeMeta" style={styles.chipText} numberOfLines={1}>
        {label}
      </Text>
    </PressRow>
  );
}
