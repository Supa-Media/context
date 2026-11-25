import { useEffect, type ReactNode } from "react";
import { usePathname } from "expo-router";
import { startActiveTime } from "./activeTime";
import { initObservability, trackActive, trackScreen } from "./client";
import { launchMs, noteLaunch } from "./vitals";

/** Starts both pipelines, records sanitized Expo Router screen names, and counts time in use. */
export function Observability({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  useEffect(() => {
    void initObservability();
    // After the first frame, so the time is the time to something on screen.
    const frame = requestAnimationFrame(() => noteLaunch(launchMs()));
    const stop = startActiveTime(trackActive);
    return () => {
      cancelAnimationFrame(frame);
      stop();
    };
  }, []);

  useEffect(() => {
    trackScreen(pathname);
  }, [pathname]);

  return children;
}
