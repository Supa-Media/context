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
import { confirmError as emailConfirmError, startError } from "../console/settings/panels/signInEmails";
import { canFinishSetup, finishFailure, initialName, phoneAlreadyDone } from "./accountSetupModel";
import { makeAccountSetupStyles } from "./accountSetupStyles";

/**
 * "Make your account" (board 2 of the domain sign-up, 2026-10-16). Drawn by
 * `app/(app)/_layout.tsx` after the domain join and before onboarding, for
 * somebody who signed in through a shared workspace's email domain and owns no
 * workspace yet. It asks for a name, a phone (texted a code) and a personal
 * email (mailed a code), then makes their own workspace; the layout then draws
 * the link they opened, on the same URL.
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
  const sendEmailCode = useAction(api.functions.signInEmails.startAddEmail);
  const checkEmailCode = useAction(api.functions.signInEmails.confirmAddEmail);
  const finish = useMutation(api.functions.accountSetup.finishSetup);
  const switchAccount = useSwitchAccount();

  const [name, setName] = useState(() => initialName(suggestedName));
  const [phone, setPhone] = useState("");
  const [phoneSentTo, setPhoneSentTo] = useState<string | null>(null);
  const [phoneCode, setPhoneCode] = useState("");
  const [phoneConfirmed, setPhoneConfirmed] = useState(false);
  const [joined, setJoined] = useState(false);
  const [draft, setDraft] = useState("");
  const [emailSentTo, setEmailSentTo] = useState<string | null>(null);
  const [emailCode, setEmailCode] = useState("");
  const [emailConfirmed, setEmailConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
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

  const sendEmail = () =>
    run(async () => {
      setEmailError(null);
      const result = await sendEmailCode({ email: emailSentTo ?? draft });
      setEmailError(startError(result.status));
      if (result.status === "sent" && result.email !== undefined) {
        setEmailSentTo(result.email);
        setEmailCode("");
      }
    }, setEmailError);

  const confirmEmail = (value: string) => {
    if (value.length !== OTP_LENGTH) return;
    return run(async () => {
      setEmailError(null);
      const result = await checkEmailCode({ code: value });
      if (result.status === "added" || result.status === "moved") setEmailConfirmed(true);
      else {
        setEmailError(emailConfirmError(result.status));
        setEmailCode("");
      }
    }, setEmailError);
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

        {emailConfirmed ? (
          <Text variant="rowSub" style={styles.body} testID="account-setup-email-done">
            Your personal email is <Text style={styles.strong}>{emailSentTo}</Text>.
          </Text>
        ) : emailSentTo === null ? (
          <View style={styles.field}>
            <TextField
              label="Personal email"
              value={draft}
              onChangeText={setDraft}
              placeholder="you@gmail.com"
              hint="Your notes stay reachable with this email if your work email goes away."
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              autoComplete="email"
              editable={!busy}
              onSubmitEditing={() => void sendEmail()}
              testID="account-setup-email"
            />
            <View style={styles.primaryRow}>
              <Button
                label="Email me a code"
                variant="decision"
                disabled={busy || draft.trim() === ""}
                onPress={() => void sendEmail()}
                testID="account-setup-email-send"
              />
            </View>
            {emailError ? <Text variant="error" role="alert" style={styles.error}>{emailError}</Text> : null}
          </View>
        ) : (
          <View style={styles.field}>
            <Text variant="rowSub" style={styles.body}>
              We sent a code to <Text style={styles.strong}>{emailSentTo}</Text>. It expires in ten minutes.
            </Text>
            <View style={styles.codes}>
              <CodeBoxes
                value={emailCode}
                editable={!busy}
                onChange={(value) => {
                  setEmailCode(value);
                  if (value.length === OTP_LENGTH) void confirmEmail(value);
                }}
                testID="account-setup-email-code"
              />
            </View>
            <View style={styles.row}>
              <Button label="Send a new code" variant="decision" disabled={busy} onPress={() => void sendEmail()} testID="account-setup-email-resend" />
              <Button
                label="Use a different email"
                variant="decision"
                disabled={busy}
                onPress={() => {
                  setEmailSentTo(null);
                  setEmailCode("");
                  setEmailError(null);
                }}
                testID="account-setup-email-change"
              />
            </View>
            {emailError ? <Text variant="error" role="alert" style={styles.error}>{emailError}</Text> : null}
          </View>
        )}

        <View style={styles.primaryRow}>
          <Button
            label="Continue"
            variant="accent"
            disabled={!canFinishSetup({ name, phoneDone, emailDone: emailConfirmed, busy })}
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

