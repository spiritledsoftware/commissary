/**
 * Claude Code device profile stabiliser (`upstream.claude.header-defaults.stabilize-device-profile`).
 *
 * Go source: internal/runtime/executor/helps/claude_device_profile.go (`ResolveClaudeDeviceProfileRequired` local mode:
 * `extractClaudeDeviceProfile`, `pinClaudeDeviceProfilePlatform`, `meetsClaudeDeviceProfileBaseline`,
 * `normalizeClaudeDeviceProfile`, `shouldUpgradeClaudeDeviceProfile`, scope keys, `ApplyClaudeDeviceProfileHeaders`).
 * With the feature on, a confirmed Claude Code client contributes its real software profile (user agent and Stainless
 * package/runtime versions) which is then reused for that credential, so the upstream sees one stable identity;
 * unconfirmed clients always get the configured baseline. Go keeps the profiles in a per-process map (7 d TTL); here
 * they live in the `SessionState` Durable Object (one instance per credential scope, sliding 7 d TTL, compare-and-swap
 * upgrades) with the per-isolate fallback of `@commissary/state`'s `session-state/client.ts`. The Home KV mode is not
 * ported.
 */
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { isJsonObject, type Json, tryParseJson } from "@commissary/json";
import type { Config } from "../../config/schema.ts";
import {
  type BackendResolver,
  bestEffort,
  fixedBackend,
  keepValue,
  makeMemoryBackend,
  putValue,
  resolveBackend,
  type SessionAddress,
  updateEntry,
} from "@commissary/state";
import type { CredentialSnapshot } from "../picker.ts";
import { isNativeEntrypoint } from "./classify.ts";
import { defaultDeviceProfile, type DeviceProfile } from "./headers.ts";
import {
  compareVersions,
  PACKAGE_VERSION,
  parseClaudeCodeUserAgent,
  parseCliVersion as parseVersion,
  RUNTIME_VERSION,
} from "./user-agent.ts";

const TTL_MS = 7 * 24 * 3_600_000;

const STORE_NAME = "claude-device-profile";

const ENTRY_KEY = "profile";

/** `shouldUpgradeClaudeDeviceProfile`: only a newer CLI version replaces the stored profile. */
export const shouldUpgradeProfile = (candidate: DeviceProfile, current: DeviceProfile): boolean => {
  const candidateVersion = parseVersion(candidate.userAgent);

  if (candidate.userAgent === "" || candidateVersion === undefined) return false;
  const currentVersion = parseVersion(current.userAgent);

  if (current.userAgent === "" || currentVersion === undefined) return true;

  return compareVersions(candidateVersion, currentVersion) > 0;
};

/** `meetsClaudeDeviceProfileBaseline`: the software tuple must equal the baseline's exactly. */
export const meetsBaseline = (candidate: DeviceProfile, baseline: DeviceProfile): boolean => {
  const candidateVersion = parseVersion(candidate.userAgent);
  const baselineVersion = parseVersion(baseline.userAgent);

  if (candidate.userAgent === "" || candidateVersion === undefined) return false;

  if (baseline.userAgent === "" || baselineVersion === undefined) return false;

  return (
    compareVersions(candidateVersion, baselineVersion) === 0 &&
    candidate.packageVersion === baseline.packageVersion &&
    candidate.runtimeVersion === baseline.runtimeVersion
  );
};

/** `pinClaudeDeviceProfilePlatform`: the platform is always the configured one. */
const pinPlatform = (profile: DeviceProfile, baseline: DeviceProfile): DeviceProfile => ({
  ...profile,
  os: baseline.os,
  arch: baseline.arch,
});

/** `normalizeClaudeDeviceProfile`: pinned platform; a software tuple that is not the baseline is replaced. */
export const normalizeProfile = (
  profile: DeviceProfile,
  baseline: DeviceProfile,
): DeviceProfile => {
  const pinned = pinPlatform(profile, baseline);

  return meetsBaseline(pinned, baseline)
    ? pinned
    : {
        ...pinned,
        userAgent: baseline.userAgent,
        packageVersion: baseline.packageVersion,
        runtimeVersion: baseline.runtimeVersion,
      };
};

const headerOr = (headers: Headers, name: string, fallback: string): string => {
  const value = headers.get(name)?.trim() ?? "";

  return value === "" ? fallback : value;
};

/**
 * `extractClaudeDeviceProfile`: the profile a Claude Code client announces (undefined for anything else). Its User-Agent
 * is the stable identity only: request-only extension fields (`workload/cron`) are left out.
 */
export const extractProfile = (
  headers: Headers | undefined,
  baseline: DeviceProfile,
): DeviceProfile | undefined => {
  if (headers === undefined) return undefined;
  const userAgent = parseClaudeCodeUserAgent(headers.get("user-agent") ?? "");

  if (userAgent === undefined) return undefined;
  let packageVersion = headerOr(headers, "x-stainless-package-version", baseline.packageVersion);

  if (!PACKAGE_VERSION.test(packageVersion)) packageVersion = baseline.packageVersion;
  let runtimeVersion = headerOr(headers, "x-stainless-runtime-version", baseline.runtimeVersion);

  if (!RUNTIME_VERSION.test(runtimeVersion)) runtimeVersion = baseline.runtimeVersion;

  return {
    userAgent: userAgent.profileUserAgent,
    packageVersion,
    runtimeVersion,
    os: headerOr(headers, "x-stainless-os", baseline.os),
    arch: headerOr(headers, "x-stainless-arch", baseline.arch),
  };
};

/** `ClaudeDeviceProfileStabilizationEnabled`. */
export const deviceProfileStabilizationEnabled = (config: Config): boolean =>
  config.upstream.claude["header-defaults"]["stabilize-device-profile"] === true;

/** `claudeDeviceProfileSubclientScope`: distinct first-party clients never replace each other's stored profile. */
const subclientScope = (
  profile: DeviceProfile | undefined,
  nativeEntrypoints: readonly string[],
): string => {
  if (profile === undefined) return "";
  const entrypoint = parseClaudeCodeUserAgent(profile.userAgent)?.entrypoint ?? "";

  if (entrypoint === "" || entrypoint === "cli") return "";

  return isNativeEntrypoint(entrypoint, nativeEntrypoints) ? entrypoint : "other";
};

/** `claudeDeviceProfileScopedKey`. */
export const profileScopeKey = (
  credential: Pick<CredentialSnapshot, "id">,
  providerKey: string,
  profile: DeviceProfile | undefined,
  nativeEntrypoints: readonly string[] = [],
): string => {
  const id = credential.id.trim();

  let key =
    id !== ""
      ? `auth:${id}`
      : providerKey.trim() !== ""
        ? `api_key:${providerKey.trim()}`
        : "global";

  const subclient = subclientScope(profile, nativeEntrypoints);

  if (subclient !== "") key += `|subclient:${subclient}`;

  return key;
};

const addressOf = (scopeKey: string): SessionAddress => ({
  store: STORE_NAME,
  scope: "",
  session: createHash("sha256").update(scopeKey).digest("hex"),
});

const parseStored = (text: string | undefined): DeviceProfile | undefined => {
  if (text === undefined) return undefined;

  try {
    const parsed = tryParseJson(text);

    if (parsed === undefined || parsed === null || typeof parsed !== "object") return undefined;
    const record = isJsonObject(parsed) ? parsed : {};

    const field = (value: Json | undefined): string =>
      typeof value === "string" ? value.trim() : "";

    const profile: DeviceProfile = {
      userAgent: field(record.userAgent),
      packageVersion: field(record.packageVersion),
      runtimeVersion: field(record.runtimeVersion),
      os: field(record.os),
      arch: field(record.arch),
    };

    return profile.userAgent === "" ? undefined : profile;
  } catch {
    return undefined;
  }
};

export interface DeviceProfileStore {
  /**
   * `ResolveClaudeDeviceProfile`: the stabilised profile for a request of a confirmed Claude Code client. Storage
   * failures degrade to the candidate (or the baseline) instead of failing the request.
   */
  readonly resolve: (
    credential: Pick<CredentialSnapshot, "id">,
    providerKey: string,
    headers: Headers | undefined,
    config: Config,
  ) => Effect.Effect<DeviceProfile>;
}

export const makeSessionStateDeviceProfileStore = (
  backend: BackendResolver = resolveBackend(),
): DeviceProfileStore => ({
  resolve: (credential, providerKey, headers, config) => {
    const baseline = defaultDeviceProfile(config);
    let candidate = extractProfile(headers, baseline);

    if (candidate !== undefined) candidate = pinPlatform(candidate, baseline);

    if (candidate !== undefined && !meetsBaseline(candidate, baseline)) candidate = undefined;

    const address = addressOf(
      profileScopeKey(
        credential,
        providerKey,
        candidate,
        config.upstream.claude["header-defaults"]["native-entrypoints"],
      ),
    );

    return bestEffort(
      "claude device profile",
      candidate ?? baseline,
      Effect.gen(function* () {
        const state = yield* backend;
        let result: DeviceProfile = candidate ?? baseline;
        yield* updateEntry(
          state,
          address,
          ENTRY_KEY,
          { ttlMs: TTL_MS, maxEntries: 1, slideTtl: true },
          (current) => {
            const stored = parseStored(current);
            const cached = stored === undefined ? undefined : normalizeProfile(stored, baseline);

            if (candidate !== undefined) {
              if (cached !== undefined && !shouldUpgradeProfile(candidate, cached)) {
                result = cached;

                return JSON.stringify(cached) === current
                  ? keepValue
                  : putValue(JSON.stringify(cached));
              }

              result = candidate;

              return putValue(JSON.stringify(candidate));
            }

            if (cached === undefined) {
              result = baseline;

              return keepValue;
            }

            result = cached;

            return JSON.stringify(cached) === current
              ? keepValue
              : putValue(JSON.stringify(cached));
          },
        );

        return result;
      }),
    );
  },
});

/** In-memory store for tests (`now` is injectable). */
export const makeMemoryDeviceProfileStore = (now?: () => number): DeviceProfileStore =>
  makeSessionStateDeviceProfileStore(fixedBackend(makeMemoryBackend(now)));
