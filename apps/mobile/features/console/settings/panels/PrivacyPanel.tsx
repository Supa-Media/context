import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, PressRow } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { Hint } from "../../../design/components/Field";
import { Icon } from "../../../design/components/Icon";
import { Notice } from "../../../design/components/Input";
import { Pill } from "../../../design/components/Pill";
import { Text } from "../../../design/components/Text";
import { radii } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import type { FileBrowser } from "../../files/browser";
import type { Visibility } from "../../files/types";
import {
  folderControl,
  privacyViewOf,
  type PrivacyFolderRow,
  type PrivacyFolderView,
} from "../../privacy/map";
import {
  BROKEN_MANIFEST_HEADLINE,
  brokenManifestNext,
  contextKindOf,
  exceptionLine,
  filteredViewLine,
  folderDefaultLine,
  linkExceptionLine,
  manifestFootLine,
  noExceptionsLine,
  privateMeans,
  teamMeans,
  truncatedLine,
  visibilityWord,
  widenWarning,
} from "../../privacy/words";
import { selectedContext, type ConsoleData } from "../../types";
import { useArming } from "../../useArming";
import { isFilteredView, memberReachSentence, tierExplanation } from "../../visibility";
import { settingsSectionLabel } from "../sections";

/**
 * What is private by default, folder by folder.
 *
 * ## Why this section exists at all
 *
 * The privacy manifest decides who can read everything in a context, and until
 * now the only way to it was a marker in the file tree and a banner on a note
 * — which is to say, you found it while looking at one file, or you never
 * found it. This is the same facts, at the one address somebody looks when
 * their question is "who can see my notes": a settings section, findable by
 * typing `private`, `who can see`, or `hide`.
 *
 * ## What it is allowed to be
 *
 * A **window onto the privacy engine**, never a second opinion about it. Every
 * visibility drawn here arrived on a `FolderListing` the server computed at
 * this caller's own scope; `features/console/privacy/map.ts` reshapes it and
 * this file draws it. Nothing here parses `privacy.md`, evaluates a rule, or
 * fills in a folder the server did not send — a folder held back from this
 * reader is absent from the listing and therefore absent from the panel, which
 * is what keeps a member's copy of this screen from becoming the census of
 * private folders the console is owner-only to prevent.
 *
 * ## The one control, and why it is armed one way round
 *
 * A folder's default is the most consequential press in the product: sharing
 * one hands every note in it that is not held back by name to everybody on
 * People. The tree offers it too, on a right-click and an inline marker, which
 * is fine for somebody already looking at that folder — but a labelled button
 * in a settings list is pressed by people who are exploring. So the widening
 * direction takes two presses with the consequence spelled out between them
 * (`useArming`, the same control shape as Disconnect), and narrowing stays one
 * — the asymmetry `nextScope` already applies to a note's lock, for the same
 * reason: the expensive mistake is publishing by accident.
 *
 * Owner-only, absent rather than disabled, from `files.canSetVisibility`.
 * `run` in `useFileBrowser` silently does nothing on a console that cannot
 * edit, so a button drawn on the landing page's demo would look like it worked
 * and change nothing.
 *
 * ## What it deliberately does not do
 *
 * No counts. Nothing the console can reach counts the notes a folder holds,
 * and a total over a filtered listing is the subtraction that hands a member
 * an exact tally of what is being kept from them. No repair button for a
 * broken manifest either: that control exists once, in Browse, and a second
 * copy of the one operation that rewrites the whole access map is a second
 * thing to keep honest. This says which state the reader is in.
 */
export function PrivacyPanel({
  data,
  /** True on the old single-scroll pane, where this block has a heading above it. */
  inline,
}: {
  data: ConsoleData;
  inline: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const files = data.files;
  const current = selectedContext(data);
  const kind = contextKindOf(current?.kind);
  const role = current?.role;

  /**
   * The folders opened *here*, separate from the tree's own `expanded`.
   *
   * Reading the rules must not rearrange the file tree behind the overlay: a
   * person who opens six folders to read their defaults should not return to
   * Browse to find their tree unfolded. `ensureListing` is the browser method
   * for exactly this — it fetches a listing into the cache without selecting
   * or expanding anything.
   */
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());

  /**
   * Which paths have already been asked for, per context.
   *
   * `ensureListing` is a no-op once a listing has landed, but a fetch that
   * *failed* leaves the entry undefined — so without this, every re-render
   * that changed `listings` would ask again for a folder the store keeps
   * refusing. Keyed by context because the listings map is emptied when the
   * context changes, and a stale key would mean the new context's root is
   * never asked for.
   */
  const asked = useRef<Set<string>>(new Set());
  const contextId = files.contextId;
  /*
    Typed as possibly absent, and it is not a formality.

    The whole-scroll pane renders every block, and several suites mount it over
    a `ConsoleData` stub carrying only the half their own subject needs — a
    `files` of `{ listings: {} }`, cast past the type. `MembersSection`'s
    `shareBackWith` in this same pane is defensive for exactly that reason, and
    it is the right shape here too: a browser with nothing to fetch from is
    "there is nothing to ask", not a crash in a section that test is not about.
    The listings such a stub does carry still render.
  */
  const ensureListing: FileBrowser["ensureListing"] | undefined = files.ensureListing;
  const ask = useCallback(
    (path: string) => {
      if (contextId === null || ensureListing === undefined) return;
      const key = `${contextId}:${path}`;
      if (asked.current.has(key)) return;
      asked.current.add(key);
      ensureListing(path);
    },
    [contextId, ensureListing],
  );

  /* A context switch closes what was open and forgets what was asked. */
  useEffect(() => {
    asked.current = new Set();
    setOpened(new Set());
  }, [contextId]);

  /*
    The root is loaded by `useFileBrowser` on every context change, so this is
    belt and braces — for the case where that load failed and settings is the
    surface somebody reached for next.
  */
  useEffect(() => {
    ask("");
  }, [ask]);

  const toggle = useCallback(
    (path: string) => {
      ask(path);
      setOpened((current) => {
        const next = new Set(current);
        if (!next.delete(path)) next.add(path);
        return next;
      });
    },
    [ask],
  );

  /*
    `?? {}` for the same reason `ensureListing` is optional above: a stub
    browser that carries no listings at all is a section with nothing to draw,
    which is `loading`, not a crash.
  */
  const listings = files.listings ?? {};
  const root = privacyViewOf(listings, "");
  /*
    The owner's half and the reader's half of the same fact — exactly one of
    the two is ever non-null, by construction in `visibility.ts`, and a role
    that has not loaded yet gets neither rather than a guess.
  */
  const reach = tierExplanation(role) ?? memberReachSentence(role);

  return (
    <View>
      <Text
        variant={inline ? "eyebrow" : "paneTitle"}
        style={inline ? styles.sectionHeadLater : styles.sectionHead}
      >
        {settingsSectionLabel("privacy")}
      </Text>
      <Text variant="paneSub" style={styles.sectionSub}>
        What is private by default, folder by folder. Two words decide it, and neither of
        them is public — nothing here is on the internet, and nothing here is indexed.
      </Text>

      <Card>
        <Row style={styles.meaningRow}>
          <VisibilityPill visibility="private" />
          <Grow>
            <Text variant="rowSub">{privateMeans(kind)}</Text>
          </Grow>
        </Row>
        <Row style={StyleSheet.flatten([styles.meaningRow, styles.meaningRowLater])} divided>
          <VisibilityPill visibility="team" />
          <Grow>
            <Text variant="rowSub">{teamMeans(kind)}</Text>
          </Grow>
        </Row>
        <Hint style={styles.hint}>
          <Text variant="hint">{linkExceptionLine()}</Text>
        </Hint>
      </Card>

      {reach === null ? null : (
        <Text variant="foot" style={styles.foot}>
          {reach}
        </Text>
      )}

      <Text variant="eyebrow" style={styles.sectionHeadLater}>
        Folder by folder
      </Text>
      <Text variant="paneSub" style={styles.sectionSub}>
        {files.canSetVisibility
          ? "A folder's default governs every note in it that is not named on its own line. Open one to see what is inside it."
          : "A folder's default governs every note in it that is not named on its own line. Only an owner of this context can change one."}
      </Text>

      <Card>
        {root.state === "loading" ? (
          <Text variant="rowSub" role="status">
            Reading this context&apos;s rules…
          </Text>
        ) : root.state === "broken" ? (
          <Notice tone="warn" testID="privacy-manifest-broken">
            <Text variant="check">{BROKEN_MANIFEST_HEADLINE}</Text>
            <Text variant="rowSub" style={styles.noticeNext}>
              {brokenManifestNext(files.canResetPrivacy)}
            </Text>
          </Notice>
        ) : (
          <>
            {/*
              The default nothing else names, drawn first because it is the
              answer to "what happens to something I add tomorrow" — and drawn
              as a fact, never a control: `default_visibility` is fixed where
              the manifest is rendered.
            */}
            <Row style={styles.folderRow}>
              <Grow>
                <Text variant="rowTitle">Anything with no rule of its own</Text>
                <Text variant="rowSub" style={styles.rowSub}>
                  {folderDefaultLine(root.folderDefault)}
                </Text>
              </Grow>
              <VisibilityPill visibility={root.folderDefault} />
            </Row>

            {root.folders.map((row) => (
              <FolderBlock
                key={row.path}
                files={files}
                row={row}
                depth={0}
                opened={opened}
                onToggle={toggle}
              />
            ))}

            <Exceptions view={root} />

            {root.truncated ? (
              <Text variant="foot" style={styles.rowSub}>
                {truncatedLine()}
              </Text>
            ) : null}
          </>
        )}
      </Card>

      {isFilteredView(role) ? (
        <Text variant="foot" style={styles.foot}>
          {filteredViewLine()}
        </Text>
      ) : null}
      <Text variant="foot" style={styles.foot}>
        {manifestFootLine()}
      </Text>
    </View>
  );
}

/** A padlock and the word, which are the same state said twice. */
function VisibilityPill({ visibility }: { visibility: Visibility }) {
  const colors = useColors();
  return (
    <Pill
      leading={
        <Icon
          name={visibility === "team" ? "lockOpen" : "lock"}
          size={11}
          color={colors.text2}
        />
      }
    >
      {visibilityWord(visibility)}
    </Pill>
  );
}

/**
 * One folder, and what is inside it once somebody opens it.
 *
 * Its own component because of the arming hook below: a control that has to
 * remember whether it is armed cannot share that state with its siblings, or
 * arming one folder would arm the row beneath it.
 */
function FolderBlock({
  files,
  row,
  depth,
  opened,
  onToggle,
}: {
  files: FileBrowser;
  row: PrivacyFolderRow;
  depth: number;
  opened: ReadonlySet<string>;
  onToggle: (path: string) => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const isOpen = opened.has(row.path);
  const control = folderControl(files.canSetVisibility, row);
  const setVisibility = files.setVisibility;
  const path = row.path;
  const to = control?.to;

  const apply = useCallback(() => {
    if (to === undefined) return;
    setVisibility(path, "folder", to);
  }, [path, setVisibility, to]);
  /*
    Always called, whether or not this row has a control — a hook cannot be
    conditional, and the `arm: false` direction simply never uses it.
  */
  const arming = useArming(apply);

  const inside = privacyViewOf(files.listings ?? {}, row.path);

  return (
    <View>
      <Row
        style={StyleSheet.flatten([styles.folderRow, depth > 0 ? styles.nested : null])}
        divided
      >
        <PressRow
          accessibilityLabel={`${isOpen ? "Close" : "Open"} ${row.name}`}
          onPress={() => onToggle(row.path)}
          radius={radii.md}
          style={styles.disclosure}
          testID={`privacy-folder-${row.path}`}
        >
          <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={13} color={colors.text2} />
        </PressRow>
        <Grow>
          <Text variant="rowTitle">{row.name}</Text>
          <Text variant="rowSub" style={styles.rowSub}>
            {folderDefaultLine(row.visibility)}
          </Text>
        </Grow>
        <VisibilityPill visibility={row.visibility} />
        {control === null ? null : (
          <Button
            label={
              !control.arm
                ? "Make private"
                : arming.stage === "armed"
                  ? "Press again to share"
                  : "Share with team"
            }
            accessibilityLabel={
              control.arm
                ? `Share ${row.name} with everyone on People`
                : `Make ${row.name} private`
            }
            onPress={control.arm ? arming.press : apply}
            testID={`privacy-set-${row.path}`}
          />
        )}
      </Row>
      {control !== null && control.arm && arming.stage === "armed" ? (
        <Hint style={StyleSheet.flatten([styles.hint, depth > 0 ? styles.nested : null])}>
          <Text variant="hint">{widenWarning(row.name)}</Text>
        </Hint>
      ) : null}
      {isOpen ? (
        <View style={styles.children}>
          {inside.state === "loading" ? (
            <Text variant="rowSub" style={styles.nested} role="status">
              Reading {row.name}…
            </Text>
          ) : inside.state === "broken" ? (
            <Text variant="rowSub" style={styles.nested}>
              {BROKEN_MANIFEST_HEADLINE}
            </Text>
          ) : (
            <>
              {inside.folders.map((child) => (
                <FolderBlock
                  key={child.path}
                  files={files}
                  row={child}
                  depth={depth + 1}
                  opened={opened}
                  onToggle={onToggle}
                />
              ))}
              <Exceptions view={inside} nested />
              {inside.truncated ? (
                <Text variant="foot" style={styles.nested}>
                  {truncatedLine()}
                </Text>
              ) : null}
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

/**
 * The notes the manifest names by hand.
 *
 * The other half of what `privacy.md` is, and the half a folder row cannot
 * state. Every other note in the folder follows the default, which is why they
 * are not listed: a marker on every file would draw the defaults twice and
 * bury the exceptions — `FileEntry.exception` is the same rule the tree draws.
 */
function Exceptions({
  view,
  nested = false,
}: {
  view: PrivacyFolderView;
  nested?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  if (view.state !== "ready") return null;
  if (view.exceptions.length === 0) {
    return (
      <Text variant="foot" style={nested ? styles.nested : styles.rowSub}>
        {noExceptionsLine(view.folderDefault)}
      </Text>
    );
  }
  return (
    <>
      {view.exceptions.map((note) => (
        <Row
          key={note.path}
          style={StyleSheet.flatten([styles.folderRow, nested ? styles.nested : null])}
          divided
        >
          <Grow>
            <Text variant="rowTitle">{note.name}</Text>
            <Text variant="rowSub" style={styles.rowSub}>
              {exceptionLine(note)}
            </Text>
          </Grow>
          <VisibilityPill visibility={note.visibility} />
        </Row>
      ))}
    </>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  sectionHead: { marginBottom: 4 },
  sectionHeadLater: { marginTop: 30, marginBottom: 4 },
  sectionSub: { marginBottom: 12, maxWidth: 546 },
  meaningRow: { alignItems: "flex-start", flexWrap: "wrap" },
  meaningRowLater: { marginTop: 10 },
  folderRow: { flexWrap: "wrap" },
  rowSub: { marginTop: 2 },
  hint: { marginTop: 12 },
  foot: { marginTop: 12, maxWidth: 546 },
  noticeNext: { marginTop: 4 },
  /** The disclosure triangle, sized as a target rather than as a glyph. */
  disclosure: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  children: { borderLeftWidth: 1, borderLeftColor: colors.line, marginLeft: 11 },
  nested: { paddingLeft: 13 },
});
