/** The bench world's paired computer (`world.mjs`): a stand-in the turn's job tools read through `MACHINE_STORE`. */

/** An invented paired computer, in the person's own workspace only, as its object lists it (`ws.machine.list`, `ws.machine.get`). */
export function benchMachines({ name, tools, slots }, workspaceId) {
  const machine = { id: "mch_bench_computer", name, online: true, tools, folders: ["~/code"], ownerId: "bench-owner", limits: { slots } };
  return {
    idFromName: (id) => id,
    get: (objectName) => ({
      async fetch(request) {
        const op = new URL(request.url).pathname.slice(1);
        if (op === "ws.machine.list") return Response.json({ ok: true, machines: objectName === `workspace:${workspaceId}` ? [machine] : [] });
        if (op === "ws.machine.get") return Response.json({ ok: true, machine });
        return Response.json({ error: "unknown_op" }, { status: 400 });
      },
    }),
  };
}
