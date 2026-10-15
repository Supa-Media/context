import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { registerNotifications } from "./register";

function permission(value: Notifications.NotificationPermissionsStatus) {
  return {
    allowed: value.granted || value.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL,
    canAskAgain: value.canAskAgain,
  };
}

/** Register with APNs. Never log or persist the device token. */
export function enableNotifications() {
  if (Platform.OS !== "ios") return Promise.resolve("failed" as const);
  return registerNotifications({
    prepare: async () => {},
    permissions: async () => permission(await Notifications.getPermissionsAsync()),
    request: async () => permission(await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: true, allowSound: true },
    })),
    register: async () => { await Notifications.getDevicePushTokenAsync(); },
  });
}
