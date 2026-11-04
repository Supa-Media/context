/**
 * The workspace's storage binding, kept in its own object sealed so the object cannot read it (decided by the owner,
 * 2026-11-02; `docs/decisions/storage-and-credentials/credential-basics.md`, "A binding kept in its workspace's
 * object is sealed to it").
 *
 * The gateway seals what the control plane's `/gateway/binding` answered (`bindingSeal.js`) and keeps it here, so a
 * later request opens its store from one call to this object instead of a round trip through the control plane
 * (`store/objectBinding.js`). Only sealed text is held: the bucket credential and index tokens inside it open only
 * with a key derived from the gateway's secret, and only for this workspace.
 *
 * **Never stale past a change.** Every control-plane write to what the binding is made of (the bucket and its
 * credential, managed encryption, where the notes live) leaves an outbox entry that the push turns into
 * `ws.binding.clear` (`apps/convex/functions/lib/rowWatch/watch.ts`). A clear moves the epoch on, and a put names
 * the epoch it saw before it asked the control plane: a binding read before a change can never be kept after the
 * clear that change caused.
 */

import { setupHeldRules } from "./setupRules.js";

const SCHEMA = [`CREATE TABLE IF NOT EXISTS ws_binding (id INTEGER PRIMARY KEY CHECK (id = 1), sealed TEXT, at INTEGER, epoch INTEGER NOT NULL)`];

/** The most a sealed binding may weigh: a binding and its siblings are a few kilobytes. */
export const MAX_SEALED_BYTES = 64 * 1024;
const SEALED = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Thrown for a put the object will not keep. */
export class BindingRowRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "BindingRowRefused";
  }
}

const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);

export function bindingRows(sql) {
  for (const statement of SCHEMA) sql.exec(statement);
  const held = () => all(sql.exec("SELECT sealed, at, epoch FROM ws_binding WHERE id = 1"))[0] ?? null;
  return {
    /** `{sealed, at, epoch}`, with `sealed`/`at` null when none is kept. */
    get() {
      const row = held();
      if (row === null) return { sealed: null, at: null, epoch: 0 };
      return { sealed: row.sealed ?? null, at: row.at === null || row.at === undefined ? null : Number(row.at), epoch: Number(row.epoch) };
    },
    /** Keep `sealed`, read at `at`, only while the epoch is still the one the reader saw. */
    put({ sealed, at, epoch }) {
      if (typeof sealed !== "string" || sealed.length > MAX_SEALED_BYTES || !SEALED.test(sealed)) throw new BindingRowRefused("not a sealed binding");
      if (!Number.isFinite(at) || at <= 0) throw new BindingRowRefused("a sealed binding needs its clock");
      if (!Number.isInteger(epoch) || epoch < 0) throw new BindingRowRefused("a sealed binding names the epoch it was read in");
      const current = this.get().epoch;
      if (epoch !== current) return { kept: false, epoch: current };
      sql.exec("INSERT INTO ws_binding (id, sealed, at, epoch) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET sealed = excluded.sealed, at = excluded.at", sealed, Math.trunc(at), current);
      return { kept: true, epoch: current };
    },
    /** Drop what is kept and move the epoch on, so nothing read before now can be put back. */
    clear() {
      const epoch = this.get().epoch + 1;
      sql.exec("INSERT INTO ws_binding (id, sealed, at, epoch) VALUES (1, NULL, NULL, ?) ON CONFLICT (id) DO UPDATE SET sealed = NULL, at = NULL, epoch = excluded.epoch", epoch);
      return { epoch };
    },
  };
}

/** The calls this module answers. `ws.open` and `ws.binding.put` are the gateway's own: the door refuses both. */
export const BINDING_OPS = Object.freeze({ OPEN: "ws.open", PUT: "ws.binding.put", CLEAR: "ws.binding.clear" });

/**
 * `ws.open {userId}`: everything a request's store is built from, in one call. Where this object decides access
 * (`accessHome: "object"`) and `userId` is a live member, the member rules and the sealed binding; for anybody else,
 * neither, so the gateway asks the control plane as before. It answers once no mark is open, or after the object's wait
 * with `behind: true` (`marks.js`). `ws.binding.put`, `ws.binding.clear` as above.
 * Answers `null` for any other op.
 */
export function serveBindingCall(store, op, fields, accessHomeObject, { behind = false } = {}) {
  const binding = store.binding ?? null;
  switch (op) {
    case BINDING_OPS.OPEN: {
      const members = store.members ?? null;
      const accessHome = members === null ? null : members.home();
      const member = accessHome === accessHomeObject && typeof fields.userId === "string" && members.member(fields.userId) !== null;
      const kept = binding === null ? { sealed: null, at: null, epoch: 0 } : binding.get();
      /*
        Tex's setup read (`setupRules.js`): the member rules narrowed to the setup's folders, and the binding, for a
        reader who need not be a member. Only the gateway asks this (the door refuses `ws.open`), and only for the
        pinned workspace and a Tex client (`store/objectBinding.js`); the full member rules never leave for it.
      */
      if (fields.setupRead === true) {
        const narrowed = accessHome === accessHomeObject ? setupHeldRules(store.rows.rules("member")) : null;
        return Response.json({
          home: store.rows.home(),
          backfilledAt: store.rows.backfilledAt(),
          encryption: store.rows.encryption(),
          accessHome,
          member: false,
          setupRead: narrowed !== null,
          rules: narrowed,
          binding: narrowed !== null && kept.sealed !== null ? { sealed: kept.sealed, at: kept.at } : null,
          epoch: kept.epoch,
          behind: behind === true,
        });
      }
      return Response.json({
        home: store.rows.home(),
        backfilledAt: store.rows.backfilledAt(),
        encryption: store.rows.encryption(),
        accessHome,
        member,
        rules: member ? store.rows.rules("member") : null,
        binding: member && kept.sealed !== null ? { sealed: kept.sealed, at: kept.at } : null,
        epoch: kept.epoch,
        // Whether a mark was still open after the object's wait (`marks.js`): a narrowing change is coming.
        behind: behind === true,
      });
    }
    case BINDING_OPS.PUT:
      if (binding === null) throw new BindingRowRefused("this object keeps no binding");
      return Response.json(binding.put({ sealed: fields.sealed, at: fields.at, epoch: fields.epoch }));
    case BINDING_OPS.CLEAR:
      return Response.json(binding === null ? { epoch: 0 } : binding.clear());
    default:
      return null;
  }
}
