/**
 * Compare's "Cases that differ" (board 20): live's reply beside the
 * experiment's on each case where one passed every run and the other did not,
 * with the rule a reply missed under it in red. Read from the round's replies
 * note (`./aiCompareModel`); a round from before the bench wrote one says so.
 */

import { StyleSheet, View } from "react-native";
import type { Id } from "@context/convex/_generated/dataModel";
import { Text, space, useThemedStyles, type Colors } from "../design";
import { Box, Columns, Quietly } from "./AiKit";
import { historyLabel, parseReplies, replyOf, repliesPathOf, type Reply } from "./aiCompareModel";
import type { CaseCell } from "./aiModel";
import { useNoteTexts } from "./useAiNote";

export interface RepliesRound {
  /** The round's scores note; its replies note sits beside it. */
  scoresPath: string;
  group: string;
  /** Live's earlier rounds on a case of this group, for the line under it. */
  history: (question: number) => readonly CaseCell[];
}

function ReplyPane({ who, reply }: { who: string; reply: Reply | null }) {
  const styles = useThemedStyles(makeStyles);
  if (reply === null) {
    return (
      <View style={styles.pane}>
        <Text variant="meta" style={styles.muted}>{`${who}: not in this round`}</Text>
      </View>
    );
  }
  const answer = reply.turns.filter((turn) => turn.from === "reply");
  return (
    <View style={styles.pane}>
      <View style={styles.paneHead}>
        <Text variant="meta" numberOfLines={1} style={styles.who}>{`${who} · run ${reply.run} of ${reply.of}`}</Text>
        <Text variant="meta" style={reply.passed ? styles.ok : styles.crit}>{reply.passed ? "passed" : `missed ${reply.missed.length} ${reply.missed.length === 1 ? "rule" : "rules"}`}</Text>
      </View>
      {answer.length === 0 ? <Text variant="meta" style={styles.muted}>No reply.</Text> : answer.map((turn, index) => <Text key={index} variant="body" style={styles.text}>{turn.text}</Text>)}
      {reply.missed.map((rule) => (
        <Text key={rule} variant="meta" style={styles.crit}>{rule}</Text>
      ))}
    </View>
  );
}

export function AiCompareReplies({ workspaceId, rounds, setup, setupLabel, liveName, testID }: {
  workspaceId: Id<"workspaces">;
  /** The newest round of each case group that ran the experiment. */
  rounds: readonly RepliesRound[];
  setup: string;
  setupLabel: string;
  liveName: string;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const paths = rounds.map((round) => repliesPathOf(round.scoresPath));
  const texts = useNoteTexts(workspaceId, paths);
  const several = rounds.length > 1;
  const cases = rounds.flatMap((round, index) => {
    const text = texts.get(paths[index]!);
    if (text === undefined || text === null) return [];
    return [...parseReplies(text).values()]
      .filter((item) => replyOf(item, setup) !== null)
      .map((item) => ({ round, item }));
  });
  const reading = paths.some((path) => !texts.has(path));
  const found = paths.some((path) => typeof texts.get(path) === "string");
  const right = found ? <Text variant="meta" numberOfLines={1}>{`${cases.length} ${cases.length === 1 ? "case" : "cases"}; the rest gave the same result`}</Text> : null;
  return (
    <Box title="Cases that differ" right={right} testID={testID}>
      {rounds.length === 0 ? (
        <Quietly>Not run beside live yet.</Quietly>
      ) : reading ? (
        <Quietly>Reading the replies…</Quietly>
      ) : !found ? (
        <Quietly testID={`${testID}-none`}>These rounds kept no replies. Rounds run from now on keep the replies where the setups differ.</Quietly>
      ) : cases.length === 0 ? (
        <Quietly>Every case gave the same result for both.</Quietly>
      ) : (
        cases.map(({ round, item }, index) => (
          <View key={`${round.scoresPath}-${item.question}`} style={[styles.case, index > 0 && styles.caseLine]} testID={`${testID}-${item.question}`}>
            <Text variant="rowTitle" numberOfLines={2} style={styles.title}>{`${several ? `${round.group} ` : ""}${item.question}. “${item.title}”`}</Text>
            <Text variant="meta" style={styles.muted}>{`Live before: ${historyLabel(round.history(item.question))}`}</Text>
            <Columns weights={[1, 1]}>
              {[<ReplyPane key="live" who="Live" reply={replyOf(item, liveName, true)} />, <ReplyPane key="mine" who={setupLabel} reply={replyOf(item, setup)} />]}
            </Columns>
          </View>
        ))
      )}
    </Box>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    case: { gap: space.x2, paddingVertical: space.x3, minWidth: 0 },
    caseLine: { borderTopWidth: 1, borderTopColor: colors.line },
    title: { color: colors.text },
    pane: { gap: space.x1, borderWidth: 1, borderColor: colors.line, borderRadius: 8, padding: space.x3, minWidth: 0 },
    paneHead: { flexDirection: "row", justifyContent: "space-between", gap: space.x2 },
    who: { flexShrink: 1, color: colors.muted },
    text: { color: colors.text },
    muted: { color: colors.muted },
    ok: { color: colors.okText },
    crit: { color: colors.critText, fontWeight: "600" },
  });
