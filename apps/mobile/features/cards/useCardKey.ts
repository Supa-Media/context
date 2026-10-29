import { useEffect } from "react";
import { AppState, Platform } from "react-native";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { MCP_ENDPOINT } from "../console/placeholderData";
import { CARD_DEVICE_NAME, CARD_KEY_NAME, CARD_KEY_SERVICE, cardKeyGroup, cardKeyIsFor, cardKeyRecord, newDeviceId } from "./cardKey";

/**
 * Leaves the card key for the Messages extension (`cardKey.ts` says why it is
 * written only where there is none), on iOS, for the signed-in person's own
 * personal workspace; checks again whenever the app comes to the front, so a
 * key the extension dropped (revoked, refused) is replaced the next time the
 * app is opened. Deleted when the person signs out.
 *
 * Failures are dropped: without a key a card says to open Context, and the
 * next foreground tries again.
 */
/**
 * The keychain and the shared item's options, loaded on iOS only (and so never
 * in the layout's tests, which render for the web).
 */
async function keychain() {
  const [SecureStore, Application] = await Promise.all([import("expo-secure-store"), import("expo-application")]);
  const group = cardKeyGroup(Application.applicationId);
  return group === null ? null : { SecureStore, shared: { keychainService: CARD_KEY_SERVICE, accessGroup: group } };
}

export function useCardKey(options: { workspaceId: string | undefined; signedOut: boolean }): void {
  const mint = useAction(api.functions.cardsKey.mintCardsKey);
  const { workspaceId, signedOut } = options;

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    if (signedOut) {
      void keychain().then((k) => k && k.SecureStore.deleteItemAsync(CARD_KEY_NAME, k.shared)).catch(() => undefined);
      return;
    }
    if (workspaceId === undefined) return;
    let busy = false;
    const ensure = async () => {
      if (busy) return;
      busy = true;
      try {
        const k = await keychain();
        if (k === null) return;
        const { SecureStore, shared } = k;
        const stored = await SecureStore.getItemAsync(CARD_KEY_NAME, shared);
        if (cardKeyIsFor(stored, workspaceId)) return;
        // Another account's key, or a broken one: never shown to this person.
        if (stored !== null) await SecureStore.deleteItemAsync(CARD_KEY_NAME, shared);
        let deviceId = await SecureStore.getItemAsync(CARD_DEVICE_NAME);
        if (deviceId === null) {
          deviceId = newDeviceId();
          await SecureStore.setItemAsync(CARD_DEVICE_NAME, deviceId);
        }
        const minted = await mint({ workspaceId: workspaceId as Id<"workspaces">, deviceId });
        const record = cardKeyRecord(minted, MCP_ENDPOINT, workspaceId);
        if (record === null) return;
        await SecureStore.setItemAsync(CARD_KEY_NAME, record, {
          ...shared,
          keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
        });
      } catch {
        // Next foreground.
      } finally {
        busy = false;
      }
    };
    void ensure();
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void ensure();
    });
    return () => listener.remove();
  }, [mint, workspaceId, signedOut]);
}
