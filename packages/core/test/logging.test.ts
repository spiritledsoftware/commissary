// Logging helpers: headers with credentials are redacted before they are logged.
import { expect, it } from "vite-plus/test";
import { redactHeaders } from "../src/index.ts";

it("redactHeaders hides credentials", () => {
  const redacted = redactHeaders(
    new Headers({
      authorization: "Bearer secret",
      "cf-access-jwt-assertion": "jwt",
      accept: "*/*",
    }),
  );

  expect(redacted).toEqual({
    authorization: "[redacted]",
    "cf-access-jwt-assertion": "[redacted]",
    accept: "*/*",
  });
});
