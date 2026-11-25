// Devin's published routes through the client API (f89d408e): a Devin credential on the production API Worker
// (`exports.default.fetch`) with the real ControlPlane and model registry lists its catalog under `devin/<id>`, and the
// OAuth aliases and exclusions of the `devin` channel name that qualified source. Copilot's are in `copilot-e2e.test.ts`.
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { FULL_ACCESS, withModelsPart } from "@commissary/models/testing";

const YAML = `
oauth-model-alias:
  devin:
    - name: devin/swe-2
      alias: swe
    - name: swe-2-flash
      alias: bare-name-maps-nothing
oauth-excluded-models:
  devin:
    - devin/grok-*
`;

beforeAll(async () => {
  const controlPlane = env.CONTROL_PLANE.getByName("global");
  const stored = await withModelsPart(controlPlane, (part) => part.importConfig(YAML, "test"));
  expect(stored.ok).toBe(true);

  const imported = await withModelsPart(controlPlane, (part) =>
    part.importAuthFile(
      "devin-a.json",
      JSON.stringify({
        type: "devin",
        api_key: "devin-session-token$devin-a",
        email: "devin-a@example.com",
      }),
      {},
      FULL_ACCESS,
    ),
  );

  expect(imported.ok).toBe(true);
});

describe("Devin models", () => {
  it("lists the catalog under devin/<id>, with the aliases and exclusions of its source", async () => {
    const response = await exports.default.fetch(new Request("http://localhost/v1/models"));
    expect(response.status).toBe(200);
    // SAFETY: the OpenAI model listing (`data[].id`).
    const listed = (await response.json()) as { data: Array<{ id: string }> };
    const ids = listed.data.map((model) => model.id);

    expect(ids).toEqual(
      expect.arrayContaining(["swe", "devin/swe-2-flash", "devin/swe-1-6-slow", "devin/gpt-6-sol"]),
    );
    // The alias replaces its source; an alias that names the native id maps nothing.
    expect(ids).not.toContain("devin/swe-2");
    expect(ids).not.toContain("bare-name-maps-nothing");
    expect(ids.filter((id) => id.startsWith("devin/grok-"))).toEqual([]);
    expect(ids.filter((id) => id.startsWith("devin/devin/") || id === "swe-2-flash")).toEqual([]);
  });
});
