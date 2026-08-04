import { parseStoreSelectedFields, type FieldSchema } from "@commissary/store";
import { expect, it } from "vitest";

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
