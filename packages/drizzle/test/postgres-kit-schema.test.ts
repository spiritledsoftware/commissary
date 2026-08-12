import { is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { expect, test } from "vitest";

import { kitJob, kitJobRelations, kitStatusEnum } from "./postgres-kit-schema.js";

test("loads PostgreSQL table, enum, and relation values as direct Drizzle Kit exports", () => {
  expect(is(kitJob, PgTable)).toBe(true);
  expect(kitStatusEnum.enumName).toBe("kit_status");
  expect(kitStatusEnum.enumValues).toEqual(["queued", "complete"]);
  expect(kitJobRelations).toBeDefined();
});
