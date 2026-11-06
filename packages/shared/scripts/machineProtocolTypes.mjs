/**
 * Writes `src/machineProtocol.generated.ts` from `src/machineProtocol.schema.json`.
 *
 *     node packages/shared/scripts/machineProtocolTypes.mjs          # write it
 *     node packages/shared/scripts/machineProtocolTypes.mjs --check  # fail if it is stale
 *
 * The gateway test `machineProtocol.test.mjs` runs `--check`'s logic too, so a
 * schema change without the regenerated file fails CI. Hand-rolled rather than
 * a dependency because it covers only the keywords the schema uses, and the
 * validator in `machineProtocol.cjs` refuses any other.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const SCHEMA = join(SRC, "machineProtocol.schema.json");
const OUT = join(SRC, "machineProtocol.generated.ts");

function typeOf(node, indent) {
  if (node.$ref) return node.$ref.replace("#/$defs/", "");
  if (node.oneOf) return node.oneOf.map((n) => typeOf(n, indent)).join(" | ");
  if ("const" in node) return JSON.stringify(node.const);
  if (node.enum) return node.enum.map((v) => JSON.stringify(v)).join(" | ");
  switch (node.type) {
    case "string": return "string";
    case "integer":
    case "number": return "number";
    case "boolean": return "boolean";
    case "array": {
      const inner = typeOf(node.items, indent);
      return /[ |]/.test(inner) ? `Array<${inner}>` : `${inner}[]`;
    }
    case "object": return objectOf(node, indent);
    default: throw new Error(`no TypeScript for ${JSON.stringify(node).slice(0, 80)}`);
  }
}

function comment(text, indent) {
  if (!text) return "";
  return `${indent}/** ${text.replace(/\*\//g, "*\\/")} */\n`;
}

function objectOf(node, indent) {
  const required = new Set(node.required ?? []);
  const inner = indent + "  ";
  const lines = Object.entries(node.properties ?? {}).map(
    ([key, prop]) => `${comment(prop.description, inner)}${inner}${key}${required.has(key) ? "" : "?"}: ${typeOf(prop, inner)};`,
  );
  return `{\n${lines.join("\n")}\n${indent}}`;
}

export function generate(schema = JSON.parse(readFileSync(SCHEMA, "utf8"))) {
  const out = [
    "/**",
    " * Generated from machineProtocol.schema.json by",
    " * packages/shared/scripts/machineProtocolTypes.mjs. Do not edit by hand:",
    " * change the schema and run the script.",
    " */",
    "",
    "/* eslint-disable */",
    "",
    `export const MACHINE_PROTOCOL_VERSION = ${schema["x-protocol-version"]} as const;`,
    "",
  ];
  for (const [name, node] of Object.entries(schema.$defs)) {
    out.push(`${comment(node.description, "")}export type ${name} = ${typeOf(node, "")};`, "");
  }
  return out.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = generate();
  if (process.argv.includes("--check")) {
    if (readFileSync(OUT, "utf8") !== text) {
      console.error("machineProtocol.generated.ts is stale: run node packages/shared/scripts/machineProtocolTypes.mjs");
      process.exit(1);
    }
  } else {
    writeFileSync(OUT, text);
  }
}
