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

/**
 * Whether a phone frame is drawn without its floating chrome: the top row's
 * buttons and the search bar at the foot. Only a cast playing on a phone sets
 * it, where Context is one of two small windows in a recording and those
 * buttons would cover the folders and notes the scene is about (Dev2,
 * 2026-09-30, the approved artboards). The page, the path and the tree are
 * the real ones.
 */
export const FrameBare = createContext(false);
