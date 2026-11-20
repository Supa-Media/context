/**
 * Guards the double-lease of 2026-11-19: a status-filtered listing of the Lab's runs left out live
 * holders, so one runner slot was handed to two runs at once, and two runs signed in with the same
 * refresh token. activeLabRuns must also list the newest runs unfiltered and count every run that is
 * not completed, and a failed listing must throw so the lease falls back to the shared runner.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { activeLabRuns } from "./lab-runner-lease.mjs";

const REPO = "Supa-Media/context";
const PREFIX = `repos/${REPO}/actions/workflows/tex-lab-run.yml/runs?`;

test("a live run the status-filtered listing leaves out is still active", async () => {
  const gh = async (args) => {
    const url = args[1];
    if (url.includes("status=")) return url.endsWith("status=in_progress&per_page=100") ? "111\n" : "";
    return "111\n777\n";
  };
  const ids = await activeLabRuns(REPO, "fake-token", {}, gh);
  assert.deepEqual([...ids].sort(), ["111", "777"]);
});

test("a completed run is not active", async () => {
  const gh = async (args) => {
    const url = args[1];
    if (url.includes("status=")) return "";
    // Only the completed-filtering jq expression keeps a completed run out; a plain listing would include it.
    return args[3].includes('select(.status != "completed")') ? "555\n" : "555\n999\n";
  };
  const ids = await activeLabRuns(REPO, "fake-token", {}, gh);
  assert.deepEqual(ids, ["555"]);
});

test("a failed listing throws, so the lease falls back to the shared runner", async () => {
  const gh = async (args) => {
    if (!args[1].includes("status=")) throw new Error("listing failed");
    return "";
  };
  await assert.rejects(activeLabRuns(REPO, "fake-token", {}, gh));
});

test("every listing names the Lab workflow and only that repository", async () => {
  const seen = [];
  const gh = async (args) => {
    seen.push(args);
    return "";
  };
  await activeLabRuns(REPO, "fake-token", {}, gh);
  assert.ok(seen.length > 1);
  for (const args of seen) assert.ok(args[1].startsWith(PREFIX), `unexpected listing: ${args[1]}`);
});
