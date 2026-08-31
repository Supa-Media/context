/**
 * `/s/<token>` — the page a shared link actually opens.
 *
 * Deliberately **not** under the `(app)` group, for exactly the reason
 * `/invite/<token>` is not: that group's gate bounces a signed-out visitor to a
 * bare `/login`, and this token exists in one message and nowhere else. There
 * is no rail entry that could reproduce it, so losing it loses the share. This
 * screen owns its gate so it can send people to `/login?next=/s/<token>` and
 * bring them back to the note.
 *
 * ## What the reader is allowed to learn
 *
 * The note, and the notes it links to. Nothing else about the context exists
 * from here — no listing, no search, no path guessing — and **every refusal is
 * the same screen**. Revoked, expired, addressed to somebody else, note made
 * private, target not linked: the server answers all of them with one
 * `SHARE_UNAVAILABLE`, and `resolveShareView` must not undo that by inferring a
 * reason. Somebody who can tell "revoked" from "made private" has learned two
 * things about a context they are not in.
 *
 * ## Why the note is fetched with an action rather than a query
 *
 * `readSharedNote` reads the owner's bucket through the credential barrier, so
 * it is a Convex *action* and has no subscription. That means no live updates —
 * a note edited while somebody is reading it does not change under them — which
 * is the right behaviour anyway for a document somebody was handed.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useAction, useConvexAuth } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../design/components/Button";
import { Card } from "../design/components/Card";
import { CenteredScroll } from "../design/components/CenteredScroll";
import { StageBackdrop } from "../design/components/StageBackdrop";
import { Text } from "../design/components/Text";
import { radii } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { NoteBody } from "./NoteBody";
import { noteTitle, parseNote } from "./markdown";
import {
  firstParam,
  linkLabel,
  onwardLinks,
  resolveShareView,
  shareHref,
  type ShareResult,
  type SharedNote,
} from "./share";

export function ShareScreen() {
  const styles = useThemedStyles(makeStyles);
  const params = useLocalSearchParams<{ token?: string | string[]; path?: string | string[] }>();
  const token = firstParam(params.token);
  const requestedPath = firstParam(params.path);
  const auth = useConvexAuth();
  const router = useRouter();

  const readSharedNote = useAction(api.functions.shares.readSharedNote);
  const [note, setNote] = useState<ShareResult>(undefined);

  useEffect(() => {
    if (!auth.isAuthenticated || token === null) return;
    let cancelled = false;
    // Reset to `undefined` so navigating between linked notes shows the loading
    // state rather than the previous note's text under the new one's heading.
    setNote(undefined);
    readSharedNote({ token, ...(requestedPath === null ? {} : { path: requestedPath }) })
      .then((result) => {
        if (!cancelled) setNote(result as SharedNote);
      })
      .catch((error: unknown) => {
        // Every refusal is one screen. The error's own code is deliberately not
        // read: the server made them indistinguishable and this must not
        // reconstruct the difference.
        if (!cancelled) setNote(error instanceof Error ? error : new Error("unavailable"));
      });
    return () => {
      cancelled = true;
    };
  }, [auth.isAuthenticated, readSharedNote, requestedPath, token]);

  const view = resolveShareView({ token, auth, note, requestedPath });

  const open = useCallback(
    (path: string) => {
      if (token === null) return;
      router.push(shareHref(token, path));
    },
    [router, token],
  );

  const backToEntry = useCallback(() => {
    if (token === null) return;
    router.push(shareHref(token));
  }, [router, token]);

  if (view.kind === "wait") return <View style={styles.ground} />;
  if (view.kind === "signIn") return <Redirect href={view.href} />;

  return (
    <View style={styles.ground} testID="share-page">
      <StageBackdrop />
      <CenteredScroll>
        {view.kind === "loading" ? <Loading /> : null}
        {view.kind === "unavailable" ? <Unavailable /> : null}
        {view.kind === "ready" ? (
          <Note
            note={view.note}
            awayFromEntry={view.awayFromEntry}
            onOpen={open}
            onBack={backToEntry}
          />
        ) : null}
      </CenteredScroll>
    </View>
  );
}

function Loading() {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  return (
    <Card>
      <View style={styles.centered}>
        <ActivityIndicator color={colors.muted} />
        <Text variant="meta">Opening the note…</Text>
      </View>
    </Card>
  );
}

/**
 * One screen for every refusal.
 *
 * The copy says what the reader can do — ask the person who sent it — and
 * nothing about which of the six reasons applies, because the server
 * deliberately does not know either by the time it answers.
 */
function Unavailable() {
  const styles = useThemedStyles(makeStyles);
  return (
    <Card>
      <View style={styles.unavailable}>
        <Text variant="paneTitle" role="heading" aria-level={1}>
          This note is not available
        </Text>
        <Text variant="paneSub">
          The link may have been taken back, or it may have been shared with a
          different account than the one you are signed in with. Ask whoever sent
          it to share it again.
        </Text>
      </View>
    </Card>
  );
}

function Note({
  note,
  awayFromEntry,
  onOpen,
  onBack,
}: {
  note: SharedNote;
  awayFromEntry: boolean;
  onOpen: (path: string) => void;
  onBack: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const parsed = useMemo(() => parseNote(note.text), [note.text]);
  // The note's own H1 if it has one, and the filename otherwise — a reader
  // wants the document's name, not a path.
  const title = noteTitle(parsed.blocks) ?? linkLabel(note.path);
  // …and if the title came *from* the note's first heading, that heading is
  // dropped from the body. Otherwise the page says the same words twice, one
  // above the other, which is what a screenshot showed.
  const body = useMemo(
    () =>
      noteTitle(parsed.blocks) === null ? parsed.blocks : parsed.blocks.slice(1),
    [parsed.blocks],
  );
  const links = onwardLinks(note);

  return (
    <View style={styles.note}>
      {awayFromEntry ? (
        <Pressable onPress={onBack} accessibilityRole="button" style={styles.back}>
          <Text variant="meta">← {linkLabel(note.entryPath)}</Text>
        </Pressable>
      ) : null}

      <Card>
        <View style={styles.head}>
          <Text variant="eyebrow">SHARED WITH YOU</Text>
          <Text variant="paneTitle" role="heading" aria-level={1}>
            {title}
          </Text>
        </View>

        <NoteBody blocks={body} />

        {parsed.truncated ? (
          <Text variant="meta" style={styles.truncated}>
            This note is longer than what is shown here.
          </Text>
        ) : null}
      </Card>

      {links.length > 0 ? (
        <Card>
          <View style={styles.links}>
            <Text variant="eyebrow">ALSO SHARED WITH YOU</Text>
            <Text variant="paneSub">
              The notes this one links to. Everything else in this context stays
              private.
            </Text>
            <View style={styles.linkList}>
              {links.map((path) => (
                <Button key={path} label={linkLabel(path)} onPress={() => onOpen(path)} />
              ))}
            </View>
          </View>
        </Card>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  ground: { flex: 1, backgroundColor: colors.ground },
  centered: { alignItems: "center", gap: 12, paddingVertical: 24 },
  unavailable: { gap: 10 },
  note: { gap: 14, width: "100%" },
  back: { alignSelf: "flex-start", paddingVertical: 6, paddingHorizontal: 2 },
  head: { gap: 6, marginBottom: 14 },
  truncated: { marginTop: 14 },
  links: { gap: 10 },
  linkList: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  card: { borderRadius: radii.xl },
});
