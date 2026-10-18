import { expect, type APIResponse, type Response } from "@playwright/test";
import { z } from "zod";

export const fixtureSchema = z.object({
  tokens: z.record(z.string(), z.string()),
  bootstrap: z.unknown(),
});
const entitySchema = z.object({
  class: z.array(z.string()),
  properties: z.unknown(),
  entities: z.array(z.unknown()),
});

export async function readSirenProperties<T>(
  response: APIResponse | Response,
  kind: string,
  schema: z.ZodType<T>,
): Promise<T> {
  expect(response.headers()["content-type"]).toContain(
    "application/vnd.siren+json",
  );
  const data: unknown = await response.json();
  const entity = entitySchema.parse(data);
  expect(entity.class).toContain(kind);
  return schema.parse(entity.properties);
}

export async function readSirenItems<T>(
  response: APIResponse | Response,
  kind: string,
  itemKind: string,
  schema: z.ZodType<T>,
): Promise<T[]> {
  expect(response.headers()["content-type"]).toContain(
    "application/vnd.siren+json",
  );
  const data: unknown = await response.json();
  const collection = entitySchema.parse(data);
  expect(collection.class).toContain(kind);
  return collection.entities.map((item) => {
    const entity = entitySchema.parse(item);
    expect(entity.class).toContain(itemKind);
    return schema.parse(entity.properties);
  });
}
