import {
  StoreRecord,
  applyRecordOverrides,
  parseStoreCreateInput,
  parseStoreSelectedFields,
  type CreateInput,
  type FieldSchema,
  type JsonValue,
  type SelectedRecord,
  type UpdateInput,
} from "@commissary/store";
import { expect, expectTypeOf, it } from "vitest";

it("validates selected Record fields concurrently and preserves field order", async () => {
  const startedFields: string[] = [];
  let markBothStarted = (): void => undefined;
  const bothStarted = new Promise<void>((resolve) => {
    markBothStarted = resolve;
  });
  let releaseValidation = (): void => undefined;
  const holdValidation = new Promise<void>((resolve) => {
    releaseValidation = resolve;
  });
  const deferredField = (name: string): FieldSchema<string, string> => ({
    "~standard": {
      version: 1,
      vendor: "commissary-record-test",
      async validate(value) {
        startedFields.push(name);
        if (startedFields.length === 2) {
          markBothStarted();
        }
        await holdValidation;
        return typeof value === "string"
          ? { value }
          : { issues: [{ message: "Expected a string" }] };
      },
    },
  });
  const definition = {
    fields: {
      first: deferredField("first"),
      second: deferredField("second"),
    },
  };

  const parsing = parseStoreSelectedFields(definition, "records", { first: "one", second: "two" }, [
    "first",
    "second",
  ]);
  await bothStarted;
  expect(startedFields).toEqual(["first", "second"]);
  releaseValidation();
  await expect(parsing).resolves.toEqual({ first: "one", second: "two" });
});

it("returns a rejected Promise for invalid selected field input", async () => {
  const stringField: FieldSchema<string, string> = {
    "~standard": {
      version: 1,
      vendor: "commissary-record-test",
      validate: (value) =>
        typeof value === "string" ? { value } : { issues: [{ message: "Expected a string" }] },
    },
  };
  const parsing = parseStoreSelectedFields(
    { fields: { id: stringField } },
    "records",
    { id: "one" },
    {} as never,
  );

  expect(parsing).toBeInstanceOf(Promise);
  await expect(parsing).rejects.toBeInstanceOf(TypeError);
});

type RecordSchemaResult<Output> =
  | { readonly value: Output }
  | { readonly issues: readonly { readonly message: string }[] };

function recordFieldSchema<Input, Output extends JsonValue | undefined>(
  validate: (value: unknown) => RecordSchemaResult<Output>,
): FieldSchema<Input, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "commissary-record-lifecycle-test",
      validate,
    },
  };
}

const lifecycleStringField = recordFieldSchema<string, string>((value) =>
  typeof value === "string" ? { value } : { issues: [{ message: "Expected a string" }] },
);

it("snapshots package-owned Record containers without freezing Field Schemas", () => {
  const field = {
    select: lifecycleStringField,
    create: lifecycleStringField,
  };
  const fields = { id: field };
  const source = { fields };
  const definition = StoreRecord.define(source);

  expect(definition).not.toBe(source);
  expect(definition.fields).not.toBe(fields);
  expect(definition.fields.id).not.toBe(field);
  expect(Object.isFrozen(definition)).toBe(true);
  expect(Object.isFrozen(definition.fields)).toBe(true);
  expect(Object.isFrozen(definition.fields.id)).toBe(true);
  expect(definition.fields.id.select).toBe(lifecycleStringField);
  expect(Object.isFrozen(lifecycleStringField)).toBe(false);

  Reflect.set(fields, "later", lifecycleStringField);
  Reflect.set(field, "update", lifecycleStringField);
  expect(definition.fields).not.toHaveProperty("later");
  expect(definition.fields.id).not.toHaveProperty("update");
});

type NormalizedName = string & { readonly NormalizedName: unique symbol };

const normalizedNameField = recordFieldSchema<string, NormalizedName>((value) =>
  typeof value === "string"
    ? { value: value.trim().toUpperCase() as NormalizedName }
    : { issues: [{ message: "Expected a name" }] },
);

const prefixedNameField = recordFieldSchema<string, string>((value) =>
  typeof value === "string"
    ? { value: `legacy:${value}` }
    : { issues: [{ message: "Expected a name" }] },
);

const lifecycleDefinitions = {
  jobs: StoreRecord.define({
    table: {
      name: "jobs",
      schema: "public",
    },
    fields: {
      name: {
        select: lifecycleStringField,
        create: prefixedNameField,
        update: lifecycleStringField,
        column: {
          name: "job_name",
          notNull: true,
        },
      },
    },
  }),
};

const lifecycleOverrides = {
  jobs: {
    table: {
      schema: null,
    },
    fields: {
      name: {
        select: normalizedNameField,
        create: null,
        column: {
          name: "normalized_name",
          notNull: null,
        },
      },
    },
  },
} as const;

it("applies deep overrides, exact null removal, and effective Schema fallbacks", async () => {
  const effective = applyRecordOverrides(lifecycleDefinitions, lifecycleOverrides);

  expect(effective.jobs.table).toEqual({ name: "jobs" });
  expect(effective.jobs.fields.name).toMatchObject({
    select: normalizedNameField,
    update: lifecycleStringField,
    column: { name: "normalized_name" },
  });
  expect(effective.jobs.fields.name).not.toHaveProperty("create");
  expect(effective.jobs.fields.name.column).not.toHaveProperty("notNull");
  expect(Object.isFrozen(effective)).toBe(true);
  expect(Object.isFrozen(effective.jobs)).toBe(true);
  expect(Object.isFrozen(effective.jobs.fields)).toBe(true);
  expect(Object.isFrozen(effective.jobs.fields.name.column)).toBe(true);
  expect(Object.isFrozen(normalizedNameField)).toBe(false);

  await expect(parseStoreCreateInput(effective.jobs, "jobs", { name: "  new  " })).resolves.toEqual(
    { name: "NEW" },
  );

  expectTypeOf<SelectedRecord<typeof effective.jobs>>().toEqualTypeOf<{
    readonly name: NormalizedName;
  }>();
  expectTypeOf<CreateInput<typeof effective.jobs>>().toEqualTypeOf<{
    readonly name: string;
  }>();
  expectTypeOf<UpdateInput<typeof effective.jobs>>().toEqualTypeOf<{
    readonly name?: string;
  }>();
});

const lifecycleNumberField = recordFieldSchema<number, number>((value) =>
  typeof value === "number" ? { value } : { issues: [{ message: "Expected a number" }] },
);

const lifecycleNumberFromStringField = recordFieldSchema<string, number>((value) =>
  typeof value === "string"
    ? { value: value.length }
    : { issues: [{ message: "Expected a string" }] },
);

const lifecycleStringFromNumberField = recordFieldSchema<number, string>((value) =>
  typeof value === "number"
    ? { value: String(value) }
    : { issues: [{ message: "Expected a number" }] },
);

it("checks selected, create, and update compatibility at compile time", () => {
  applyRecordOverrides(lifecycleDefinitions, {
    // @ts-expect-error A number selected value is incompatible with the contributed string.
    jobs: {
      fields: {
        name: {
          select: lifecycleNumberField,
          create: lifecycleNumberFromStringField,
          update: lifecycleNumberFromStringField,
        },
      },
    },
  });

  applyRecordOverrides(lifecycleDefinitions, {
    // @ts-expect-error A number-only create input does not accept contributed string input.
    jobs: {
      fields: {
        name: {
          select: lifecycleStringField,
          create: lifecycleStringFromNumberField,
          update: lifecycleStringField,
        },
      },
    },
  });

  applyRecordOverrides(lifecycleDefinitions, {
    // @ts-expect-error A number-only update input does not accept contributed string input.
    jobs: {
      fields: {
        name: {
          select: lifecycleStringField,
          create: lifecycleStringField,
          update: lifecycleStringFromNumberField,
        },
      },
    },
  });

  expect(applyRecordOverrides).toBeTypeOf("function");
});

it("rejects overrides without a matching contribution", () => {
  expect(() =>
    applyRecordOverrides(lifecycleDefinitions, {
      missing: { fields: {} },
    } as never),
  ).toThrow("Record override 'missing' has no contribution");
});
