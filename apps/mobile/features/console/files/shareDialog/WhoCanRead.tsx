import type { Dispatch, SetStateAction } from "react";
import { Pressable, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Text } from "../../../design/components/Text";
import { useThemedStyles } from "../../../design/theme";
import { baseName, folderLabel } from "../paths";
import type { accessRows } from "../access";
import { isGroupVisibility } from "../types";
import { scopeOf } from "../scope";
import {
  audienceDetail,
  audienceName,
  audienceSource,
  type AudienceContext,
} from "../../privacy/audience";
import type { NoteShare, sharesFor } from "../shares";
import { AudienceControl } from "./AudienceControl";
import type { CopyTarget, ShareDialogProps } from "./props";
import { SharedWith } from "./SharedWith";
import { makeStyles } from "./styles";

/**
 * WHO CAN READ IT: the audience control, the people list with each person's
 * removal routes, and who the note has been handed to. The state is
 * `ShareDialog`'s; this draws it.
 */
export function WhoCanRead({
  path,
  access,
  entryKind,
  context,
  compact,
  openLink,
  rows,
  removing,
  setRemoving,
  onSetScope,
  onRemovalRoute,
  mine,
  origin,
  copyAndClose,
  onRevoke,
  onSetPreviewTitle,
}: {
  path: string;
  access: ShareDialogProps["access"];
  entryKind: "file" | "folder";
  context: AudienceContext;
  compact: boolean;
  openLink: NoteShare | undefined;
  rows: ReturnType<typeof accessRows>;
  removing: string | null;
  setRemoving: Dispatch<SetStateAction<string | null>>;
  onSetScope: ShareDialogProps["onSetScope"];
  onRemovalRoute: ShareDialogProps["onRemovalRoute"];
  mine: ReturnType<typeof sharesFor>;
  origin: string;
  copyAndClose: (target: CopyTarget) => void;
  onRevoke: ShareDialogProps["onRevoke"];
  onSetPreviewTitle: ShareDialogProps["onSetPreviewTitle"];
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <>
      {/*
        The list this section is named after, which it did not have. It
        said "PEOPLE WITH ACCESS" and then offered a link — the one thing
        on the screen that is not a person.

        The summary line carries the half a list cannot show: whether the
        rule is on this note or inherited from the folder, which is the
        difference between "this is fine" and "wait, that folder?".
      */}
      <View style={styles.section}>
        <Text variant="eyebrow">WHO CAN READ IT</Text>
        {access === undefined ? null : (
          <View style={styles.access} testID="share-access">
            {/*
              The padlock that used to live in the top bar, with its
              positions named. See `onSetScope` for why an unlabelled
              cycling icon was the wrong shape for this decision.

              Absent — not disabled — when the rule names a group, because
              `setScope` refuses that case in `useFileBrowser` and says
              why: `scopeOf` maps a group to the `private` POSITION, so a
              segmented control would draw "Only me" as current over a
              note two colleagues can read, and the step out of it would
              silently delete the group rule. The way out is the group
              row's own route, in the list below.
            */}
            {onSetScope === undefined ? null : isGroupVisibility(access.visibility) ? (
              <Text variant="meta" style={styles.accessReason} testID="share-scope-group">
                {`${entryKind === "folder" ? "This folder" : "This note"} is shared with ${audienceName(access.visibility, context)}. Change that where the group is defined — the row below takes you there.`}
              </Text>
            ) : (
              <AudienceControl
                scope={scopeOf(access.visibility, openLink !== undefined)}
                canOpenLink
                name={folderLabel(baseName(path))}
                onSet={onSetScope}
                context={context}
                compact={compact}
              />
            )}
            {/*
              SAID ONCE.

              The detail line under the control answers "who can read
              it" for whichever position is in force — which is the only
              way a segmented control CAN answer it, because a segment
              is a word with nowhere to put a sentence. The phone's rows
              each carry their own, so on that surface this line is the
              same sentence a second time, four points under the first.

              The source line stays on both: which rule this came from —
              this note's own, or the folder's — is the half no list of
              positions can show, and it is the difference between "this
              is fine" and "wait, that folder?".
            */}
            {compact ? null : (
              <Text variant="paneSub">
                {audienceDetail(access.visibility, context)}
              </Text>
            )}
            <Text variant="meta" style={styles.accessReason}>
              {audienceSource(access.exception, entryKind)}
            </Text>
            {rows.map((row) => {
              /*
                A verb only where one is real. An owner has no removal
                route — the server refuses both mutations outright — and
                a caller with no handler is a non-owner or the demo. Both
                draw the plain role, which is what this list always was.
              */
              const canRemove =
                row.removal.length > 0 && onRemovalRoute !== undefined;
              const open = removing === row.key;

              return (
                <View key={row.key} style={styles.accessGroup}>
                  <View style={styles.accessRow}>
                    <View style={styles.accessMain}>
                      <Text variant="rowTitle">{row.label}</Text>
                      <Text variant="meta" style={styles.accessReason}>
                        {row.reason}
                      </Text>
                    </View>
                    {canRemove ? (
                      <Button
                        label={open ? "Cancel" : "Remove…"}
                        onPress={() => setRemoving(open ? null : row.key)}
                        testID={`share-access-remove-${row.key}`}
                      />
                    ) : (
                      <Text variant="meta">{row.role}</Text>
                    )}
                  </View>

                  {!open || !canRemove ? null : (
                    <View style={styles.routes} testID={`share-routes-${row.key}`}>
                      {/*
                        Each route states how far it reaches, because the
                        two differ by an entire context and the label
                        alone cannot carry that. `access.ts` orders them
                        narrowest first, so the safe one is the one under
                        the thumb.
                      */}
                      {row.removal.map((route) => (
                        <Pressable
                          key={route.id}
                          style={styles.route}
                          accessibilityLabel={route.label}
                          testID={`share-route-${route.id}`}
                          onPress={() => {
                            setRemoving(null);
                            onRemovalRoute(route, row);
                          }}
                        >
                          <Text
                            variant="rowTitle"
                            style={route.danger ? styles.routeDanger : undefined}
                          >
                            {route.label}
                          </Text>
                          <Text variant="meta" style={styles.accessReason}>
                            {route.detail}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        )}

        <SharedWith
          shares={mine}
          origin={origin}
          onCopyLink={copyAndClose}
          onRevoke={onRevoke}
          onSetPreviewTitle={onSetPreviewTitle}
        />
      </View>
    </>
  );
}
