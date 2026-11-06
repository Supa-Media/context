/**
 * The machine protocol: what a person's machine runner and the workspace
 * object that owns the machine say to each other.
 *
 * The protocol is one JSON Schema, `machineProtocol.schema.json`, beside this
 * file. Three things are made from it and checked against it in tests:
 * `machineProtocol.generated.ts` (the gateway's and the app's types, written by
 * `packages/shared/scripts/machineProtocolTypes.mjs`), the runner's Rust types
 * (`apps/machine-runner`), and the validator below, which every frame from a
 * runner passes through before the workspace object reads a field of it.
 *
 * The validator covers exactly the keywords the schema uses, and refuses a
 * schema that uses one it does not know, so a keyword added to the schema
 * without being taught here fails the tests instead of being ignored (a guard
 * that silently ignores a rule is not a guard). It stays dependency-free
 * because the gateway does (CLAUDE.md, "The gateway").
 *
 * Decided with the owner, 2026-11-03 and 2026-11-04
 * (docs/decisions/texting-assistant/machines.md).
 */

"use strict";

const schema = require("./machineProtocol.schema.json");

const PROTOCOL_VERSION = schema["x-protocol-version"];
/** The largest frame either side sends, in UTF-8 bytes. A bigger one closes the socket. */
const MAX_FRAME_BYTES = 128 * 1024;

const KNOWN = new Set([
  "$schema", "$id", "$ref", "$defs", "title", "description", "x-protocol-version",
  "type", "const", "enum", "oneOf", "properties", "required", "additionalProperties",
  "items", "minItems", "maxItems", "minLength", "maxLength", "pattern", "minimum", "maximum",
]);

function resolve(node) {
  if (!node.$ref) return node;
  const match = /^#\/\$defs\/([A-Za-z]+)$/.exec(node.$ref);
  if (!match || !schema.$defs[match[1]]) throw new Error(`machineProtocol: unknown $ref ${node.$ref}`);
  return schema.$defs[match[1]];
}

const patterns = new Map();
function patternOf(source) {
  let re = patterns.get(source);
  if (!re) {
    re = new RegExp(source, "u");
    patterns.set(source, re);
  }
  return re;
}

function typeOk(type, value) {
  switch (type) {
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "integer": return Number.isSafeInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    default: throw new Error(`machineProtocol: unknown type ${type}`);
  }
}

/**
 * The first reason `value` does not match `node`, as a JSON-pointer-ish path
 * and a word, or null when it matches.
 */
function check(node, value, path) {
  for (const key of Object.keys(node)) {
    if (!KNOWN.has(key)) throw new Error(`machineProtocol: schema keyword ${key} at ${path} is not checked by the validator`);
  }
  if (node.$ref) {
    // Beside a $ref only words may sit: a rule there would be ignored here.
    for (const key of Object.keys(node)) {
      if (key !== "$ref" && key !== "description") throw new Error(`machineProtocol: ${key} beside $ref at ${path} is not checked`);
    }
    return check(resolve(node), value, path);
  }
  if (node.oneOf) {
    let matched = 0;
    let first = null;
    for (const option of node.oneOf) {
      const why = check(option, value, path);
      if (why === null) matched += 1;
      else if (!first) first = why;
    }
    if (matched === 1) return null;
    return matched === 0 ? (oneOfHint(node.oneOf, value, path) ?? first) : `${path}: matches ${matched} shapes`;
  }
  if ("const" in node && value !== node.const) return `${path}: must be ${JSON.stringify(node.const)}`;
  if (node.enum && !node.enum.includes(value)) return `${path}: not one of ${node.enum.join(", ")}`;
  if (node.type && !typeOk(node.type, value)) return `${path}: must be ${node.type}`;
  if (typeof value === "string") {
    const length = [...value].length;
    if (node.minLength !== undefined && length < node.minLength) return `${path}: too short`;
    if (node.maxLength !== undefined && length > node.maxLength) return `${path}: too long`;
    if (node.pattern && !patternOf(node.pattern).test(value)) return `${path}: bad format`;
  }
  if (typeof value === "number") {
    if (node.minimum !== undefined && value < node.minimum) return `${path}: below ${node.minimum}`;
    if (node.maximum !== undefined && value > node.maximum) return `${path}: above ${node.maximum}`;
  }
  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) return `${path}: too few items`;
    if (node.maxItems !== undefined && value.length > node.maxItems) return `${path}: too many items`;
    if (node.items) {
      for (let i = 0; i < value.length; i += 1) {
        const why = check(node.items, value[i], `${path}/${i}`);
        if (why) return why;
      }
    }
  }
  if (node.type === "object") {
    const props = node.properties ?? {};
    for (const key of node.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) return `${path}/${key}: required`;
    }
    for (const key of Object.keys(value)) {
      if (Object.prototype.hasOwnProperty.call(props, key)) {
        const why = check(props[key], value[key], `${path}/${key}`);
        if (why) return why;
      } else if (node.additionalProperties === false) {
        return `${path}/${key}: not allowed`;
      }
    }
  }
  return null;
}

/** For a tagged union, the reason from the one shape whose `type` matched, not the first shape tried. */
function oneOfHint(options, value, path) {
  if (!value || typeof value !== "object" || typeof value.type !== "string") return null;
  for (const option of options) {
    const node = resolve(option);
    if (node.properties?.type?.const === value.type) return check(node, value, path);
  }
  return `${path}/type: unknown message ${JSON.stringify(value.type).slice(0, 40)}`;
}

/** Null when `value` is a valid `name` (a `$defs` entry), else the first reason it is not. */
function invalid(name, value) {
  const node = schema.$defs[name];
  if (!node) throw new Error(`machineProtocol: no definition named ${name}`);
  return check(node, value, "");
}

/**
 * One frame from a runner, as text: `{ ok: true, message }` when it is a
 * valid `RunnerMessage`, else `{ ok: false, error }`. Never throws on the
 * frame's content.
 */
function parseRunnerFrame(text) {
  return parseFrame("RunnerMessage", text);
}

/** The same for a frame the workspace object sends; the runner's tests and the fake runner use it. */
function parseServerFrame(text) {
  return parseFrame("ServerMessage", text);
}

function parseFrame(name, text) {
  if (typeof text !== "string") return { ok: false, error: "frame is not text" };
  if (new TextEncoder().encode(text).length > MAX_FRAME_BYTES) return { ok: false, error: "frame too large" };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "frame is not JSON" };
  }
  const why = invalid(name, value);
  return why ? { ok: false, error: why } : { ok: true, message: value };
}

/**
 * The exact text a runner signs to answer a challenge. Bound to the protocol,
 * the purpose and the machine, so a signature made for pairing, or for another
 * machine, never passes as a hello.
 */
function helloSigningText(machineId, nonce) {
  return `context-machine-hello:v${PROTOCOL_VERSION}:${machineId}:${nonce}`;
}

/** The exact text a runner signs to collect its grant after the owner approved it. */
function pairSigningText(pairingId) {
  return `context-machine-pair:v${PROTOCOL_VERSION}:${pairingId}`;
}

/**
 * Slot counts from a machine's memory and cores (design, "Slots"): about
 * 1.5 GB and half a core per session. Recommended keeps 4 GB for the person;
 * most keeps 2 GB. Both are at least 1 and at most 8.
 */
const SESSION_MB = 1536;
const MAX_SLOTS = 8;
function slotCounts(memoryMb, cores) {
  const clamp = (n) => Math.max(1, Math.min(MAX_SLOTS, Math.floor(n)));
  return {
    recommended: clamp(Math.min((memoryMb - 4096) / SESSION_MB, cores / 2)),
    most: clamp(Math.min((memoryMb - 2048) / SESSION_MB, cores)),
  };
}

const HOUR = 60 * 60 * 1000;
/** A machine's limits before its owner changes any (design, "Usage limits"). */
const DEFAULT_LIMITS = Object.freeze({
  slots: 2,
  dayMs: 4 * HOUR,
  weekMs: 20 * HOUR,
  othersDayMs: 2 * HOUR,
  othersRunsPerDay: 10,
  longestRunMs: 4 * HOUR,
  pauseNearPlanLimit: true,
  keepOneForOwner: false,
});
/** The longest a machine job may ever run (owner, 2026-11-04). */
const MAX_LONGEST_RUN_MS = 24 * HOUR;

module.exports = {
  schema,
  PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  DEFAULT_LIMITS,
  MAX_LONGEST_RUN_MS,
  MAX_SLOTS,
  invalid,
  parseRunnerFrame,
  parseServerFrame,
  helloSigningText,
  pairSigningText,
  slotCounts,
};
