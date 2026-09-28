import { useState } from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import { useAction, useMutation } from "convex/react";

import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { WORKSPACE_ICON_EMOJI } from "@context/shared";
import { pickSquarePhoto } from "./pickSquarePhoto";
import { Button } from "../../../design/components/Button";
import { Text } from "../../../design/components/Text";
import { pointerType as t, radii, space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import type { MarkIcon } from "../../useWorkspaceIcons";

/**
 * Choosing what a workspace draws in its mark.
 *
 * ## Why this control exists
 *
 * The mark derived one letter from the slug, and a person holding `@seyi` and
 * `@supa` got **S** twice — same square, same colour, side by side in the
 * switcher, which is the control whose entire job is telling contexts apart.
 *
 * ## Why it is collapsed until asked for
 *
 * It sits under the identity block and opens on a press of the monogram, which
 * is the thing it changes. Left open it would be a 48-cell grid at the top of
 * the first screen of settings — above Storage and Sharing, which are what
 * people actually come here for — and an icon is chosen roughly once per
 * workspace, ever.
 *
 * ## Owner-only, and the control is simply absent otherwise
 *
 * The section's own rule ("absent rather than disabled — a greyed row inviting
 * somebody to press it is a worse answer than no row"), and here it is also the
 * honest one: the icon is drawn in the rail of every member, so it goes with
 * the workspace's name and its storage rather than with the notes an editor may
 * write. A non-owner sees the mark and no way in, which is what they can do.
 */
export function WorkspaceIconPicker({
  workspaceId,
  icon,
  onClose,
  allowPhoto = true,
}: {
  workspaceId: string;
  /** What the mark draws now, so the current choice can be marked as chosen. */
  icon?: MarkIcon;
  onClose: () => void;
  /**
   * Whether "Choose a photo…" is offered. A photo is written into the
   * workspace's bucket, so the new-workspace flow turns it off on a run with no
   * verified bucket rather than offering a button whose only outcome is an
   * error. Settings always has one to offer.
   */
  allowPhoto?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const setIcon = useMutation(api.functions.workspaces.setWorkspaceIcon);
  const setPhoto = useAction(api.functions.files.setWorkspaceIconPhoto);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await run();
      onClose();
    } catch (failure) {
      /*
        The server's own sentence where there is one — "A workspace icon must be
        at most 1048576 bytes", "A workspace icon is a single emoji" — for the
        reason the editor's image paste gives: somebody wrote those words for
        exactly this moment and this control has nothing better to say.
      */
      const message = (failure as { data?: { message?: string } })?.data?.message;
      setError(message ?? "That didn’t save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function pickPhoto() {
    const picked = await pickSquarePhoto();
    if (picked.kind === "canceled") return;
    if (picked.kind === "error") {
      setError(picked.message);
      return;
    }
    await choose(() =>
      setPhoto({
        workspaceId: workspaceId as Id<"workspaces">,
        bytes: picked.bytes,
        contentType: picked.contentType,
      }),
    );
  }

  return (
    <View style={styles.card} testID="workspace-icon-picker">
      <View style={styles.grid}>
        {WORKSPACE_ICON_EMOJI.map((emoji) => {
          const chosen = icon?.kind === "emoji" && icon.emoji === emoji;
          return (
            <Pressable
              key={emoji}
              role="button"
              accessibilityLabel={`Use ${emoji} as this workspace’s icon`}
              accessibilityState={{ selected: chosen, disabled: busy }}
              disabled={busy}
              onPress={() =>
                void choose(() =>
                  setIcon({ workspaceId: workspaceId as Id<"workspaces">, emoji }),
                )
              }
              style={[styles.cell, chosen && styles.cellChosen]}
              testID={`workspace-icon-emoji-${emoji}`}
            >
              <Text style={styles.cellGlyph}>{emoji}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.actions}>
        {allowPhoto ? (
          <Button
            label="Choose a photo…"
            onPress={() => void pickPhoto()}
            disabled={busy}
            testID="workspace-icon-photo"
          />
        ) : null}
        {/*
          Only where there is something to undo. "Use the letter" on a workspace
          already drawing its letter is a control whose only outcome is nothing
          happening — the same rule the settings catalogue applies to rows.
        */}
        {icon === undefined ? null : (
          <Button
            label="Use the letter"
            onPress={() =>
              void choose(() =>
                setIcon({ workspaceId: workspaceId as Id<"workspaces">, emoji: null }),
              )
            }
            disabled={busy}
            testID="workspace-icon-clear"
          />
        )}
      </View>

      {error === null ? null : (
        <Text variant="rowSub" style={styles.error} testID="workspace-icon-error">
          {error}
        </Text>
      )}
    </View>
  );
}

/**
 * The mark as this panel draws it: 46pt, so it is an identity rather than a pip.
 *
 * Deliberately not `WorkspaceMark`, which is 18pt and whose own header says why
 * it is not shared with `AccountBlock`'s 26pt `Avatar`: a component with a size
 * prop used at three values in three places is three components wearing one
 * name. What *is* shared is the rule — photo, else emoji, else the letter — and
 * it is one expression in both files rather than a second drawing here.
 */
export function WorkspaceMonogram({
  slug,
  icon,
  style,
}: {
  slug: string;
  icon?: MarkIcon;
  style?: object;
}) {
  const styles = useThemedStyles(makeStyles);
  if (icon?.kind === "photo") {
    return (
      <View style={[styles.monogram, style]} aria-hidden>
        <Image source={{ uri: icon.uri }} style={styles.monogramPhoto} resizeMode="cover" />
      </View>
    );
  }
  return (
    <View style={[styles.monogram, style]} aria-hidden>
      {icon?.kind === "emoji" ? (
        <Text style={styles.monogramEmoji}>{icon.emoji}</Text>
      ) : (
        <Text variant="noteTitle" style={styles.monogramLetter}>
          {slug.slice(0, 1).toUpperCase()}
        </Text>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: {
      marginTop: space.x3,
      padding: space.x3,
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface2,
      gap: space.x3,
    },
    /*
      Wraps, and deliberately does not scroll. A vertical scroller inside the
      settings panel's own vertical scroller is two responders fighting for one
      drag — see `WORKSPACE_ICON_EMOJI` for why the list was shortened to suit
      the layout rather than the layout bent to fit the list.
    */
    grid: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },
    cell: {
      width: 44,
      height: 44,
      borderRadius: radii.sm,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: "transparent",
    },
    cellChosen: { borderColor: colors.accent, backgroundColor: colors.accentDim },
    /*
      `title`, from the scale, rather than a number that looked right in a 44pt
      cell — `typeScale.test.ts` fails on a literal `fontSize` anywhere under
      `features/`, and the cell was sized to the scale rather than the reverse.
    */
    cellGlyph: { fontSize: t.title, lineHeight: 36 },
    actions: { flexDirection: "row", gap: space.x2, flexWrap: "wrap" },
    error: { color: colors.crit },
    monogram: {
      width: 46,
      height: 46,
      borderRadius: 15,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.accentDim,
      borderWidth: 1,
      borderColor: colors.accent,
      overflow: "hidden",
    },
    monogramLetter: { color: colors.accentText },
    monogramEmoji: { fontSize: t.title, lineHeight: 36 },
    monogramPhoto: { width: "100%", height: "100%" },
  });
