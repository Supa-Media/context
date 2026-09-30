import { createContext } from "react";

/**
 * Whether the frame fills the box it is drawn in rather than the window.
 *
 * The console is the whole window everywhere but one place: a cast's chat
 * scene on the homepage, which sets Context on a desk as one window beside a
 * chat app's (Dev2, 2026-09-30). There the frame is sized by its window, and a
 * viewport-tall frame would run past the window's bottom edge and clip the
 * footer.
 */
export const FrameFillsParent = createContext(false);
