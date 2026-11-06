import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useThemedStyles, type Colors } from "../../design/theme";
import { ListBox, ListRow, SubPage, T, useWide } from "./TexPageParts";
import { SETTING_LABEL, settingValue } from "./texPageLedger";
import { HistoryFileLines } from "../history/HistoryFileLines";
import type { ViewProps } from "./TexPageBody";
import type { Read } from "./texPageSource";
import type { LedgerSees } from "./texPageTypes";

/**
 * The chat's history file: its one ledger, everything said and done in the
 * chat, one line a message with filters (`TexHistoryLines`), and, on a page
 * of its own, "What Tex sees", the chat as the next
 * texted turn is shown it with the settings that shaped it (decided by the
 * owner, 2026-11-02; `docs/decisions/texting-assistant/chat-ledger.md`).
 * Both are read from the gateway each time; nothing here keeps a copy.
 *
 * History reads as a chat does, as the history file does (Dev, 2026-11-05:
 * "this page doesn't update in realtime, also it should start at the bottom
 * and then scroll up to see history like the history ledger page, filters
 * still visible"): live, oldest at the top, opened on the newest line, the
 * title and filters held above its own scroller (`HistoryFileLines`), so the
 * page around it does not scroll (`TexPageBody`).
 */

const NO_PAD = { top: 0, bottom: 0, side: 0 };

export function HistoryPage({ source, chat, group, history }: ViewProps) {
  const wide = useWide();
  const head = (
    <T size={wide ? 22 : 20} serif line={1.25} numberOfLines={1}>
      {group ? `History · ${group}` : "History"}
    </T>
  );
  return (
    <View style={{ flex: 1, minHeight: 0 }} testID="tex-history">
      <HistoryFileLines source={source} chat={chat} group={group !== null} head={head} pad={NO_PAD} phone={!wide} look="page" testID="tex-history-lines" {...(history ? { initial: history } : {})} />
    </View>
  );
}

export function SeesPage({ source, chat, group }: ViewProps) {
  return (
    <SubPage title={group ? `What Tex sees · ${group}` : "What Tex sees"} testID="tex-sees-page">
      <WhatTexSees source={source} chat={chat} />
    </SubPage>
  );
}

function Quiet({ children, testID }: { children: string; testID?: string }) {
  return (
    <T size={13} tone="muted" testID={testID}>
      {children}
    </T>
  );
}

function WhatTexSees({ source, chat }: Pick<ViewProps, "source" | "chat">) {
  const styles = useThemedStyles(makeStyles);
  const [read, setRead] = useState<Read<LedgerSees> | null>(null);
  const [reread, setReread] = useState(0);
  useEffect(() => {
    let live = true;
    setRead(null);
    void source.sees(chat).then((r) => {
      if (live) setRead(r);
    });
    return () => {
      live = false;
    };
  }, [source, chat, reread]);

  if (read === null) return <ActivityIndicator size="small" />;
  if (read.kind !== "ok") return <Quiet testID="tex-sees-failed">What Tex sees can't be read right now. Try again in a moment.</Quiet>;
  const { settings, text } = read.value;
  return (
    <View style={{ gap: 14 }} testID="tex-sees">
      <T size={14} tone="muted">
        This is the chat exactly as Tex is shown it on the next text, rebuilt from the history.
      </T>
      <ListBox>
        {Object.entries(settings).map(([k, v]) => (
          <ListRow key={k} title={SETTING_LABEL[k] ?? k} right={<T size={13} tone="text2">{settingValue(v)}</T>} testID={`tex-sees-setting-${k}`} />
        ))}
      </ListBox>
      <Pressable accessibilityRole="button" onPress={() => setReread((n) => n + 1)} testID="tex-sees-reread">
        <T size={13} tone="accent">
          Read it again
        </T>
      </Pressable>
      <ScrollView horizontal style={styles.raw}>
        <T size={12} mono line={1.45} tone="text2" testID="tex-sees-text">
          {text === "" ? "(Nothing yet: Tex sees an empty chat.)" : text}
        </T>
      </ScrollView>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    raw: { backgroundColor: colors.surface2, borderRadius: 8, padding: 10, marginBottom: 8 },
  });
