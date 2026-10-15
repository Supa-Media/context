import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { registerNotifications } from "./register";

function permission(value: Notifications.NotificationPermissionsStatus) {
  return {
    allowed: value.granted || value.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL,
    canAskAgain: value.canAskAgain,
  };
}

/** Register with APNs/FCM. Never log or persist the device token. */
export function enableNotifications() {
  return registerNotifications({
    prepare: async () => {
      if (Platform.OS === "android") {
        await Notifications.setNotificationChannelAsync("default", {
          name: "Context", importance: Notifications.AndroidImportance.DEFAULT,
        });
      }
    },
    permissions: async () => permission(await Notifications.getPermissionsAsync()),
    request: async () => permission(await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: true, allowSound: true },
    })),
    register: async () => { await Notifications.getDevicePushTokenAsync(); },
  });
}
