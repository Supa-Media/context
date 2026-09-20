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
import { noteHref } from "../console/nav";
import { NoteBody } from "./NoteBody";
import { noteTitle, parseNote } from "./markdown";
import {
  firstParam,
  shortLinkHref,
  shareTokenFromSegment,
  linkLabel,
  onwardLinks,
  resolveShareView,
  shareHref,
  type ShareResult,
  type SharedNote,
  type ShortLinkAddress,
} from "./share";

/**
 * The same page at two addresses.
 *
 * `/s/<segment>` carries the token; `/@seyi/intake` carries a name the server
 * resolves to the same share row and **does not** hand back. So the screen is
 * parameterised by which address it was opened at rather than duplicated: one
 * view-resolution, one uniform refusal, one set of onward links. A second copy
 * of this screen reachable by a guessable address is precisely the copy that
 * would drift in the wrong direction.
 */
export function ShareScreen({ shortLink }: { shortLink?: ShortLinkAddress } = {}) {
  const styles = useThemedStyles(makeStyles);
  const params = useLocalSearchParams<{ token?: string | string[]; path?: string | string[] }>();
  // The URL segment as the reader has it — `Chapter-transition-<64 hex>`, or a
  // bare token on a link minted before slugs existed. The segment is what
  // onward navigation is built from, so the readable URL survives following a
  // link inside the share; the token is what the server is asked with.
  const segment = firstParam(params.token);
  const token = segment === null ? null : shareTokenFromSegment(segment);
  const requestedPath = firstParam(params.path);
  const auth = useConvexAuth();
  const router = useRouter();

  const readSharedNote = useAction(api.functions.shares.readSharedNote);
  const readShortLink = useAction(api.functions.shares.readShortLink);
  const [note, setNote] = useState<ShareResult>(undefined);

  /** The URL to come back to, at whichever address this page was opened. */
  const hrefFor = useCallback(
    (path?: string) => {
      if (shortLink !== undefined) return shortLinkHref(shortLink, path);
      return segment === null ? null : shareHref(segment, path);
    },
    [segment, shortLink],
  );

  useEffect(() => {
    // Not gated on being *authenticated* — an unlisted link's reader never is,
    // and `share.ts` records why the server is what decides that. Gated on auth
    // having settled, so a signed-in recipient's first request is not sent
    // anonymously and bounced to a sign-in they have already done.
    if (auth.isLoading) return;
    if (token === null && shortLink === undefined) return;
    let cancelled = false;
    // Reset to `undefined` so navigating between linked notes shows the loading
    // state rather than the previous note's text under the new one's heading.
    setNote(undefined);
    const pathArg = requestedPath === null ? {} : { path: requestedPath };
    // One of the two, never both: a short link's token is resolved on the
    // server and never reaches this screen, so there is nothing here that
    // could fall back to the token call.
    const request =
      shortLink !== undefined
        ? readShortLink({ handle: shortLink.handle, slug: shortLink.slug, ...pathArg })
        : readSharedNote({ token: token as string, ...pathArg });
    request
      .then((result) => {
        if (!cancelled) setNote(result as SharedNote);
      })
      .catch((error: unknown) => {
        // The error is carried through as it arrived, rather than flattened
        // here, because `resolveShareView` reads exactly one code off it —
        // `NOT_AUTHENTICATED`, which is a fact about the reader's own session.
        // Every other refusal is one screen: the server made them
        // indistinguishable and nothing downstream may reconstruct the
        // difference. A non-`Error` throw becomes a bare one, which
        // `isNotAuthenticated` correctly declines to recognise.
        if (!cancelled) setNote(error instanceof Error ? error : new Error("unavailable"));
      });
    return () => {
      cancelled = true;
    };
    // `isAuthenticated` is a dependency as well as `isLoading`: signing in
    // mid-view must re-ask (the anonymous answer was the narrower one), and
    // signing out must re-ask rather than leave a stale note in state.
  }, [
    auth.isAuthenticated,
    auth.isLoading,
    readSharedNote,
    readShortLink,
    requestedPath,
    shortLink,
    token,
  ]);

  // `token` rather than `segment`: a segment whose tail is not a token is not a
  // share link at all, and it must reach the same screen a spent one does
  // rather than a different one — the rule this page is built around.
  const view = resolveShareView({
    token,
    auth,
    note,
    requestedPath,
    segment,
    ...(shortLink === undefined ? {} : { shortLink }),
  });

  const open = useCallback(
    (path: string) => {
      const href = hrefFor(path);
      if (href === null) return;
      router.push(href);
    },
    [hrefFor, router],
  );

  const backToEntry = useCallback(() => {
    const href = hrefFor();
    if (href === null) return;
    router.push(href);
  }, [hrefFor, router]);

  /**
   * Leave the share page for the console, where the note is editable.
   *
   * `push` rather than `replace`: the reader arrived on a link somebody sent
   * them and Back has to still work. `noteHref` is the console's own builder,
   * so the two cannot disagree about what a note URL looks like.
   */
  const edit = useCallback(
    (slug: string, path: string) => {
      // The slug undecorated: `noteHref` runs it through `contextSegment`,
      // which is what puts the `@` on. Adding one here would be a second
      // helper doing the same job.
      router.push(noteHref(slug, path));
    },
    [router],
  );

  if (view.kind === "wait") return <View style={styles.ground} />;
  if (view.kind === "signIn") return <Redirect href={view.href} />;

  return (
    <View style={styles.ground} testID="share-page">
      <StageBackdrop />
      <CenteredScroll>
        {view.kind === "loading" ? <Loading /> : null}
        {view.kind === "unavailable" ? <Unavailable /> : null}
        {view.kind !== "ready" ? null : view.note.kind === "folder" ? (
          <Folder
            note={view.note}
            awayFromEntry={view.awayFromEntry}
            onOpen={open}
            onBack={backToEntry}
          />
        ) : (
          <Note
            note={view.note}
            awayFromEntry={view.awayFromEntry}
            onOpen={open}
            onBack={backToEntry}
            onEdit={edit}
          />
        )}
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

/**
 * A shared folder: what is directly inside it, and a way in.
 *
 * ## Why this is a list and not a rendered document
 *
 * A folder has no body. The page a reader wants is the one Drive and Dropbox
 * give them — the names, each openable, subfolders enterable — and every entry
 * here has already been through the privacy engine at `team` scope on the
 * server, so what is drawn is exactly what may be read. There is no filtering
 * in this component and there must not be: a second place deciding what a
 * reader sees is a second place for it to be wrong.
 *
 * ## An empty folder says so
 *
 * A subfolder whose every note is private lists nothing, and so does one that
 * genuinely holds nothing. The server serves both as an empty listing on
 * purpose — refusing on emptiness would tell a reader that a folder they can
 * see the name of has something inside they may not read — so this says "nothing
 * here", which is true of both and claims neither.
 *
 * No edit affordance, deliberately. `editableInContext` names a note the reader
 * may edit in their own console; a folder is not a document and there is
 * nothing to open in an editor.
 */
function Folder({
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
  const folders = note.entries.filter((entry) => entry.kind === "folder");
  const files = note.entries.filter((entry) => entry.kind === "file");

  return (
    <View style={styles.note}>
      {awayFromEntry ? (
        <Pressable onPress={onBack} accessibilityRole="button" style={styles.back}>
          <Text variant="meta">← {linkLabel(note.entryPath)}</Text>
        </Pressable>
      ) : null}

      <Card>
        <View style={styles.head}>
          <Text variant="eyebrow">
            {note.openToAnyone ? "SHARED BY LINK" : "SHARED WITH YOU"}
          </Text>
          <Text variant="paneTitle" role="heading" aria-level={1}>
            {linkLabel(note.path)}
          </Text>
        </View>

        {note.entries.length === 0 ? (
          <Text variant="paneSub" testID="share-folder-empty">
            Nothing here.
          </Text>
        ) : (
          <View testID="share-folder-entries">
            {/* Folders first, then notes — the order a file browser uses. */}
            {[...folders, ...files].map((entry) => (
              <Pressable
                key={entry.path}
                onPress={() => onOpen(entry.path)}
                accessibilityRole="link"
                accessibilityLabel={entry.name}
                testID={`share-folder-entry-${entry.path}`}
                style={styles.back}
              >
                <Text variant="paneSub">
                  {entry.kind === "folder" ? `${entry.name}/` : linkLabel(entry.path)}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </Card>
    </View>
  );
}

function Note({
  note,
  awayFromEntry,
  onOpen,
  onBack,
  onEdit,
}: {
  note: SharedNote;
  awayFromEntry: boolean;
  onOpen: (path: string) => void;
  onBack: () => void;
  onEdit: (slug: string, path: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  /*
    `?? ""` and not a cast. `text` is null only for a folder, and a folder is
    rendered by `Folder` above — but a component that threw on the impossible
    case would take the whole page down over a server that grew a third kind,
    and an empty document is the failure a reader can act on.
  */
  const parsed = useMemo(() => parseNote(note.text ?? ""), [note.text]);
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
          {/*
            Says which kind of link this is, because the two are read
            differently. Somebody sent an unlisted link is holding something
            forwardable, and a page that let them assume otherwise would be the
            product being quiet about the one thing about it that matters.
          */}
          <Text variant="eyebrow">
            {note.openToAnyone ? "SHARED BY LINK" : "SHARED WITH YOU"}
          </Text>
          <Text variant="paneTitle" role="heading" aria-level={1}>
            {title}
          </Text>
          {/*
            This page is read-only by construction — it draws rendered markdown
            and there is no write action anywhere in the feature. That is right
            for the person a link was sent to and wrong for the person who
            *wrote* the note and opened their own link, for whom it is their own
            document behind glass.

            So the way out is offered only to a reader whose own membership
            already lets them edit, decided by the server (`editableInContext`)
            and never here — a client that worked out for itself who may edit
            would be a second place for that answer to be wrong, and the
            direction it would fail is naming somebody else's context to a
            stranger holding a link.
          */}
          {note.editableInContext === null ? (
            <Text variant="meta" testID="share-read-only">
              You are reading a shared copy. It cannot be edited here.
            </Text>
          ) : (
            <Pressable
              onPress={() => onEdit(note.editableInContext!, note.path)}
              accessibilityRole="link"
              testID="share-edit"
            >
              <Text variant="meta">Open in your console to edit →</Text>
            </Pressable>
          )}
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
