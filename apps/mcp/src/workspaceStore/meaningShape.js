/** The meaning index's passage shape, shared by the index (`meaningIndex.js`) and its snapshot (`meaningSnapshot.js`). */
import { MEANING_DIMENSIONS } from "../search/meaning/embed.js";

/** 32-bit words of one passage's sign bits. */
export const WORDS = MEANING_DIMENSIONS / 32;
/** The tiers a passage is kept at, by their number in a packed index. */
export const TIERS = ["private", "team"];
