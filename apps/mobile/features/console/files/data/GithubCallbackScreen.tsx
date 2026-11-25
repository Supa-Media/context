/**
 * The window GitHub sends an owner back to (`app/data/github/callback.tsx`): it hands GitHub's answer to the console
 * tab that opened it (`githubSync.ts`), says so, and closes when it can. It calls nothing itself: the console tab is
 * the one signed in as the owner, and the gateway checks the signed state against that owner.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { CenteredScroll } from "../../../design/components/CenteredScroll";
import { Text } from "../../../design/components/Text";
import { fonts, leading, pointerType as t } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { githubReturnOf, handBackGithubReturn } from "./githubSync";

type Status = "handing" | "done" | "orphan" | "request" | "cancelled";

const WORDS: Readonly<Record<Status, { title: string; line: string }>> = {
  handing: { title: "Connecting GitHub", line: "Handing GitHub's answer back to Context…" },
  done: { title: "GitHub is connected", line: "Context is reading it now. You can close this window." },
  orphan: { title: "Go back to Context", line: "The Context tab that started this was closed. Open the data page and connect GitHub again." },
  request: { title: "Waiting for an owner on GitHub", line: "GitHub sent the install to your organization's owners to approve. Connect it again once they have." },
  cancelled: { title: "GitHub was not connected", line: "Nothing was installed for Context. You can close this window." },
};

export function GithubCallbackScreen() {
  const styles = useThemedStyles(makeStyles);
  const params = useLocalSearchParams<Record<string, string | string[]>>();
  const back = useMemo(() => githubReturnOf(params), [params]);
  const [status, setStatus] = useState<Status>(typeof back === "string" ? back : "handing");
  const started = useRef(false);

  useEffect(() => {
    if (started.current || typeof back === "string") return;
    started.current = true;
    void handBackGithubReturn(back).then((answered) => {
      setStatus(answered ? "done" : "orphan");
      if (answered && typeof window !== "undefined") setTimeout(() => window.close(), 1200);
    });
  }, [back]);

  const words = WORDS[status];
  return (
    <View style={styles.ground}>
      <CenteredScroll testID="github-callback-page">
        <View style={styles.wrap}>
          <Text role="heading" aria-level={1} style={styles.title}>
            {words.title}
          </Text>
          <Text variant="heroSub" role="status" style={styles.sub}>
            {words.line}
          </Text>
        </View>
      </CenteredScroll>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    ground: { flex: 1, backgroundColor: colors.ground },
    wrap: { width: "100%", maxWidth: 520, marginHorizontal: "auto", paddingHorizontal: 28, paddingVertical: 56 },
    title: { fontFamily: fonts.display, fontWeight: "500", color: colors.text, fontSize: t.title, lineHeight: leading(t.title, 1.1) },
    sub: { marginTop: 14, fontSize: t.body, lineHeight: leading(t.body, 1.55) },
  });
