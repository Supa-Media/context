import { useState, type Dispatch, type SetStateAction } from "react";
import { Pressable, TextInput, View } from "react-native";
import { PressRow } from "../../../design/components/Button";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { radii } from "../../../design/tokens";
import { useColors, useThemedStyles } from "../../../design/theme";
import type { noMatchHint, Recipient, recipientsFor } from "../recipients";
import { Avatar } from "./Avatar";
import { pickedLine } from "./copy";
import type { GrantRole } from "./grants";
import { GroupMaker } from "./GroupMaker";
import type { ShareDialogProps } from "./props";
import { makeStyles } from "./styles";

/**
 * The field, and everything that answers what is typed into it.
 *
 * Google Docs' shape: type, pick somebody from the list, and they become a
 * chip with Share beside it. The one sentence that matters — they sign in, and
 * get this note and the notes it links to — is shown there, at the moment of
 * sharing, rather than as a paragraph under an empty field.
 *
 * No `autoFocus`: the sheet has to be readable before it is typed into, and a
 * phone keyboard over it is not that.
 */
export function RecipientPicker({
  compact,
  recipient,
  setRecipient,
  submit,
  onShare,
  onShareWithGroup,
  onCreateGroup,
  groupSlug,
  access,
  making,
  setMaking,
  makeProblem,
  setMakeProblem,
  emptyHint,
  suggestions,
  grant,
}: {
  compact: boolean;
  recipient: string;
  setRecipient: Dispatch<SetStateAction<string>>;
  submit: () => void;
  onShare: ShareDialogProps["onShare"];
  onShareWithGroup: ShareDialogProps["onShareWithGroup"];
  onCreateGroup: ShareDialogProps["onCreateGroup"];
  groupSlug: ShareDialogProps["groupSlug"];
  access: ShareDialogProps["access"];
  making: { label: string; picked: string[] } | null;
  setMaking: Dispatch<SetStateAction<{ label: string; picked: string[] } | null>>;
  makeProblem: string | null;
  setMakeProblem: Dispatch<SetStateAction<string | null>>;
  emptyHint: ReturnType<typeof noMatchHint> | undefined;
  suggestions: ReturnType<typeof recipientsFor>;
  /**
   * Where a note has a list (rows mode, an owner): a pick is added to it with Can view or Can edit, rather than
   * minted as a share or written as a group rule. `line` is the sentence beside Share for that pick.
   */
  grant?: {
    onGrant: (picked: Recipient, role: GrantRole) => void;
    line: (picked: Recipient, role: GrantRole) => string;
    busy: boolean;
  };
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [focused, setFocused] = useState(false);
  const [picked, setPicked] = useState<Recipient | null>(null);
  const [role, setRole] = useState<GrantRole>("view");
  const canMakeGroup = onCreateGroup !== undefined && groupSlug !== undefined;
  const typing = recipient.trim() !== "" && picked === null && making === null;

  /*
    A person and a group are the same kind of token in `privacy.md`, so one
    field takes both. Picking a group writes the rule; picking a person or an
    address mints the share row. Different verbs, one field, because the
    difference is ours and not theirs.
  */
  const commit = () => {
    if (picked === null) return;
    if (grant !== undefined) {
      grant.onGrant(picked, role);
    } else if (picked.kind === "group" && onShareWithGroup !== undefined) {
      onShareWithGroup(picked.group!);
    } else {
      // A member by their own `@name` where they have one: a display name like "Mari Lola" is not something a
      // share can be addressed to.
      onShare(picked.kind === "member" ? (picked.handle !== undefined ? `@${picked.handle}` : picked.label) : picked.key);
    }
    setPicked(null);
    setRole("view");
    setRecipient("");
  };

  const pickFirst = () => {
    const first = suggestions.find((row) => row.reaches !== true && row.blocked !== true);
    if (first !== undefined) {
      setPicked(first);
      setRecipient("");
      return;
    }
    submit();
  };

  return (
    <View style={{ gap: 22 }}>
      <View
        style={[
          styles.field,
          compact && styles.fieldCompact,
          (focused || picked !== null) && styles.fieldFocused,
        ]}
      >
        {picked === null ? (
          <TextInput
            value={recipient}
            onChangeText={setRecipient}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.input, compact && styles.inputCompact]}
            placeholder="Add people, groups or emails"
            placeholderTextColor={colors.muted}
            accessibilityLabel="Share with"
            testID="share-field"
            onSubmitEditing={pickFirst}
          />
        ) : (
          <View style={styles.chip} testID="share-picked">
            <Avatar label={picked.label} group={picked.kind === "group"} size="chip" />
            <Text style={styles.chipText} numberOfLines={1}>
              {picked.label}
            </Text>
            <Pressable
              accessibilityLabel={`Remove ${picked.label}`}
              hitSlop={8}
              onPress={() => setPicked(null)}
            >
              <Icon name="close" size={14} color={colors.muted} />
            </Pressable>
          </View>
        )}
      </View>

      {picked === null || grant === undefined || picked.kind === "domain" ? null : (
        <View role="radiogroup" aria-label={`What ${picked.label} can do`} style={styles.roleChoice} testID="share-role">
          {(["view", "edit"] as const).map((choice) => (
            <Pressable
              key={choice}
              role="radio"
              aria-checked={role === choice}
              accessibilityLabel={choice === "edit" ? "Can edit" : "Can view"}
              testID={`share-role-${choice}`}
              style={[styles.roleOption, compact && styles.roleOptionCompact, role === choice && styles.roleOptionOn]}
              onPress={() => setRole(choice)}
            >
              <Text style={[styles.footLabel, compact && styles.footLabelCompact, role !== choice && styles.roleOptionOffLabel]}>
                {choice === "edit" ? "Can edit" : "Can view"}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {picked === null ? null : (
        <View style={styles.pickedRow}>
          <Text variant="meta" style={[styles.pickedNote, compact && styles.metaCompact]}>
            {grant !== undefined
              ? grant.line(picked, role)
              : pickedLine(picked.kind === "group" ? "group" : picked.kind === "invite" ? "invite" : "person")}
          </Text>
          <Pressable
            accessibilityLabel="Share"
            testID="share-submit"
            disabled={grant?.busy === true}
            style={[styles.footButton, styles.smallButton, styles.footPrimary]}
            onPress={commit}
          >
            <Text style={[styles.footLabel, styles.footPrimaryLabel]}>Share</Text>
          </Pressable>
        </View>
      )}

      {!typing ? null : (
        <View style={styles.suggestions} testID="share-suggestions">
          {suggestions.map((row) =>
            /*
              An answer, not an offer. Somebody who already reaches the note is
              shown — "no rows" could not tell "they already have it" from "no
              such person" — but greyed and with nothing behind a press, since
              sharing with them would grant nothing.
            */
            row.reaches === true || row.blocked === true ? (
              <View
                key={`${row.kind}:${row.key}`}
                style={[styles.suggestion, row.reaches === true && styles.suggestionReaching]}
                testID={`share-reaching-${row.key}`}
              >
                {row.kind === "domain" || row.kind === "invite" ? (
                  <View style={styles.avatar}>
                    <Icon name={row.kind === "domain" ? "globe" : "mail"} size={15} color={colors.text2} />
                  </View>
                ) : (
                  <Avatar label={row.label} group={row.kind === "group"} />
                )}
                <View style={styles.rowMain}>
                  <Text style={styles.name}>{row.label}</Text>
                  {row.detail === undefined ? null : (
                    <Text variant="meta" style={styles.meta}>
                      {row.detail}
                    </Text>
                  )}
                </View>
                {row.reaches !== true ? null : (
                  <Text variant="meta" style={styles.hasAccess}>
                    Has access
                  </Text>
                )}
              </View>
            ) : (
              <PressRow
                key={`${row.kind}:${row.key}`}
                style={styles.suggestion}
                hoverStyle={styles.suggestionHover}
                radius={radii.md}
                accessibilityLabel={`Share with ${row.label}`}
                testID={`share-suggest-${row.key}`}
                onPress={() => {
                  setPicked(row);
                  setRecipient("");
                }}
              >
                {row.kind === "invite" || row.kind === "domain" ? (
                  <View style={styles.avatar}>
                    <Icon name={row.kind === "domain" ? "globe" : "mail"} size={15} color={colors.text2} />
                  </View>
                ) : (
                  <Avatar label={row.label} group={row.kind === "group"} />
                )}
                <View style={styles.rowMain}>
                  <Text style={styles.name}>{row.label}</Text>
                  {row.detail === undefined ? null : (
                    <Text variant="meta" style={styles.meta}>
                      {row.detail}
                    </Text>
                  )}
                </View>
              </PressRow>
            ),
          )}

          {emptyHint === undefined ? null : (
            <Text variant="meta" style={[styles.meta, { padding: 8 }]} testID="share-no-match">
              {emptyHint}
            </Text>
          )}

          {!canMakeGroup ? null : (
            <>
              <View aria-hidden style={styles.divider} />
              <PressRow
                style={styles.suggestion}
                hoverStyle={styles.suggestionHover}
                radius={radii.md}
                accessibilityLabel="Make a group from people here"
                testID="share-make-group"
                onPress={() => {
                  setMakeProblem(null);
                  setMaking({ label: recipient.trim(), picked: [] });
                }}
              >
                <View style={[styles.avatar, { backgroundColor: "transparent" }]}>
                  <Icon name="plus" size={16} color={colors.text2} />
                </View>
                <Text style={[styles.name, { color: colors.text2 }]}>New group from people here</Text>
              </PressRow>
            </>
          )}
        </View>
      )}

      {making === null || !canMakeGroup ? null : (
        <GroupMaker
          slug={groupSlug}
          members={access?.members ?? []}
          state={making}
          problem={makeProblem}
          onChange={setMaking}
          onCancel={() => {
            setMakeProblem(null);
            setMaking(null);
          }}
          onCreate={() => {
            setMakeProblem(null);
            void onCreateGroup(making.label.trim(), making.picked).then(
              () => {
                setMaking(null);
                setRecipient("");
              },
              (error: unknown) => {
                /*
                  The maker stays OPEN on a refusal, holding the label and the
                  people that were picked. Closing it would make the person
                  re-choose four names to fix one word.
                */
                setMakeProblem(
                  error instanceof Error && error.message.length > 0
                    ? error.message
                    : "That group could not be made.",
                );
              },
            );
          }}
        />
      )}
    </View>
  );
}
