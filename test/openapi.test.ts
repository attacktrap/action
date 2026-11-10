import { fileURLToPath } from "node:url";
import { Validator } from "@seriousme/openapi-schema-validator";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

const specPath = fileURLToPath(new URL("../openapi/action-v1.yaml", import.meta.url));
const REF_PREFIX = "#/components/schemas/";
const FORBIDDEN = ["allOf", "anyOf", "not", "if", "then", "else", "patternProperties", "unevaluatedProperties", "dependentSchemas"];

type Schema = Record<string, unknown>;
type Media = { schema: Schema; examples?: Record<string, { value: unknown }> };
type Operation = {
  operationId: string;
  parameters?: { schema: Schema }[];
  requestBody?: { content: Record<string, Media> };
  responses: Record<string, { content?: Record<string, Media> }>;
};
type Spec = { paths: Record<string, Record<string, Operation>>; components: { schemas: Record<string, Schema> } };

function localRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(localRefs);
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) =>
      key === "$ref" && typeof value === "string" ? [key, value.slice(REF_PREFIX.length)] : [key, localRefs(value)],
    ),
  );
}

function subschemas(schema: Schema): [string, Schema][] {
  const children: [string, Schema][] = [];
  for (const [name, child] of Object.entries((schema.properties ?? {}) as Record<string, Schema>)) {
    children.push([`properties/${name}`, child]);
  }
  if (schema.items) children.push(["items", schema.items as Schema]);
  if (typeof schema.additionalProperties === "object") {
    children.push(["additionalProperties", schema.additionalProperties as Schema]);
  }
  ((schema.oneOf ?? []) as Schema[]).forEach((child, i) => children.push([`oneOf/${i}`, child]));
  return children;
}

function openings(schema: Schema, at: string): string[] {
  const problems = FORBIDDEN.filter((key) => key in schema).map((key) => `${at} uses ${key}`);
  if (schema.type !== undefined && typeof schema.type !== "string") problems.push(`${at} has a type list`);
  if (schema.properties !== undefined && (schema.type !== "object" || schema.additionalProperties !== false)) {
    problems.push(`${at} has properties but is not a closed object`);
  }
  if (schema.type === "object" && schema.properties === undefined && schema.oneOf === undefined) {
    const values = schema.additionalProperties as Schema | undefined;
    if (!values || typeof values !== "object" || !("type" in values || "$ref" in values)) {
      problems.push(`${at} is a map with untyped values`);
    }
  }
  for (const [key, child] of subschemas(schema)) problems.push(...openings(child, `${at}/${key}`));
  return problems;
}

describe("openapi/action-v1.yaml", async () => {
  const validator = new Validator();
  const result = await validator.validate(specPath);
  const spec = validator.specification as unknown as Spec;
  const operations = Object.values(spec.paths).flatMap((item) => Object.values(item));
  const media = operations.flatMap((op) => [
    ...Object.values(op.requestBody?.content ?? {}),
    ...Object.values(op.responses).flatMap((response) => Object.values(response.content ?? {})),
  ]);
  const roots: [string, Schema][] = [
    ...Object.entries(spec.components.schemas).map(([name, schema]): [string, Schema] => [`${REF_PREFIX}${name}`, schema]),
    ...operations.flatMap((op) => [
      ...(op.parameters ?? []).map((p, i): [string, Schema] => [`${op.operationId}/parameters/${i}`, p.schema]),
      ...[...Object.values(op.requestBody?.content ?? {}), ...Object.values(op.responses).flatMap((r) => Object.values(r.content ?? {}))].map(
        (m, i): [string, Schema] => [`${op.operationId}/media/${i}`, m.schema],
      ),
    ]),
  ];

  const ajv = new Ajv2020({ strict: true, discriminator: true, allErrors: true });
  addFormats.default(ajv);
  for (const [name, schema] of Object.entries(spec.components.schemas)) ajv.addSchema(localRefs(schema) as Schema, name);

  it("is a valid OpenAPI document", () => {
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("declares the two operations", () => {
    expect(operations.map((op) => op.operationId).sort()).toEqual(["reportPlacement", "requestCanary"]);
  });

  it.each(roots)("%s compiles as strict JSON Schema", (_at, schema) => {
    expect(() => ajv.compile(localRefs(schema) as Schema)).not.toThrow();
  });

  it("closes every object schema", () => {
    expect(roots.flatMap(([at, schema]) => openings(schema, at))).toEqual([]);
  });

  it("has examples that match their schemas", () => {
    const failures: string[] = [];
    const check = (at: string, schema: Schema, value: unknown) => {
      const validate = ajv.compile(localRefs(schema) as Schema);
      if (!validate(value)) failures.push(`${at}: ${ajv.errorsText(validate.errors)}`);
    };
    for (const m of media) {
      for (const [name, example] of Object.entries(m.examples ?? {})) check(`example ${name}`, m.schema, example.value);
    }
    const visit = (at: string, schema: Schema) => {
      for (const value of (schema.examples ?? []) as unknown[]) check(at, schema, value);
      for (const [key, child] of subschemas(schema)) visit(`${at}/${key}`, child);
    };
    for (const [at, schema] of roots) visit(at, schema);
    expect(failures).toEqual([]);
  });
});
