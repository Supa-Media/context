import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * THE EDITOR REGION'S BOTTOM EDGE, SHARED.
 *
 * Two things float at the foot of the editor: the toasts (`ToastHost`, mounted
 * once by the console layout) and the announcement card Browse draws in the
 * corner. They are mounted in different places on purpose, the toasts because
 * the tree, the toolbar and the keyboard all raise them and the card because
 * it belongs to the pane whose notices it holds, so neither can lay the other
 * out. This is how they agree instead: the host says where the top of its
 * stack is, and the card sits above it.
 *
 * `showing` without a `top` is a toast that has not been measured yet. The
 * card steps aside for that frame rather than guessing a height and drawing
 * over it.
 */
export interface ToastEdge {
  showing: boolean;
  /** Distance from the region's bottom to the top of the toast stack, once measured. */
  top: number | null;
}

export const NO_TOASTS: ToastEdge = { showing: false, top: null };

const EdgeContext = createContext<ToastEdge>(NO_TOASTS);
const ReportContext = createContext<((edge: ToastEdge) => void) | null>(null);

/** Holds the edge for everything inside it. The console layout wraps the frame's children in one. */
export function ToastEdgeProvider({ children }: { children: ReactNode }) {
  const [edge, setEdge] = useState<ToastEdge>(NO_TOASTS);
  const report = useMemo(
    () => (next: ToastEdge) =>
      setEdge((current) => (current.showing === next.showing && current.top === next.top ? current : next)),
    [],
  );
  return (
    <ReportContext.Provider value={report}>
      <EdgeContext.Provider value={edge}>{children}</EdgeContext.Provider>
    </ReportContext.Provider>
  );
}

/** Where the toasts are, for anything else floating at the same edge. */
export function useToastEdge(): ToastEdge {
  return useContext(EdgeContext);
}

/** The host's half: `null` outside a provider, and then there is nobody to tell. */
export function useReportToastEdge(): ((edge: ToastEdge) => void) | null {
  return useContext(ReportContext);
}

/**
 * Where something floating at `base` from the bottom must sit so a toast never
 * covers it: unchanged with no toasts, above the stack once it is measured, and
 * `null` (put away) for the frame in between.
 */
export function clearOfToasts(base: number, edge: ToastEdge, gap: number): number | null {
  if (!edge.showing) return base;
  if (edge.top === null) return null;
  return Math.max(base, edge.top + gap);
}
