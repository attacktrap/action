import { readFileSync } from "node:fs";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";

const REF_PREFIX = "#/components/schemas/";

function localRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(localRefs);
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) =>
      key === "$ref" && typeof value === "string" ? [key, value.slice(REF_PREFIX.length)] : [key, localRefs(value)],
    ),
  );
}

export function specValidator(name: string): ValidateFunction {
  const spec = parse(readFileSync(new URL("../../openapi/action-v1.yaml", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: true, discriminator: true, allErrors: true });
  addFormats.default(ajv);
  for (const [schemaName, schema] of Object.entries(spec.components.schemas)) ajv.addSchema(localRefs(schema) as object, schemaName);
  return ajv.getSchema(name)!;
}
