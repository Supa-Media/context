import { useMemo } from "react";
import { useWindowDimensions } from "react-native";
import { Screen } from "../app/Screen";
import { densityFor } from "../app/frame";
import { layout } from "../design/tokens";
import { NowContext } from "../tex/page/TexPageParts";
import { fixtureNow, fixtureSource } from "../tex/page/texPageFixture";
import { HistoryFileLines } from "../tex/history/HistoryFileLines";
import { HistoryHead } from "../tex/history/HistoryFileView";

/**
 * `/e2e-fixture?screen=history-file`: a group's history file as it opens in
 * the app, on the Tex page's example data, every day at once: the screenshot
 * pass against the artboard Dev approved on 2026-11-03.
 */
export function HistoryFileFixture() {
  const base = useMemo(() => fixtureSource(), []);
  const source = useMemo(() => ({ ...base, ledger: (chat: string, q: Parameters<typeof base.ledger>[1]) => base.ledger(chat, { ...q, day: undefined }) }), [base]);
  const compact = densityFor(useWindowDimensions().width) === "compact";
  return (
    <NowContext.Provider value={fixtureNow}>
      <Screen testID="history-file-fixture">
        <HistoryFileLines source={source} chat="me" group={false} head={<HistoryHead whose="Crystal Care Agency" />} pad={{ top: 12, bottom: 0, side: compact ? layout.readingMargin : 56 }} />
      </Screen>
    </NowContext.Provider>
  );
}
