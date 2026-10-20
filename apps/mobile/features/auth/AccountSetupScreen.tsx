import { useState } from "react";
import { View } from "react-native";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../design/components/Button";
import { CenteredScroll } from "../design/components/CenteredScroll";
import { TextField } from "../design/components/Input";
import { Text } from "../design/components/Text";
import { useThemedStyles } from "../design/theme";
import { CodeBoxes, OTP_LENGTH } from "./CodeBoxes";
import { PhoneNumberField } from "./PhoneNumberField";
import { confirmError, sendError } from "./phoneCheck";
import { AccountSetupJoined } from "./AccountSetupJoined";
import { useSwitchAccount } from "./useSwitchAccount";
import { canFinishSetup, finishFailure, initialName, phoneAlreadyDone } from "./accountSetupModel";
import { makeAccountSetupStyles } from "./accountSetupStyles";

/**
 * "Make your account" (board 2 of the domain sign-up, 2026-10-16). Drawn by
 * `app/(app)/_layout.tsx` after the domain join and before onboarding, for
 * somebody who signed in through a shared workspace's email domain and owns no
 * workspace yet. It asks for a name and a phone (texted a code), then makes
 * their own workspace. Their personal Gmail is asked next, by the layout
 * (`gmailFirst/PersonalEmailGate.tsx`; Dev, 2026-10-20: "they need their
 * number first and then their personal gmail"), because Gmail connects to the
 * workspace this makes; then the layout draws the link they opened, on the
 * same URL.
 *
 * Nothing here navigates. The rules are in `accountSetupModel.ts`; the server
 * decides what each step may do (`functions/accountSetup.ts`, `phoneCheck.ts`,
 * `signInEmails.ts`).
 */
export function AccountSetupScreen({ email, suggestedName }: { email: string | null; suggestedName: string }) {
  const styles = useThemedStyles(makeAccountSetupStyles);
  const check = useQuery(api.functions.phoneCheck.myPhoneCheck, {});
  const sendPhoneText = useAction(api.functions.phoneCheck.sendPhoneCode);
  const checkPhoneText = useAction(api.functions.phoneCheck.confirmPhoneCode);
  const finish = useMutation(api.functions.accountSetup.finishSetup);
  const switchAccount = useSwitchAccount();

  const [name, setName] = useState(() => initialName(suggestedName));
  const [phone, setPhone] = useState("");
  const [phoneSentTo, setPhoneSentTo] = useState<string | null>(null);
  const [phoneCode, setPhoneCode] = useState("");
  const [phoneConfirmed, setPhoneConfirmed] = useState(false);
  const [joined, setJoined] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [finishError, setFinishError] = useState<string | null>(null);

  const phoneDone = phoneConfirmed || phoneAlreadyDone(check);
  const domain = email === null ? null : (email.split("@")[1] ?? null);
  const leaving = domain === null ? "stop working there" : `leave ${domain}`;

  async function run(work: () => Promise<void>, onFailure: (message: string) => void) {
    setBusy(true);
    try {
      await work();
    } catch (failure) {
      onFailure(finishFailure(failure));
    } finally {
      setBusy(false);
    }
  }

  const sendPhone = () =>
    run(async () => {
      setPhoneError(null);
      const result = await sendPhoneText({ phone: phoneSentTo ?? phone });
      setPhoneError(sendError(result.status));
      if (result.status === "sent" && result.phone !== undefined) {
        setPhoneSentTo(result.phone);
        setPhoneCode("");
      }
    }, setPhoneError);

  const confirmPhone = (value: string) => {
    if (value.length !== OTP_LENGTH || phoneSentTo === null) return;
    return run(async () => {
      setPhoneError(null);
      const result = await checkPhoneText({ phone: phoneSentTo, code: value });
      if (result.status === "confirmed") setPhoneConfirmed(true);
      // A number another account already holds joins the two (`phoneCheck.ts`).
      else if (result.status === "joined") setJoined(true);
      else {
        setPhoneError(confirmError(result.status));
        setPhoneCode("");
      }
    }, setPhoneError);
  };

  const finishNow = () =>
    run(async () => {
      setFinishError(null);
      await finish({ name: name.trim() });
    }, setFinishError);

  if (joined) return <AccountSetupJoined />;

  return (
    <CenteredScroll style={styles.screen} testID="account-setup">
      <View style={styles.form}>
        <Text role="heading" aria-level={1} style={styles.pitch}>
          Make your account
        </Text>
        {email === null ? null : (
          <Text variant="rowSub" style={styles.body}>
            Signed in as <Text style={styles.strong}>{email}</Text>
          </Text>
        )}

        <View style={styles.field}>
          <TextField
            label="Your name"
            value={name}
            onChangeText={setName}
            editable={!busy}
            maxLength={80}
            autoComplete="name"
            testID="account-setup-name"
          />
        </View>

        {phoneDone ? (
          <Text variant="rowSub" style={styles.body} testID="account-setup-phone-done">
            Your phone is <Text style={styles.strong}>{check?.phone ?? phoneSentTo}</Text>.
          </Text>
        ) : check === undefined ? null : phoneSentTo === null ? (
          <View style={styles.field}>
            <PhoneNumberField
              value={phone}
              onChangeText={setPhone}
              editable={!busy}
              onSubmitEditing={() => void sendPhone()}
              testID="account-setup-phone"
            />
            <Text variant="rowSub" style={styles.hint}>
              We text you a code. It keeps your account yours if you {leaving}.
            </Text>
            <View style={styles.primaryRow}>
              <Button
                label="Text me a code"
                variant="decision"
                disabled={busy || phone.trim() === ""}
                onPress={() => void sendPhone()}
                testID="account-setup-phone-send"
              />
            </View>
            {phoneError ? <Text variant="error" role="alert" style={styles.error}>{phoneError}</Text> : null}
          </View>
        ) : (
          <View style={styles.field}>
            <Text variant="rowSub" style={styles.body}>
              We sent a code to <Text style={styles.strong}>{phoneSentTo}</Text>.
            </Text>
            <View style={styles.codes}>
              <CodeBoxes
                value={phoneCode}
                editable={!busy}
                onChange={(value) => {
                  setPhoneCode(value);
                  if (value.length === OTP_LENGTH) void confirmPhone(value);
                }}
                testID="account-setup-phone-code"
              />
            </View>
            <View style={styles.row}>
              <Button label="Send a new code" variant="decision" disabled={busy} onPress={() => void sendPhone()} testID="account-setup-phone-resend" />
              <Button
                label="Use a different number"
                variant="decision"
                disabled={busy}
                onPress={() => {
                  setPhoneSentTo(null);
                  setPhoneCode("");
                  setPhoneError(null);
                }}
                testID="account-setup-phone-change"
              />
            </View>
            {phoneError ? <Text variant="error" role="alert" style={styles.error}>{phoneError}</Text> : null}
          </View>
        )}

        <View style={styles.primaryRow}>
          <Button
            label="Continue"
            variant="accent"
            disabled={!canFinishSetup({ name, phoneDone, busy })}
            onPress={() => void finishNow()}
            testID="account-setup-continue"
          />
        </View>
        {finishError ? <Text variant="error" role="alert" style={styles.error}>{finishError}</Text> : null}

        <Text
          variant="foot"
          role="link"
          style={styles.signOut}
          onPress={() => switchAccount("/")}
          testID="account-setup-sign-out"
        >
          Use another account
        </Text>
      </View>
    </CenteredScroll>
  );
}

