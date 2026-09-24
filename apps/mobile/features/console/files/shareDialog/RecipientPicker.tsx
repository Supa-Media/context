import type { Dispatch, SetStateAction } from "react";
import { Pressable, TextInput, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Text } from "../../../design/components/Text";
import { useThemedStyles, type Colors } from "../../../design/theme";
import type { noMatchHint, recipientsFor } from "../recipients";
import { describePersonalShare } from "../shares";
import { GroupMaker } from "./GroupMaker";
import type { ShareDialogProps } from "./props";
import { makeStyles } from "./styles";

/**
 * The share field and everything that answers what is typed into it: the
 * sentence saying what a share does, the door to making a group, and the
 * suggestion list. The state is `ShareDialog`'s; this draws it.
 */
export function RecipientPicker({
  colors,
  recipient,
  setRecipient,
  submit,
  ready,
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
}: {
  /** The dialog's own `useColors()`, for the field's placeholder. */
  colors: Colors;
  recipient: string;
  setRecipient: Dispatch<SetStateAction<string>>;
  submit: () => void;
  ready: boolean;
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
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <>
      {/*
        The field first, and the reason is the whole shape of this
        screen.

        It used to be fourth, under three eyebrow sections that each
        opened with a paragraph — so on a phone the thing you came here
        to do was below the fold, and `autoFocus` then raised the
        keyboard over what was left. A share dialog is a place you type a
        name; everything else on it is context for that, and context goes
        after.

        No `autoFocus` for the same reason: the sheet has to be readable
        before it is typed into.
      */}
      <View style={styles.row}>
        <TextInput
          value={recipient}
          onChangeText={setRecipient}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          placeholder="Name, group or email"
          placeholderTextColor={colors.muted}
          accessibilityLabel="Share with"
          onSubmitEditing={submit}
        />
        <Button label="Share" variant="white" disabled={!ready} onPress={submit} />
      </View>

      {/*
        What typing a name does, under the field that does it.

        It used to be the last paragraph of the links section — three
        headings away from the control it describes, and on a phone below
        the fold entirely. The sentence did not change; where it sits
        did. `shareLink.test.ts` pins all four facts in it, because each
        is one this file's header names as something an owner guesses
        wrong: they sign in, they get this note and what it links to,
        nothing else, and you can take it back.
      */}
      <Text variant="meta" style={styles.linkNote}>
        {describePersonalShare()}
      </Text>

      {/*
        One field, one list.

        A person and a group are the same kind of token in `privacy.md` —
        `@kola` and `@supa-leads` are indistinguishable to the parser —
        so this does not ask which KIND you mean before letting you type.
        What it does keep separate is the invite row: choosing it is two
        things, an invitation and then the access, and the row says so
        before it happens rather than after.

        Picking a group writes the rule; picking a person or an address
        mints the share row that already existed. Different verbs, one
        field, because the difference is ours and not theirs.
      */}
      {/*
        Where a group is born.

        Offered under the field rather than inside the suggestion list:
        the list answers "who do you mean", and this is a different verb
        that should not move around as rows come and go. Absent entirely
        for a non-owner, which is this console's rule for a control the
        server would refuse.
      */}
      {onCreateGroup === undefined || groupSlug === undefined ? null : making === null ? (
        /*
          One quiet line, not a panel.

          It was a dashed box with a title and a sentence, sitting under
          the field — and in a photograph of the sheet it outshouted the
          thing people came here to use. Making a group is the rarer
          verb; it earns a line, and the explanation belongs inside the
          maker it opens.
        */
        <Pressable
          style={styles.makeGroup}
          accessibilityLabel="Make a group from people here"
          testID="share-make-group"
          onPress={() => {
            setMakeProblem(null);
            setMaking({ label: recipient.trim(), picked: [] });
          }}
        >
          <Text variant="meta" style={styles.makeGroupText}>
            New group from people here…
          </Text>
        </Pressable>
      ) : (
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
                  The maker stays OPEN on a refusal, holding the label and
                  the people that were picked. Closing it would make the
                  person re-choose four names to fix one word.
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

      {emptyHint === undefined ? null : (
        <Text variant="meta" style={styles.suggestionDetail} testID="share-no-match">
          {emptyHint}
        </Text>
      )}

      {suggestions.length === 0 ? null : (
        <View style={styles.suggestions} testID="share-suggestions">
          {suggestions.map((row) =>
            /*
              An answer, not an offer. A row for somebody who already
              reaches the note is drawn as a statement with no press
              behind it — pressing it would mint a share that grants
              nothing, and a control that does nothing is the defect this
              console keeps recording against itself. It is still SHOWN,
              which is the whole point: "no rows" could not tell
              "they already have it" from "no such person".
            */
            row.reaches === true ? (
              <View
                key={`${row.kind}:${row.key}`}
                style={[styles.suggestion, styles.suggestionReaching]}
                testID={`share-reaching-${row.key}`}
              >
                <Text variant="rowTitle" style={styles.suggestionMuted}>
                  {row.label}
                </Text>
                {row.detail === undefined ? null : (
                  <Text variant="meta" style={styles.suggestionDetail}>
                    {row.detail}
                  </Text>
                )}
              </View>
            ) : (
              <Pressable
                key={`${row.kind}:${row.key}`}
                style={styles.suggestion}
                accessibilityLabel={`Share with ${row.label}`}
                testID={`share-suggest-${row.key}`}
                onPress={() => {
                  setRecipient("");
                  if (row.kind === "group" && onShareWithGroup !== undefined) {
                    onShareWithGroup(row.group!);
                    return;
                  }
                  onShare(row.kind === "member" ? row.label : row.key);
                }}
              >
                <Text variant="rowTitle">{row.label}</Text>
                {row.detail === undefined ? null : (
                  <Text variant="meta" style={styles.suggestionDetail}>
                    {row.detail}
                  </Text>
                )}
              </Pressable>
            ),
          )}
        </View>
      )}
    </>
  );
}
