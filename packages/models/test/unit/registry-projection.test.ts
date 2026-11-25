// The model registry's availability projection (CLIProxyAPI 69ed202a): bounded cooldowns relist a model once their
// deadline passes, open-ended gates (disabled, terminal 401, a flag without a deadline) keep it suspended.
import { describe, expect, it } from "vite-plus/test";
import {
  type CredentialState,
  emptyQuota,
  emptyState,
  type ModelState,
} from "../../src/credentials/model.ts";
import { projectModel } from "../../src/registry/availability.ts";
import type { ModelInfo } from "../../src/registry/model-info.ts";
import type { ModelSource } from "../../src/registry/source.ts";

const NOW = 1_000_000;

const model: ModelInfo = {
  id: "gpt-5",
  object: "model",
  created: 0,
  ownedBy: "openai",
  type: "codex",
};

const source = (state: Partial<CredentialState>, disabled = false): ModelSource => ({
  id: "c1",
  provider: "codex",
  executor: "codex",
  source: "file",
  label: "c1",
  disabled,
  compat: false,
  excludedModels: [],
  modelAliases: [],
  state: { ...emptyState(), ...state },
});

const cooling = (fields: Partial<ModelState>) => ({
  "gpt-5": {
    status: "error",
    unavailable: true,
    nextRetryAfter: 0,
    quota: emptyQuota(),
    updatedAt: NOW - 1000,
    statusMessage: "transient upstream error",
    ...fields,
  } satisfies ModelState,
});

describe("projectModel", () => {
  it("relists a model once its transient cooldown expired, before any result cleared the flags", () => {
    const state = {
      status: "error" as const,
      modelStates: cooling({ nextRetryAfter: NOW + 60_000 }),
    };

    expect(projectModel(source(state), model, NOW)).toMatchObject({
      suspended: true,
      suspendReason: "transient upstream error",
    });
    expect(projectModel(source(state), model, NOW + 60_001).suspended).toBe(false);
  });

  it("relists a model once its quota recovery passed", () => {
    const state = {
      modelStates: cooling({
        nextRetryAfter: NOW + 30_000,
        quota: { exceeded: true, reason: "quota", nextRecoverAt: NOW + 30_000, backoffLevel: 1 },
      }),
    };

    expect(projectModel(source(state), model, NOW)).toMatchObject({
      suspended: true,
      suspendReason: "quota",
      quotaExceeded: true,
    });
    expect(projectModel(source(state), model, NOW + 30_001)).toMatchObject({
      suspended: false,
      quotaExceeded: false,
    });
  });

  it("keeps a flag without any deadline suspended", () => {
    const state = { modelStates: cooling({ nextRetryAfter: 0 }) };

    // `availabilityBlock`: unavailable with no recovery time at all is open-ended.
    expect(projectModel(source(state), model, NOW + 3_600_000).suspended).toBe(true);
  });

  it("keeps disabled credentials and models suspended as `disabled`", () => {
    expect(projectModel(source({}, true), model, NOW)).toMatchObject({
      suspended: true,
      suspendReason: "disabled",
    });
    expect(projectModel(source({ status: "disabled" }), model, NOW).suspendReason).toBe("disabled");

    expect(
      projectModel(
        source({ modelStates: cooling({ status: "disabled", unavailable: false }) }),
        model,
        NOW,
      ),
    ).toMatchObject({ suspended: true, suspendReason: "disabled" });
  });

  it("keeps a terminal 401 suspended", () => {
    const state: Partial<CredentialState> = {
      status: "error",
      unavailable: true,
      statusMessage: "unauthorized (refresh token invalid)",
      lastError: {
        message: "invalid_grant",
        retryable: false,
        httpStatus: 401,
        code: "unauthorized",
      },
    };

    expect(projectModel(source(state), model, NOW + 3_600_000)).toMatchObject({
      suspended: true,
      suspendReason: "unauthorized (refresh token invalid)",
    });
  });

  it("follows the credential-wide cooldown without model states only while it lasts", () => {
    const state = { status: "error" as const, unavailable: true, nextRetryAfter: NOW + 10_000 };

    expect(projectModel(source(state), model, NOW).suspended).toBe(true);
    expect(projectModel(source(state), model, NOW + 10_001).suspended).toBe(false);
  });
});
