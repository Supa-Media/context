import { useEffect, useRef, useState } from "react";
import { Pressable, TextInput, View, type NativeSyntheticEvent, type TextInputKeyPressEventData } from "react-native";
import { PressRow } from "../../../design/components/Button";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { radii } from "../../../design/tokens";
import { useColors, useThemedStyles } from "../../../design/theme";
import type { PropertyRow } from "./propertyEdit";
import { makeStyles } from "./styles";

/**
 * Sets one property (a string) or removes it (`null`). Answers `null` when the
 * note changed, or the sentence saying why it did not.
 */
export type SetProperty = (key: string, value: string | null, adding?: boolean) => string | null;

type KeyPress = NativeSyntheticEvent<TextInputKeyPressEventData>;

/**
 * Escape backs out; Enter commits where the field is multi-line (a single-line
 * field already submits on Enter, through `onSubmitEditing`).
 */
function keys(event: KeyPress, onEnter: (() => void) | null, onEscape: () => void) {
  const key = event.nativeEvent.key;
  if (key === "Enter" && onEnter !== null) {
    event.preventDefault();
    onEnter();
  } else if (key === "Escape") {
    event.preventDefault();
    onEscape();
  }
}

/**
 * One row whose value can be changed where it is drawn.
 *
 * At rest it is the same key and value as a read-only row, so a card of them
 * reads as metadata rather than as a form; hovering tints the value to say it
 * can be pressed. Pressing it turns the value into a field with the same type
 * and the same place on the line, so nothing moves. Enter or leaving the field
 * saves; Escape puts it back. The × that removes the property is shown while
 * the row is hovered or being edited — on a phone, that is once you tap in.
 */
export function EditableProperty({ row, onSet, onError }: {
  row: PropertyRow;
  onSet: SetProperty;
  onError: (message: string | null) => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [editing, setEditing] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [draft, setDraft] = useState(row.raw ?? row.value);
  const [height, setHeight] = useState<number | null>(null);
  const done = useRef(false);
  /*
    Pressing × takes focus from the field, and the blur that follows would
    save and close the row — hiding the × before its press lands. Held from
    press-in to press-out, the blur leaves the row alone.
  */
  const removing = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(row.raw ?? row.value);
  }, [editing, row.raw, row.value]);

  const open = () => {
    done.current = false;
    setDraft(row.raw ?? row.value);
    onError(null);
    setEditing(true);
  };
  const close = () => {
    done.current = true;
    setEditing(false);
    setHeight(null);
  };
  const commit = () => {
    if (done.current || removing.current) return;
    const next = draft.trim();
    // A cleared field is backed out of, not saved: removing is the ×.
    if (next !== "" && next !== (row.raw ?? row.value)) onError(onSet(row.key, next));
    close();
  };
  const remove = () => {
    removing.current = false;
    done.current = true;
    onError(onSet(row.key, null));
    close();
  };

  return (
    <Pressable
      style={styles.property}
      focusable={false}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      testID={`note-property-${row.key}`}
    >
      <View style={styles.propertyMark}>
        <Icon name="filter" size={15} color={colors.muted} />
      </View>
      <Text variant="rowSub" style={styles.propertyKey} numberOfLines={1}>
        {row.key}
      </Text>
      {editing ? (
        <TextInput
          autoFocus
          multiline
          value={draft}
          onChangeText={setDraft}
          onBlur={commit}
          onKeyPress={(event) => keys(event, commit, close)}
          submitBehavior="blurAndSubmit"
          onSubmitEditing={commit}
          onContentSizeChange={(event) => setHeight(event.nativeEvent.contentSize.height)}
          accessibilityLabel={`${row.key}`}
          style={[
            styles.propertyValue,
            styles.propertyInput,
            styles.propertyInputActive,
            height === null ? null : { height },
          ]}
          testID={`note-property-${row.key}-input`}
        />
      ) : (
        <PressRow
          onPress={open}
          accessibilityLabel={`Change ${row.key}, ${row.value}`}
          style={styles.propertyValueBox}
          hoverStyle={styles.propertyValueHover}
          radius={radii.sm}
          testID={`note-property-${row.key}-value`}
        >
          <Text variant="rowSub" style={styles.propertyValue}>
            {row.value}
          </Text>
        </PressRow>
      )}
      <Pressable
        onPressIn={() => (removing.current = true)}
        onPressOut={() => {
          if (!removing.current) return;
          // Dragged off rather than pressed: finish the edit the blur skipped.
          setTimeout(() => {
            if (!removing.current) return;
            removing.current = false;
            if (editing) commit();
          }, 0);
        }}
        onPress={remove}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${row.key}`}
        // 22 + 11 each side is a thumb's 44, which a phone needs and a pointer does not mind.
        hitSlop={11}
        style={(state) => [
          styles.propertyRemove,
          (state as { hovered?: boolean }).hovered && styles.propertyRemoveHover,
          !(hovered || editing) && styles.propertyRemoveHidden,
        ]}
        testID={`note-property-${row.key}-remove`}
      >
        <Icon name="close" size={13} color={colors.muted} />
      </Pressable>
    </Pressable>
  );
}

/**
 * The last row: "Add property", and then a name and a value in its place.
 *
 * Tab or Enter moves from the name to the value; Enter on the value adds it;
 * Escape, or leaving both fields empty, puts the row back. A name the note
 * already has is refused rather than written, so adding can never overwrite a
 * value somebody can't see.
 */
// eslint-disable-next-line @supa-media/keyboard-aware-forms -- two inline fields at the top of the note, inside its own scroller, not a form
export function AddProperty({ onSet, onError }: {
  onSet: SetProperty;
  onError: (message: string | null) => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const valueField = useRef<TextInput | null>(null);
  const focused = useRef(0);
  // Which field has the caret, for its tint alone: only that one wears a box,
  // so the row reads as a key and a value rather than as two inputs.
  const [caret, setCaret] = useState<"name" | "value" | null>(null);

  const reset = () => {
    setAdding(false);
    setName("");
    setValue("");
  };
  const commit = () => {
    if (name.trim() === "") return onError("Give the property a name.");
    if (value.trim() === "") return valueField.current?.focus();
    const problem = onSet(name, value, true);
    onError(problem);
    if (problem === null) reset();
  };
  const blurred = () => {
    focused.current -= 1;
    // Moving from the name to the value blurs one before it focuses the other.
    setTimeout(() => {
      if (focused.current <= 0 && name.trim() === "" && value.trim() === "") reset();
    }, 0);
  };

  if (!adding) {
    return (
      <PressRow
        onPress={() => {
          onError(null);
          setAdding(true);
        }}
        accessibilityLabel="Add a property"
        style={[styles.property, styles.propertyAddRow]}
        hoverStyle={styles.propertyAddHover}
        radius={radii.sm}
        testID="note-properties-add"
      >
        <View style={styles.propertyMark}>
          <Icon name="plus" size={15} color={colors.muted} />
        </View>
        <Text variant="rowSub" style={styles.propertyAddLabel}>
          Add property
        </Text>
      </PressRow>
    );
  }

  return (
    <View style={styles.property} testID="note-properties-adding">
      <View style={styles.propertyMark}>
        <Icon name="plus" size={15} color={colors.muted} />
      </View>
      <TextInput
        autoFocus
        value={name}
        onChangeText={setName}
        placeholder="name"
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        autoCorrect={false}
        onFocus={() => {
          focused.current += 1;
          setCaret("name");
        }}
        onBlur={() => {
          setCaret((current) => (current === "name" ? null : current));
          blurred();
        }}
        onKeyPress={(event) => keys(event, null, reset)}
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => (value.trim() === "" ? valueField.current?.focus() : commit())}
        accessibilityLabel="New property name"
        style={[
          styles.propertyKey,
          styles.propertyInput,
          styles.propertyKeyInput,
          caret === "name" && styles.propertyInputActive,
        ]}
        testID="note-properties-add-name"
      />
      <TextInput
        ref={valueField}
        value={value}
        onChangeText={setValue}
        placeholder="value"
        placeholderTextColor={colors.muted}
        onFocus={() => {
          focused.current += 1;
          setCaret("value");
        }}
        onBlur={() => {
          setCaret((current) => (current === "value" ? null : current));
          blurred();
        }}
        onKeyPress={(event) => keys(event, null, reset)}
        returnKeyType="done"
        submitBehavior="submit"
        onSubmitEditing={commit}
        accessibilityLabel="New property value"
        style={[styles.propertyValue, styles.propertyInput, caret === "value" && styles.propertyInputActive]}
        testID="note-properties-add-value"
      />
      {/* A phone has no Escape key, so backing out needs a control of its own. */}
      <Pressable
        onPress={reset}
        accessibilityRole="button"
        accessibilityLabel="Cancel adding a property"
        hitSlop={11}
        style={(state) => [styles.propertyRemove, (state as { hovered?: boolean }).hovered && styles.propertyRemoveHover]}
        testID="note-properties-add-cancel"
      >
        <Icon name="close" size={13} color={colors.muted} />
      </Pressable>
    </View>
  );
}
