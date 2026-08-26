import { createContext, useContext, type ReactNode } from "react";
import type { ConsoleData } from "./types";

/**
 * The console's data, shared down to the pane routes.
 *
 * The four panes are separate URLs, so they are separate route components —
 * but they must not each open their own Convex subscriptions, or switching
 * panes would re-fetch everything and the selected context would reset. The
 * layout owns the data; the panes read it.
 */
const ConsoleDataContext = createContext<ConsoleData | null>(null);

export function ConsoleDataProvider({
  value,
  children,
}: {
  value: ConsoleData;
  children: ReactNode;
}) {
  return <ConsoleDataContext.Provider value={value}>{children}</ConsoleDataContext.Provider>;
}

export function useConsoleData(): ConsoleData {
  const value = useContext(ConsoleDataContext);
  if (value === null) {
    throw new Error("useConsoleData must be used inside the console layout");
  }
  return value;
}
