/**
 * One backup write per key: the last one made. A save writes its document's state twice (accepted, then rendered);
 * the backup is a copy nobody reads mid-save, so only where each key ended is handed back and copied.
 */
export function lastWriteEach(writes) {
  const last = new Map();
  for (const write of writes) {
    if (typeof write?.key !== "string" || typeof write.body !== "string") continue;
    last.delete(write.key);
    last.set(write.key, write);
  }
  return [...last.values()];
}
