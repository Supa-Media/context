import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useThemedStyles, type Colors } from "../../design/theme";
import { ListBox, ListRow, SubPage, T } from "./TexPageParts";
import { SETTING_LABEL, settingValue } from "./texPageLedger";
import { TexHistoryLines } from "../history/TexHistoryLines";
import type { ViewProps } from "./TexPageBody";
import type { Read } from "./texPageSource";
import type { LedgerSees } from "./texPageTypes";

/**
 * The chat's history file: its one ledger, everything said and done in the
 * chat, one line a message with filters (`TexHistoryLines`), and, on a page
 * of its own, "What Tex sees", the chat as the next
 * texted turn is shown it with the settings that shaped it (decided by the
 * owner, 2026-11-02; `docs/decisions/texting-assistant/chat-ledger.md`).
 * Newest day first. Both are read from the gateway each time; nothing here keeps
 * a copy.
 */

export function HistoryPage({ source, chat, group, history }: ViewProps) {
  return (
    <SubPage title={group ? `History · ${group}` : "History"} testID="tex-history">
      <TexHistoryLines source={source} chat={chat} group={group !== null} {...(history ? { initial: history } : {})} />
    </SubPage>
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
