import { Slot } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SupaConvexProvider } from "@supa-media/core/providers";
import { ensureFontsLoaded } from "../features/design/fonts";
import { colors } from "../features/design/tokens";

/**
 * Root layout for Context.
 *
 * `SupaConvexProvider` provides both the Convex client and auth context
 * (it wraps @convex-dev/auth's ConvexAuthProvider with platform-aware secure
 * token storage). Route groups under `(app)` and `(auth)` handle gating.
 *
 * The Convex URL is passed explicitly from app code: Expo only inlines
 * `EXPO_PUBLIC_*` env vars in app code, NOT inside node_modules (where
 * @supa-media/core lives), so the provider can't read it on its own.
 *
 * `ensureFontsLoaded` is a no-op on native and idempotent on web — `+html.tsx`
 * already links the faces, and this covers a host that serves its own shell.
 * It runs during module evaluation rather than in an effect so the stylesheet
 * request starts before the first paint.
 */
ensureFontsLoaded();

export default function RootLayout() {
  return (
    <KeyboardProvider>
      <SafeAreaProvider>
        <SupaConvexProvider url={process.env.EXPO_PUBLIC_CONVEX_URL}>
          <StatusBar style="light" />
          {/* One dark ground under every route, so nothing flashes white. */}
          <View style={{ flex: 1, backgroundColor: colors.ground }}>
            <Slot />
          </View>
        </SupaConvexProvider>
      </SafeAreaProvider>
    </KeyboardProvider>
  );
}
