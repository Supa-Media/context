import { useEffect, type ReactNode } from "react";
import { usePathname } from "expo-router";
import { startActiveTime } from "./activeTime";
import { initObservability, trackActive, trackScreen } from "./client";

/** Starts both pipelines, records sanitized Expo Router screen names, and counts time in use. */
export function Observability({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  useEffect(() => {
    void initObservability();
    return startActiveTime(trackActive);
  }, []);

  useEffect(() => {
    trackScreen(pathname);
  }, [pathname]);

  return children;
}
