// The outbound guard on writes (ADR 0044): a URL the guard refuses is refused when it is saved, with the guard's
// message: a provider's `base_url` (a provider key group, a config import, an auth file upload and an auth file's field
// patch), a Vertex service account's `token_uri` (the import and an auth file upload) and the `models.catalog` source
// (a settings save and a config import).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OUTBOUND_REFUSED_MESSAGE } from "@commissary/core";
import { makeServiceAccount, type TestServiceAccount } from "@commissary/models/testing";
import { jsonInit, makeHarness, resetControlPlane } from "./support/management.ts";

const harness = makeHarness();

afterAll(harness.dispose);

beforeEach(resetControlPlane);

const { json } = harness;

let sa: TestServiceAccount;

beforeAll(async () => {
  sa = await makeServiceAccount();
});

const PROVIDER_KEYS = "/v9/management/provider-keys";

const putCompat = (baseUrl: string) =>
  json(
    `${PROVIDER_KEYS}/groups`,
    jsonInit("PUT", {
      family: "openai-compatibility",
      revision: 0,
      group: { name: "acme", "base-url": baseUrl, keys: [{ "api-key": "sk-acme-1" }] },
    }),
  );

const families = async () =>
  (await json(PROVIDER_KEYS)).body as { families: Record<string, ReadonlyArray<unknown>> };

const upload = (name: string, file: Record<string, unknown>) => {
  const body = new FormData();
  body.append("file", new File([JSON.stringify(file)], name, { type: "application/json" }));

  return json("/v9/management/credentials", { method: "POST", body });
};

const importYaml = (yaml: string) =>
  json("/v9/management/settings/import", {
    method: "POST",
    headers: { "content-type": "application/yaml" },
    body: yaml,
  });

describe("outbound guard on saving a provider's base_url", () => {
  it.each([
    "http://api.acme.example/v1",
    "https://192.168.1.10/v1",
    "https://169.254.169.254/v1",
    "https://[::ffff:10.0.0.1]/v1",
    "https://commissary.test/v1",
  ])("refuses a key group with base-url %s, and stores nothing", async (baseUrl) => {
    const written = await putCompat(baseUrl);

    expect(written.status).toBe(422);
    expect(JSON.stringify(written.body)).toContain(OUTBOUND_REFUSED_MESSAGE);
    expect((await families()).families["openai-compatibility"]).toEqual([]);
  });

  it("refuses a provider key group of another family the same way", async () => {
    const written = await json(
      `${PROVIDER_KEYS}/groups`,
      jsonInit("PUT", {
        family: "claude",
        revision: 0,
        group: { "base-url": "https://10.1.2.3", keys: [{ "api-key": "sk-ant-1" }] },
      }),
    );

    expect(written.status).toBe(422);
    expect(JSON.stringify(written.body)).toContain(OUTBOUND_REFUSED_MESSAGE);
  });

  it("saves a public https base-url", async () => {
    expect((await putCompat("https://api.acme.example/v1")).status).toBe(200);
  });

  it("refuses a config import with a refused base-url, naming where it is", async () => {
    const imported = await importYaml(
      [
        "api-keys:",
        "  openai-compatibility:",
        "    - name: acme",
        "      base-url: http://10.0.0.7/v1",
        "      keys:",
        "        - api-key: sk-acme-1",
      ].join("\n"),
    );

    expect(imported).toMatchObject({
      status: 422,
      body: {
        error: "invalid_config",
        message: OUTBOUND_REFUSED_MESSAGE,
        path: "api-keys.openai-compatibility[0].base-url",
      },
    });
  });

  it("refuses an auth file whose base_url the guard refuses", async () => {
    const uploaded = await upload("kimi.json", {
      type: "kimi",
      access_token: "token",
      base_url: "http://127.0.0.1:8080/coding",
    });

    expect(uploaded).toMatchObject({
      status: 422,
      body: { error: OUTBOUND_REFUSED_MESSAGE, path: "base_url", name: "kimi.json" },
    });
  });

  it("refuses a field patch that sets a refused base_url", async () => {
    expect((await upload("kimi.json", { type: "kimi", access_token: "token" })).status).toBe(200);

    const patched = await json(
      "/v9/management/credentials/fields",
      jsonInit("PATCH", { name: "kimi.json", base_url: "https://[fe80::1]/coding" }),
    );

    expect(patched.status).toBe(422);
    expect(JSON.stringify(patched.body)).toContain(OUTBOUND_REFUSED_MESSAGE);
  });
});

describe("outbound guard on saving a Vertex service account's token_uri", () => {
  it("refuses a Vertex import whose token_uri the guard refuses", async () => {
    const body = new FormData();
    body.append(
      "file",
      new File(
        [JSON.stringify(sa.account(sa.pem.pkcs8, { token_uri: "https://10.0.0.1/token" }))],
        "sa.json",
      ),
    );

    expect(
      await json("/v9/management/oauth/import?provider=vertex", { method: "POST", body }),
    ).toMatchObject({
      status: 422,
      body: { error: OUTBOUND_REFUSED_MESSAGE, path: "service_account.token_uri" },
    });
  });

  it("refuses an auth file upload whose service account token_uri the guard refuses", async () => {
    const uploaded = await upload("vertex-proj.json", {
      type: "vertex",
      project_id: "proj-1",
      service_account: sa.account(sa.pem.pkcs8, { token_uri: "http://169.254.169.254/token" }),
    });

    expect(uploaded).toMatchObject({
      status: 422,
      body: { error: OUTBOUND_REFUSED_MESSAGE, path: "service_account.token_uri" },
    });
  });
});

describe("outbound guard on saving the models.catalog source", () => {
  it("refuses a settings save whose catalog URL the guard refuses", async () => {
    expect(
      await json(
        "/v9/management/settings",
        jsonInit("PATCH", {
          revisions: {},
          patch: { models: { catalog: "http://10.0.0.1/api.json" } },
        }),
      ),
    ).toMatchObject({ status: 422, body: { message: OUTBOUND_REFUSED_MESSAGE } });
  });

  it("refuses a config import whose catalog URL the guard refuses", async () => {
    expect(await importYaml("models:\n  catalog: https://192.168.0.2/api.json\n")).toMatchObject({
      status: 422,
      body: { error: "invalid_config", message: OUTBOUND_REFUSED_MESSAGE, path: "models.catalog" },
    });
  });

  it("saves a public https catalog URL", async () => {
    expect(
      (
        await json(
          "/v9/management/settings",
          jsonInit("PATCH", {
            revisions: {},
            patch: { models: { catalog: "https://catalog.example.test/api.json" } },
          }),
        )
      ).status,
    ).toBe(200);
  });
});
