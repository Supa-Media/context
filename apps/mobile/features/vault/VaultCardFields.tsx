import { useRef } from "react";
import { StyleSheet, View, type TextInput } from "react-native";
import { TextField } from "../design/components/Input";
import { SecretInput } from "./SecretInput";
import { groupCardNumber, groupExpiry, type CardFormState } from "./vaultCard";

// The boxes are `TextField`s, sized by `useFieldFont` there.
type Field = TextInput;

/**
 * A card's boxes on the add form: number, expiry and security code, then the
 * name and billing ZIP a checkout may ask for. The values live in the
 * caller's state; this draws them and keeps the number readable as it is
 * typed. The number and the code are dots until the person presses Show.
 */
export function VaultCardFields({
  card,
  onChange,
  onDone,
  busy,
}: {
  card: CardFormState;
  onChange: (card: CardFormState) => void;
  onDone: () => void;
  busy: boolean;
}) {
  const expiryRef = useRef<Field>(null);
  const cvcRef = useRef<Field>(null);
  const nameRef = useRef<Field>(null);
  const postalRef = useRef<Field>(null);
  const set = (patch: Partial<CardFormState>) => onChange({ ...card, ...patch });
  return (
    <>
      <SecretInput
        label="Card number"
        revealName="card number"
        value={card.number}
        onChangeText={(text) => set({ number: groupCardNumber(text) })}
        keyboardType="number-pad"
        inputMode="numeric"
        autoComplete="cc-number"
        textContentType="creditCardNumber"
        maxLength={23}
        returnKeyType="next"
        onSubmitEditing={() => expiryRef.current?.focus()}
        editable={!busy}
        testID="vault-card-number"
      />
      <View style={sheet.row}>
        <View style={sheet.half}>
          <TextField
            ref={expiryRef}
            label="Expires"
            value={card.expiry}
            onChangeText={(text) => set({ expiry: groupExpiry(text) })}
            placeholder="MM/YY"
            keyboardType="number-pad"
            inputMode="numeric"
            autoComplete="cc-exp"
            maxLength={5}
            returnKeyType="next"
            onSubmitEditing={() => cvcRef.current?.focus()}
            editable={!busy}
            testID="vault-card-expiry"
          />
        </View>
        <View style={sheet.half}>
          <SecretInput
            ref={cvcRef}
            label="Security code"
            revealName="security code"
            value={card.cvc}
            onChangeText={(text) => set({ cvc: text.replace(/\D/g, "").slice(0, 4) })}
            placeholder="CVC"
            keyboardType="number-pad"
            inputMode="numeric"
            autoComplete="cc-csc"
            maxLength={4}
            returnKeyType="next"
            onSubmitEditing={() => nameRef.current?.focus()}
            editable={!busy}
            testID="vault-card-cvc"
          />
        </View>
      </View>
      <TextField
        ref={nameRef}
        label="Name on card"
        optional
        value={card.name}
        onChangeText={(text) => set({ name: text })}
        autoCapitalize="words"
        autoComplete="cc-name"
        textContentType="name"
        maxLength={100}
        returnKeyType="next"
        onSubmitEditing={() => postalRef.current?.focus()}
        editable={!busy}
        testID="vault-card-name"
      />
      <TextField
        ref={postalRef}
        label="Billing ZIP or postcode"
        optional
        value={card.postalCode}
        onChangeText={(text) => set({ postalCode: text })}
        autoCapitalize="characters"
        autoComplete="postal-code"
        textContentType="postalCode"
        maxLength={16}
        returnKeyType="done"
        onSubmitEditing={onDone}
        editable={!busy}
        testID="vault-card-postal"
      />
    </>
  );
}

const sheet = StyleSheet.create({
  row: { flexDirection: "row", gap: 12 },
  half: { flex: 1, minWidth: 0 },
});
