/**
 * Ask, naming the address, then hand it to the system.
 *
 * The question draws the *contained* address and the answer opens the raw one:
 * this dialog is the only thing between a note's link and the browser, and it
 * works by being read. See `linkPrompt.ts`. Used by the iOS editor
 * (`LiveEditor.tsx`) for the web view's `open-url`.
 */

import { Alert, Linking } from "react-native";
import { linkPromptMessage } from "./linkPrompt";

export function confirmOpenUrl(url: string): void {
  Alert.alert("Open this link?", linkPromptMessage(url), [
    { text: "Cancel", style: "cancel" },
    { text: "Open", onPress: () => void Linking.openURL(url).catch(() => {}) },
  ]);
}
