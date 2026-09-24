/**
 * Who can read this note, and everything you can do about it, in one sheet.
 *
 * ## The shape is Google Docs', on purpose
 *
 * A title, one field, the people who have it, one line for everybody else,
 * and Copy link beside Done. The owner put this dialog next to Docs' and
 * asked why sharing there is easy; the answer was that Docs shows state and
 * this showed explanations — five paragraphs, six uppercase headings, a code
 * font in the field, and a bordered button on every row. People read none of
 * it and could not find the control they came for.
 *
 * Nothing it could do has gone. The rarer things moved to where rare things
 * go: each person's actions into their row's menu, the workspace link and
 * encryption behind the header's menu, and the long explanations into "How
 * sharing works" there. What still has to be said — that a person signs in and
 * gets the notes this links to, that a public link needs no account — is said
 * once, at the moment it applies, in `shareDialog/copy.ts`.
 *
 * ## Menus live inside this modal
 *
 * Every menu is drawn by `ShareMenu`, as a sibling of the card inside this
 * one `Modal`: a popover under its trigger on a pointer layout, a sheet on a
 * phone. The app's `Menu` portals to the page, which a modal paints over on
 * the web, and opens a second native modal on iOS, which is a known problem.
 *
 * ## Nothing here decides authorization
 *
 * Whether this dialog can be reached at all is `canShare` in `capabilities.ts`
 * (owner-only), and the server refuses anyone else. Every optional callback
 * follows the console's standing rule: a control somebody may not use is
 * **absent, not disabled**.
 */

import { useRef, useState } from "react";
import { Modal, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { useColors, useThemedStyles } from "../../design/theme";
import { densityFor } from "../../app/frame";
import { baseName, folderLabel } from "./paths";
import { accessRows } from "./access";
import { noMatchHint, recipientsFor } from "./recipients";
import { isGroupVisibility } from "./types";
import { scopeOf } from "./scope";
import { sharesFor } from "./shares";
import { displayName } from "./shareDialog/copy";
import { GeneralAccess } from "./shareDialog/GeneralAccess";
import { HowSharingWorks } from "./shareDialog/HowSharingWorks";
import { LinkOptions } from "./shareDialog/LinkOptions";
import { moreItems } from "./shareDialog/moreItems";
import { isPersonShare, PeopleSection, type ShowMenu } from "./shareDialog/PeopleSection";
import type { CopyTarget, ShareDialogProps } from "./shareDialog/props";
import { RecipientPicker } from "./shareDialog/RecipientPicker";
import { ShareMenu, type MenuAnchor, type ShareMenuItem } from "./shareDialog/ShareMenu";
import { makeStyles } from "./shareDialog/styles";

type OpenMenu = { id: string; title?: string; items: ShareMenuItem[]; anchor: MenuAnchor | null };

export function ShareDialog({
  path,
  shares,
  origin,
  onShare,
  onCopyLink,
  onRevoke,
  onSetSlug,
  onSetCollecting,
  onSetPreviewTitle,
  onClose,
  advanced,
  access,
  onShareWithGroup,
  onRemovalRoute,
  onCreateGroup,
  groupSlug,
  entryKind = "file",
  onSetScope,
  groups,
  context = { slug: null, kind: null, viewerIsOwner: true },
}: ShareDialogProps) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  /*
    `densityFor` rather than a width of this file's own: the width at which a
    popover becomes a sheet is the width at which the app stops being a
    pointer layout, and it is one threshold named once.
  */
  const view = useWindowDimensions();
  const compact = densityFor(view.width) === "compact";
  const [recipient, setRecipient] = useState("");
  /**
   * What went wrong with the last copy, or `null`. Carries the URL when the
   * clipboard refused, because the clipboard is the only part that failed and
   * the person still wants the link.
   */
  const [problem, setProblem] = useState<string | null>(null);
  const [making, setMaking] = useState<{ label: string; picked: string[] } | null>(null);
  const [makeProblem, setMakeProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [help, setHelp] = useState(false);

  /*
    Open at once, then move under the trigger once it has been measured.
    `measureInWindow` answers asynchronously on every host, and a menu that
    waited for it would answer a press a frame late.
  */
  const showMenu: ShowMenu = (spec, measure) => {
    setMenu({ ...spec, anchor: null });
    measure((anchor) =>
      setMenu((current) => (current?.id === spec.id ? { ...current, anchor } : current)),
    );
  };

  /**
   * Copy, and get out of the way. A copy changes nothing on screen, so it is
   * confirmed by the pane's notice line, which outlives this dialog. A failed
   * copy keeps the dialog open, because the notice it raises carries the URL.
   */
  const copyAndClose = (target: CopyTarget) => {
    setProblem(null);
    void onCopyLink(target).then(({ ok, message }) => {
      if (ok) {
        onClose();
        return;
      }
      setProblem(message);
    });
  };

  const mine = sharesFor(shares, path);
  const openLink = mine?.find((share) => share.audience === "anyone");
  /*
    Which link a short name attaches to: the unlisted link first, because
    that is the one people paste where a memorable URL matters, and the
    workspace link otherwise.
  */
  const namedLink = openLink ?? mine?.find((share) => share.audience === "members");

  const group =
    access !== undefined && isGroupVisibility(access.visibility)
      ? groups?.find((entry) => `@${entry.name}` === access.visibility)
      : undefined;
  /*
    Who this note reaches, computed ONCE and read by the list, the members
    line and the suggestions, so the three cannot disagree about who has it.
  */
  const rows =
    access === undefined
      ? []
      : accessRows(access.visibility, access.exception, access.members, entryKind, group?.liveCount);
  const reachingUserIds = new Set(rows.filter((row) => row.role !== "group").map((row) => row.key));
  const reachingGroups =
    access !== undefined && isGroupVisibility(access.visibility)
      ? new Set([access.visibility.slice(1)])
      : undefined;
  const suggestions = recipientsFor(recipient, access?.members ?? [], groups ?? [], {
    reachingUserIds,
    reachingGroups,
  });
  const emptyHint = suggestions.length === 0 ? noMatchHint(recipient) : undefined;
  const submit = () => {
    if (recipient.trim() === "") return;
    onShare(recipient.trim());
    setRecipient("");
  };

  const owners = (access?.members ?? []).filter((member) => member.role === "owner");
  const people = (mine ?? []).filter(isPersonShare).length;
  const scope = access === undefined ? "private" : scopeOf(access.visibility, openLink !== undefined);
  const raw = folderLabel(baseName(path));
  const name = displayName(raw);

  const linkOptions = (
    <LinkOptions
      entryKind={entryKind}
      context={context}
      compact={compact}
      openLink={openLink}
      namedLink={namedLink}
      indented={access !== undefined}
      onSetCollecting={onSetCollecting}
      onSetSlug={onSetSlug}
    />
  );

  const more = moreItems({
    path,
    openLink,
    advanced: advanced?.action,
    help,
    copyAndClose,
    onRevoke,
    onSetPreviewTitle,
    onToggleHelp: () => setHelp((open) => !open),
  });

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose} visible>
      <View style={{ flex: 1 }}>
        <Pressable
          style={[
            styles.scrim,
            compact ? styles.scrimSheet : { paddingTop: Math.round(view.height * 0.12) },
          ]}
          accessibilityLabel="Close"
          onPress={onClose}
        >
          <Pressable
            style={[styles.card, compact && styles.sheet]}
            onPress={() => {}}
            accessibilityLabel={`Share ${raw}`}
          >
            {compact ? <View style={styles.handle} aria-hidden /> : null}
            <ScrollView
              style={[styles.body, { maxHeight: Math.round(view.height * (compact ? 0.72 : 0.7)) }]}
              contentContainerStyle={[styles.bodyContent, compact && styles.bodyContentCompact]}
              keyboardShouldPersistTaps="handled"
            >
              <View style={styles.head}>
                <Text
                  role="heading"
                  aria-level={2}
                  numberOfLines={1}
                  style={[styles.title, compact && styles.titleCompact]}
                >
                  {`Share “${name}”`}
                </Text>
                {more.length === 0 ? null : (
                  <MoreButton
                    open={menu?.id === "more"}
                    onOpen={(measure) =>
                      showMenu({ id: "more", title: `More for ${name}`, items: more }, measure)
                    }
                  />
                )}
              </View>

              <RecipientPicker
                compact={compact}
                recipient={recipient}
                setRecipient={setRecipient}
                submit={submit}
                onShare={onShare}
                onShareWithGroup={onShareWithGroup}
                onCreateGroup={onCreateGroup}
                groupSlug={groupSlug}
                access={access}
                making={making}
                setMaking={setMaking}
                makeProblem={makeProblem}
                setMakeProblem={setMakeProblem}
                emptyHint={emptyHint}
                suggestions={suggestions}
              />

              <PeopleSection
                owners={owners}
                groupRow={rows.find((row) => row.role === "group")}
                groupCount={group?.liveCount}
                shares={mine}
                origin={origin}
                compact={compact}
                menuId={menu?.id ?? null}
                showMenu={showMenu}
                copyAndClose={copyAndClose}
                onRevoke={onRevoke}
                onSetPreviewTitle={onSetPreviewTitle}
                onRemovalRoute={onRemovalRoute}
              />

              {access === undefined ? (
                linkOptions
              ) : (
                <GeneralAccess
                  path={path}
                  name={name}
                  access={access}
                  scope={scope}
                  entryKind={entryKind}
                  context={context}
                  compact={compact}
                  memberRows={rows.filter((row) => row.role !== "owner" && row.role !== "group")}
                  people={people}
                  confirming={confirming}
                  setConfirming={setConfirming}
                  menuId={menu?.id ?? null}
                  showMenu={showMenu}
                  onSetScope={onSetScope}
                  onRemovalRoute={onRemovalRoute}
                >
                  {linkOptions}
                </GeneralAccess>
              )}

              {help ? <HowSharingWorks entryKind={entryKind} compact={compact} /> : null}
            </ScrollView>

            {problem === null ? null : (
              <Text variant="meta" style={styles.problem} testID="share-copy-problem" selectable>
                {problem}
              </Text>
            )}

            {confirming ? (
              <View style={{ height: compact ? 34 : 16 }} />
            ) : (
              <View style={[styles.foot, compact && styles.footCompact]}>
                {/*
                  One Copy link, and it copies the link that works for whoever
                  it is sent to: the public link when there is one, the
                  workspace link otherwise. The old sheet had a Copy link per
                  kind of link, and the one within reach of somebody who had
                  just gone public copied the one that showed their reader
                  nothing.
                */}
                <Pressable
                  accessibilityLabel="Copy link"
                  testID={openLink === undefined ? "share-copy-link" : "share-open-link"}
                  style={[styles.footButton, compact && styles.footButtonCompact]}
                  onPress={() => copyAndClose({ kind: openLink === undefined ? "team" : "link", path })}
                >
                  <Icon name="link" size={16} color={colors.text} />
                  <Text style={[styles.footLabel, compact && styles.footLabelCompact]}>Copy link</Text>
                </Pressable>
                <Pressable
                  accessibilityLabel="Done"
                  role="button"
                  testID="share-done"
                  style={[styles.footButton, styles.footPrimary, compact && styles.footButtonCompact]}
                  onPress={onClose}
                >
                  <Text style={[styles.footLabel, styles.footPrimaryLabel, compact && styles.footLabelCompact]}>
                    Done
                  </Text>
                </Pressable>
              </View>
            )}
          </Pressable>
        </Pressable>

        {menu === null ? null : (
          <ShareMenu
            items={menu.items}
            anchor={menu.anchor}
            compact={compact}
            title={menu.title}
            testID={`share-menu-${menu.id}`}
            onClose={() => setMenu(null)}
          />
        )}
        {advanced?.overlay}
      </View>
    </Modal>
  );
}

function MoreButton({
  open,
  onOpen,
}: {
  open: boolean;
  onOpen: (measure: (done: (anchor: MenuAnchor) => void) => void) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const ref = useRef<View>(null);
  return (
    <Pressable
      ref={ref}
      accessibilityLabel="More sharing options"
      aria-haspopup="menu"
      aria-expanded={open}
      testID="share-more"
      style={[styles.iconButton, open && styles.iconButtonOn]}
      onPress={() =>
        onOpen((done) =>
          ref.current?.measureInWindow((x, y, width, height) => done({ x, y, width, height })),
        )
      }
    >
      <Icon name="more" size={18} color={colors.muted} />
    </Pressable>
  );
}
