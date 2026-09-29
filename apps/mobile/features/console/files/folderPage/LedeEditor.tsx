/**
 * The words under a project's title: the first paragraph of its front note
 * (`lede.ts`), and — for somebody who may write — editable where it is drawn.
 *
 * It used to be only drawn, so the one sentence saying what a project is for
 * could be changed only by opening the front note and finding it there
 * (reported from a project page: "where does this text come from, and why
 * isn't it editable"). Now pressing it turns it into a field in the same type
 * and place; Enter or leaving the field saves, Shift+Enter is not a new
 * paragraph (a lede is one), and Escape backs out. The field is filled from
 * the paragraph as written, marks and all, so a link inside it survives an
 * edit to the sentence around it. The save goes through the same road a
 * property does (`setLede`), which merges into anybody typing in the note.
 *
 * A project with no paragraph yet offers "Add a description" to a writer and
 * nothing to a reader. While a save is on its way the new words are drawn,
 * so nothing jumps back before the device's copy catches up.
 */

import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, TextInput, View, type NativeSyntheticEvent, type TextInputKeyPressEventData } from "react-native";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { Text, useTextStyles } from "../../../design/components/Text";
import { radii } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { useFieldFont } from "../../../design/fieldFont";
import { noteLede } from "./lede";

export interface LedeEditing {
  /** The paragraph as written, for the field; "" when there is none. */
  read(): Promise<string>;
  /** Resolves to null once saved, or the sentence saying why not. */
  save(text: string): Promise<string | null>;
}

export function Lede({ text, editing }: { text: string | null; editing?: LedeEditing | null }) {
  const styles = useThemedStyles(makeStyles);
  const textStyles = useTextStyles();
  // Mobile Safari zooms into a field under 16px; the lede's 15 is raised on a phone.
  const fieldFont = useFieldFont(textStyles.body.fontSize);
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const [height, setHeight] = useState<number | null>(null);
  const done = useRef(false);

  // The device's copy caught up (or somebody else changed it): draw that.
  useEffect(() => setPending(null), [text]);

  const shown = pending ?? text;
  if (editing == null) {
    return shown ? <Words text={shown} /> : null;
  }

  const open = () => {
    done.current = false;
    setProblem(null);
    setDraft(shown ?? "");
    void editing
      .read()
      .then((source) => setDraft((current) => (current === (shown ?? "") ? source : current)))
      .catch(() => {});
  };
  const close = () => {
    done.current = true;
    setDraft(null);
    setHeight(null);
  };
  const commit = () => {
    if (done.current || draft === null) return;
    const next = draft.replace(/\s*\r?\n\s*/g, " ").trim();
    close();
    if (next === (shown ?? "")) return;
    setPending(next === "" ? "" : noteLede(next) ?? next);
    void editing.save(next).then((answer) => {
      if (answer !== null) {
        setPending(null);
        setProblem(answer);
      }
    });
  };
  const keys = (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    const key = event.nativeEvent.key;
    if (key === "Enter") {
      event.preventDefault();
      commit();
    } else if (key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  if (draft !== null) {
    return (
      <TextInput
        autoFocus
        multiline
        value={draft}
        onChangeText={setDraft}
        onBlur={commit}
        onKeyPress={keys}
        submitBehavior="blurAndSubmit"
        onSubmitEditing={commit}
        onContentSizeChange={(event) => setHeight(event.nativeEvent.contentSize.height)}
        placeholder="What is this project for?"
        accessibilityLabel="Description"
        style={[textStyles.body, styles.words, styles.field, fieldFont, height === null ? null : { height }]}
        testID="folder-lede-input"
      />
    );
  }

  return (
    <View>
      <Pressable
        onPress={open}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        accessibilityRole="button"
        accessibilityLabel={shown ? `Edit description, ${shown}` : "Add a description"}
        style={[styles.box, hovered && styles.boxHover]}
        testID="folder-lede-edit"
      >
        {shown ? <Words text={shown} /> : <Text variant="body" style={styles.empty}>Add a description</Text>}
      </Pressable>
      {problem !== null ? (
        <Text variant="treeMeta" style={styles.problem} role="alert" testID="folder-lede-problem">
          {problem}
        </Text>
      ) : null}
    </View>
  );
}

function Words({ text }: { text: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Text variant="body" numberOfLines={3} style={styles.words} testID="folder-lede">
      {isolateForDisplay(text)}
    </Text>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    words: { color: colors.text2 },
    // The hover tint and the field share one inset, so pressing moves no word.
    box: { marginHorizontal: -6, paddingHorizontal: 6, borderRadius: radii.sm },
    boxHover: { backgroundColor: colors.chipFill },
    empty: { color: colors.chromeMuted },
    field: {
      marginHorizontal: -6,
      paddingHorizontal: 6,
      paddingVertical: 0,
      borderRadius: radii.sm,
      backgroundColor: colors.chipFill,
      outlineStyle: "none" as never,
    },
    problem: { color: colors.crit, marginTop: 2 },
  });
