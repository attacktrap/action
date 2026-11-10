import { fileURLToPath } from "node:url";
import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, it } from "vitest";

const specPath = fileURLToPath(new URL("../openapi/action-v1.yaml", import.meta.url));

type Node = Record<string, unknown>;

function objectSchemas(node: unknown, at: string, found: [string, Node][] = []): [string, Node][] {
  if (Array.isArray(node)) {
    node.forEach((child, i) => objectSchemas(child, `${at}/${i}`, found));
  } else if (node && typeof node === "object") {
    const schema = node as Node;
    if (schema.type === "object") found.push([at, schema]);
    for (const [key, child] of Object.entries(schema)) objectSchemas(child, `${at}/${key}`, found);
  }
  return found;
}

describe("openapi/action-v1.yaml", async () => {
  const validator = new Validator();
  const result = await validator.validate(specPath);
  const spec = validator.specification as Node;

  it("is a valid OpenAPI document", () => {
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("declares the two operations", () => {
    const ids = Object.values(spec.paths as Record<string, Record<string, { operationId: string }>>).flatMap(
      (item) => Object.values(item).map((op) => op.operationId),
    );
    expect(ids.sort()).toEqual(["reportPlacement", "requestCanary"]);
  });

  it("closes every object schema", () => {
    const open = objectSchemas(spec, "#")
      .filter(([, schema]) =>
        schema.properties === undefined
          ? typeof schema.additionalProperties !== "object"
          : schema.additionalProperties !== false,
      )
      .map(([at]) => at);
    expect(open).toEqual([]);
  });
});
