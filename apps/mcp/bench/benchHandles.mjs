/**
 * The bench's people by handle: what `set_visibility`'s `people` resolves a world person through. `createWorld` seeds the
 * control plane stub's directory from `people.md` with `seedHandles`, so a person named as `@handle` is found and nobody
 * else is.
 */

/**
 * Each person `people.md` names, by the handle an AI client names them with (`@maya`: the name lower-cased, letters,
 * digits and hyphens only, as `groupChat.mjs` names a member), and the account the control plane's directory resolves
 * it to. A person's personal workspace names their account (`user_bench_<workspace>`, the user its grant carries); a
 * person with none gets an account of their own name. Nobody outside `people.md` is in it.
 */
export function benchHandles(bench) {
  const handles = new Map();
  const nameOf = (row) => String(row.person).toLowerCase().replace(/[^a-z0-9-]/g, "");
  for (const row of bench.people.filter((entry) => entry.personal)) {
    if (nameOf(row) !== "") handles.set(`@${nameOf(row)}`, { kind: "user", id: `user_bench_${row.workspace}` });
  }
  for (const row of bench.people) {
    if (nameOf(row) !== "" && !handles.has(`@${nameOf(row)}`)) handles.set(`@${nameOf(row)}`, { kind: "user", id: `user_bench_${nameOf(row)}` });
  }
  return handles;
}

/** Seed a control plane stub's handle directory with the world's people. */
export function seedHandles(controlPlane, bench) {
  for (const [handle, who] of benchHandles(bench)) controlPlane.knownHandles.set(handle, who);
}
