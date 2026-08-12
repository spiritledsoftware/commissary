import type { FieldSchema } from "@commissary/store";
import { relations } from "drizzle-orm";
import { pgEnum, pgTable, text } from "drizzle-orm/pg-core";

import { DrizzlePostgresStore } from "../src/postgres.js";

const requiredString: FieldSchema<string, string> = {
  "~standard": {
    version: 1,
    vendor: "commissary-drizzle-kit-smoke",
    validate: (value) =>
      typeof value === "string" ? { value } : { issues: [{ message: "Expected string" }] },
  },
};

const kitStatus = pgEnum("kit_status", ["queued", "complete"]);
const kitJobs = pgTable("kit_jobs", {
  id: text("id").primaryKey(),
  status: kitStatus("status").notNull(),
});

const definition = DrizzlePostgresStore.define({
  records: { kitJob: kitJobs },
  overrides: {
    kitJob: {
      fields: { id: requiredString, status: requiredString },
    },
  },
  enums: { kit_status: kitStatus },
  relations: (tables) => ({
    kitJobRelations: relations(tables.kitJob, () => ({})),
  }),
});

// Drizzle Kit loads these direct module exports rather than traversing definition.schema.
export const { kitJob, kit_status: kitStatusEnum, kitJobRelations } = definition.schema;
