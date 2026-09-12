import { useEffect, type ReactNode } from "react";
import { usePathname } from "expo-router";
import { initObservability, trackScreen } from "./client";

/** Starts both pipelines and records sanitized Expo Router screen names. */
export function Observability({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  useEffect(() => {
    void initObservability();
  }, []);

  useEffect(() => {
    trackScreen(pathname);
  }, [pathname]);

  return children;
}
