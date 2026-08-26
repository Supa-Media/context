import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useAuthActions } from "@convex-dev/auth/react";

/**
 * OTP login for Context.
 *
 * Two steps: request a one-time code for the email, then verify it.
 * Backed by @convex-dev/auth's "email" provider
 * (configured in apps/convex/auth.ts).
 */
export default function LoginScreen() {
  const { signIn } = useAuthActions();
  const router = useRouter();

  const [step, setStep] = useState<"request" | "verify">("request");
  const [identifier, setIdentifier] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function requestCode() {
    setError(null);
    setSubmitting(true);
    try {
      await signIn("email", { email: identifier.trim() });
      setStep("verify");
    } catch (e) {
      setError("Couldn't send your code. Check your email and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function verifyCode() {
    setError(null);
    setSubmitting(true);
    try {
      await signIn("email", {
        email: identifier.trim(),
        code: code.trim(),
      });
      router.replace("/");
    } catch (e) {
      setError("That code didn't work. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Context</Text>
        <Text style={styles.subtitle}>
          {step === "request"
            ? "Sign in to continue"
            : `Enter the code sent to ${identifier}`}
        </Text>

        {step === "request" ? (
          <TextInput
            style={styles.input}
            value={identifier}
            onChangeText={setIdentifier}
            placeholder="you@example.com"
            placeholderTextColor="#9ca3af"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            autoComplete="email"
            editable={!submitting}
          />
        ) : (
          <TextInput
            style={styles.input}
            value={code}
            onChangeText={setCode}
            placeholder="123456"
            placeholderTextColor="#9ca3af"
            keyboardType="number-pad"
            autoComplete="one-time-code"
            editable={!submitting}
          />
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable
          style={[styles.button, submitting && styles.buttonDisabled]}
          onPress={step === "request" ? requestCode : verifyCode}
          disabled={submitting || (step === "request" ? !identifier : !code)}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>
              {step === "request" ? "Send code" : "Verify"}
            </Text>
          )}
        </Pressable>

        {step === "verify" ? (
          <Pressable
            onPress={() => {
              setStep("request");
              setCode("");
              setError(null);
            }}
            disabled={submitting}
          >
            <Text style={styles.link}>Use a different email</Text>
          </Pressable>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  content: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
    gap: 12,
  },
  title: { fontSize: 32, fontWeight: "700", marginBottom: 4 },
  subtitle: { fontSize: 16, color: "#666", marginBottom: 16 },
  input: {
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  button: {
    backgroundColor: "#111827",
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 4,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  link: { color: "#2563eb", textAlign: "center", marginTop: 4 },
  error: { color: "#dc2626", fontSize: 14 },
});
