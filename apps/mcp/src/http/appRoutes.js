/**
 * Routes only the Context app's own clients answer to, each checking its
 * client itself: what the egress gate is holding (`approvals.js`, the
 * console's), and what a card in Messages shows (`cards.js`, the card key's).
 * `route.js` resolves the session for them as it does for `/mcp`, with read
 * scope, and lets each take GET.
 */

import { handleApprovals } from "./approvals.js";
import { CARD_PATHS, handleCards } from "./cards.js";

export const APP_ROUTES = new Map([["/approvals", handleApprovals], ...CARD_PATHS.map((path) => [path, handleCards])]);
