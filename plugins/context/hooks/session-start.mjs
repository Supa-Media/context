#!/usr/bin/env node
/**
 * SessionStart hook: tell the agent to orient, or hand it the orientation.
 *
 * Always exits 0. A start hook that fails puts an error over the top of
 * somebody's first prompt, which is worse than not being installed;
 * `sessionStart` already falls back to the plain instruction on every failure.
 */
import { sessionStart } from "../src/commands.js";

await sessionStart({}).catch(() => {});
process.exit(0);
