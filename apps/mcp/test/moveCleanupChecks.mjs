/** Focused checks for bounded concurrent retirement in the move worker. */

import { check, call, contextStore, objects, storedText } from "./harness.mjs";
import { isLogicalDeleteMarker } from "../src/store/logicalDelete.js";
import { toolMaterializeMove } from "../src/tools/moves/materialize.js";

export async function finishMoveWithBoundedCleanup(moveId, initial) {
  let result = initial;
  let activeSourceReads = 0;
  let peakSourceReads = 0;
  let sawBoundedVerification = false;
  const originalBucketGet = contextStore.bucket.get;
  contextStore.bucket.get = async function (key) {
    if (!key.startsWith("1-projects/big-complete/")) return originalBucketGet.call(this, key);
    activeSourceReads += 1;
    peakSourceReads = Math.max(peakSourceReads, activeSourceReads);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return await originalBucketGet.call(this, key);
    } finally {
      activeSourceReads -= 1;
    }
  };
  try {
    for (let i = 0; i < 80 &&
      !isLogicalDeleteMarker(storedText(`.context/moves/${moveId}.json`)); i += 1) {
      result = await call("priv-token", "materialize_move", { id: moveId, batch_size: 100 });
      if (result.content?.[0]?.text?.includes("verified: 40/501")) sawBoundedVerification = true;
    }
  } finally {
    contextStore.bucket.get = originalBucketGet;
  }
  check("cleanup overlaps independent source checks within one bounded pass", peakSourceReads >= 2);
  check("large cleanup checkpoints its final source verification", sawBoundedVerification);
  return result;
}

export async function checkSettledConcurrentFailure() {
  // One cleanup failure must not lose the outcomes of other pairs already
  // started in the same concurrent group. The retry can then skip them.
  const id = "move-settled-cleanup-test";
  const items = [];
  for (let index = 0; index < 3; index += 1) {
    const source = `1-projects/settled-cleanup/note-${index}.md`;
    const destination = `1-projects/settled-cleanup-done/note-${index}.md`;
    const value = `settled ${index}`;
    const object = await contextStore.put(source, value);
    await contextStore.put(destination, index === 1 ? "changed destination" : value);
    items.push({ source, destination, etag: object.etag, size: value.length });
  }
  await contextStore.put(`.context/moves/${id}.json`, JSON.stringify({
    version: 1,
    id,
    source: "1-projects/settled-cleanup",
    destination: "1-projects/settled-cleanup-done",
    status: "needs_cleanup",
    objects: items,
    copied: items.map((item) => item.source),
    copied_objects: 3,
    deleted: [],
    deleted_objects: 0,
  }));
  const result = await toolMaterializeMove(contextStore, "private", id, 3);
  const marker = JSON.parse(storedText(`.context/moves/${id}.json`));
  check("a failed concurrent cleanup checkpoints independently retired sources",
    result.isError && marker.deleted.length === 2 &&
      marker.deleted.includes(items[0].source) && marker.deleted.includes(items[2].source) &&
      !objects.has(items[0].source) && objects.has(items[1].source) && !objects.has(items[2].source));
  await contextStore.delete(`.context/moves/${id}.json`);
  for (const item of items) {
    await contextStore.delete(item.source);
    await contextStore.delete(item.destination);
  }
}
