/**
 * Vertex AI service-account access tokens (OAuth2 JWT-bearer grant).
 *
 * Go source: internal/auth/vertex/keyutil.go (`NormalizeServiceAccountMap`, PEM repair),
 * internal/runtime/executor/gemini_vertex_executor.go (`google.CredentialsFromJSON`, scope cloud-platform).
 * Docs: credentials.md §2.2 (vertex). Go has no auth-level refresh: the Google library mints a token per request and
 * caches it. Here the token is minted with WebCrypto (RS256) and cached by `VertexTokenCache` until `exp - 60 s`.
 */
import { Effect, Result } from "effect";
import { checkOutboundUrl, CurrentOutboundPolicy } from "@commissary/core";
import { HttpClientRequest } from "effect/http";
import { isJsonObject, type JsonObject } from "@commissary/json";
import { refreshError, type RefreshError } from "./error.ts";
import { parseJsonObject, send, seconds, statusFailure, str } from "./http.ts";
import type { RefreshEffect } from "./types.ts";

export const VERTEX_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

export const VERTEX_DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

/** A cached token is reused until this long before its expiry. */
export const VERTEX_EXPIRY_SKEW_MS = 60_000;

const JWT_LIFETIME_S = 3600;

// --- PEM / DER ---------------------------------------------------------------------------------------------------

const encoder = new TextEncoder();

const derLength = (length: number): number[] => {
  if (length < 0x80) return [length];

  if (length < 0x100) return [0x81, length];

  if (length < 0x10000) return [0x82, length >> 8, length & 0xff];

  return [0x83, length >> 16, (length >> 8) & 0xff, length & 0xff];
};

const derTlv = (tag: number, content: Uint8Array): Uint8Array => {
  const header = [tag, ...derLength(content.length)];
  const out = new Uint8Array(header.length + content.length);
  out.set(header);
  out.set(content, header.length);

  return out;
};

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
};

const RSA_ALGORITHM_IDENTIFIER = derTlv(
  0x30,
  concat(
    // OID 1.2.840.113549.1.1.1 (rsaEncryption) + NULL parameters.
    Uint8Array.of(0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01),
    Uint8Array.of(0x05, 0x00),
  ),
);

/** Wraps a PKCS#1 `RSAPrivateKey` into a PKCS#8 `PrivateKeyInfo` (what WebCrypto imports). */
export const pkcs1ToPkcs8 = (pkcs1: Uint8Array): Uint8Array =>
  derTlv(
    0x30,
    concat(Uint8Array.of(0x02, 0x01, 0x00), RSA_ALGORITHM_IDENTIFIER, derTlv(0x04, pkcs1)),
  );

// oxlint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b(?:\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|.)/g;

type PemBody =
  | {
      readonly ok: true;
      readonly kind: "RSA PRIVATE KEY" | "PRIVATE KEY";
      readonly der: Uint8Array;
    }
  | { readonly ok: false; readonly message: string };

/** `sanitizePrivateKey` + `rebuildPEM`: tolerates CRLF, ANSI escapes and broken line wrapping. */
const decodePemBody = (raw: string): PemBody => {
  const text = raw.replace(ANSI_ESCAPE, "").replace(/\r\n?/g, "\n");
  const kind = text.includes("RSA PRIVATE KEY") ? "RSA PRIVATE KEY" : "PRIVATE KEY";
  const begin = `-----BEGIN ${kind}-----`;
  const end = `-----END ${kind}-----`;
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);

  if (start < 0 || stop <= start) return { ok: false, message: "missing pem markers" };
  const payload = text.slice(start + begin.length, stop).replace(/[^A-Za-z0-9+/=]/g, "");

  if (payload === "") return { ok: false, message: "private_key base64 payload empty" };

  try {
    return { ok: true, kind, der: Uint8Array.from(atob(payload), (char) => char.charCodeAt(0)) };
  } catch {
    return { ok: false, message: "private_key base64 decode failed" };
  }
};

/**
 * The PKCS#8 DER of a (possibly damaged) PEM private key (PKCS#1 `RSA PRIVATE KEY` blocks are converted).
 * `undefined` when no usable RSA key block is found.
 */
export const privateKeyToPkcs8 = (raw: string): Uint8Array | undefined => {
  const body = decodePemBody(raw);

  if (!body.ok) return undefined;

  return body.kind === "RSA PRIVATE KEY" ? pkcs1ToPkcs8(body.der) : body.der;
};

/** Reads one DER element at `offset`: `[tag, contentStart, contentEnd]`. */
const readDer = (bytes: Uint8Array, offset: number): [number, number, number] | undefined => {
  const tag = bytes[offset];
  const first = bytes[offset + 1];

  if (tag === undefined || first === undefined) return undefined;
  let length = first;
  let start = offset + 2;

  if (first >= 0x80) {
    const count = first & 0x7f;

    if (count === 0 || count > 4) return undefined;
    length = 0;

    for (let index = 0; index < count; index += 1)
      length = length * 256 + (bytes[start + index] ?? 0);
    start += count;
  }

  return start + length > bytes.length ? undefined : [tag, start, start + length];
};

/** The PKCS#1 `RSAPrivateKey` inside a PKCS#8 `PrivateKeyInfo` (`SEQUENCE { INTEGER, SEQUENCE, OCTET STRING }`). */
const pkcs8ToPkcs1 = (pkcs8: Uint8Array): Uint8Array | undefined => {
  const outer = readDer(pkcs8, 0);

  if (outer === undefined || outer[0] !== 0x30) return undefined;
  const version = readDer(pkcs8, outer[1]);

  if (version === undefined || version[0] !== 0x02) return undefined;
  const algorithm = readDer(pkcs8, version[2]);

  if (algorithm === undefined || algorithm[0] !== 0x30) return undefined;
  const key = readDer(pkcs8, algorithm[2]);

  return key === undefined || key[0] !== 0x04 ? undefined : pkcs8.subarray(key[1], key[2]);
};

export type NormalizedPrivateKey =
  | { readonly ok: true; readonly pem: string }
  | { readonly ok: false; readonly message: string };

/**
 * `sanitizePrivateKey`: validates the key as RSA and re-encodes it as a canonical `RSA PRIVATE KEY` PEM block (what
 * `NormalizeServiceAccountMap` stores). Messages follow the Go errors.
 */
export const normalizePrivateKey = async (raw: string): Promise<NormalizedPrivateKey> => {
  const body = decodePemBody(raw.trim());

  if (!body.ok) return { ok: false, message: `private_key is not valid pem: ${body.message}` };
  const pkcs1 = body.kind === "RSA PRIVATE KEY" ? body.der : pkcs8ToPkcs1(body.der);

  if (pkcs1 === undefined) return { ok: false, message: "private_key is not an RSA key" };

  try {
    await crypto.subtle.importKey(
      "pkcs8",
      pkcs1ToPkcs8(pkcs1),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    return {
      ok: false,
      message: `private_key invalid ${body.kind === "RSA PRIVATE KEY" ? "rsa" : "pkcs8"}`,
    };
  }

  const base64 =
    btoa(String.fromCharCode(...pkcs1))
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";

  return {
    ok: true,
    pem: `-----BEGIN RSA PRIVATE KEY-----\n${base64}\n-----END RSA PRIVATE KEY-----\n`,
  };
};

// --- JWT ---------------------------------------------------------------------------------------------------------

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const jsonSegment = (value: JsonObject): string => base64Url(encoder.encode(JSON.stringify(value)));

export interface ServiceAccountKey {
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly privateKeyId: string;
  readonly tokenUri: string;
}

/** Reads the `service_account` object of a Vertex auth file (accepts the legacy flat layout too). */
export const serviceAccountOf = (metadata: Readonly<JsonObject>): ServiceAccountKey | undefined => {
  const nested = metadata.service_account;
  const source: Readonly<JsonObject> = isJsonObject(nested) ? nested : metadata;
  const clientEmail = str(source.client_email) || str(metadata.email);
  const privateKey = typeof source.private_key === "string" ? source.private_key : "";

  if (clientEmail === "" || privateKey.trim() === "") return undefined;

  return {
    clientEmail,
    privateKey,
    privateKeyId: str(source.private_key_id),
    tokenUri: str(source.token_uri) || VERTEX_DEFAULT_TOKEN_URI,
  };
};

/** Signed RS256 assertion for the JWT-bearer grant (`iss=client_email`, `aud=token_uri`, 1 h lifetime). */
export const signServiceAccountJwt = async (
  account: ServiceAccountKey,
  nowMs: number,
): Promise<string> => {
  const pkcs8 = privateKeyToPkcs8(account.privateKey);

  if (pkcs8 === undefined) throw new Error("private_key is not a valid RSA PEM");

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const issuedAt = Math.floor(nowMs / 1000);

  const header: JsonObject = {
    alg: "RS256",
    typ: "JWT",
    ...(account.privateKeyId === "" ? {} : { kid: account.privateKeyId }),
  };

  const claims: JsonObject = {
    iss: account.clientEmail,
    scope: VERTEX_SCOPE,
    aud: account.tokenUri,
    iat: issuedAt,
    exp: issuedAt + JWT_LIFETIME_S,
  };

  const signingInput = `${jsonSegment(header)}.${jsonSegment(claims)}`;

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(signingInput),
  );

  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
};

export interface VertexToken {
  readonly accessToken: string;
  /** Epoch ms at which the upstream says the token expires. */
  readonly expiresAt: number;
}

/** Mints an access token for the service account (one POST to `token_uri`). */
export const mintVertexToken = (
  metadata: Readonly<JsonObject>,
  nowMs: number,
): RefreshEffect<VertexToken> =>
  Effect.gen(function* () {
    const account = serviceAccountOf(metadata);

    if (account === undefined) {
      return yield* Effect.fail(
        refreshError({ message: "vertex service account is missing client_email or private_key" }),
      );
    }

    // The service account names its own `token_uri`: it passes the outbound guard (ADR 0044) like a `base_url`.
    const tokenUri = checkOutboundUrl(account.tokenUri, yield* CurrentOutboundPolicy);

    if (Result.isFailure(tokenUri)) {
      return yield* Effect.fail(
        refreshError({ message: `vertex service account token_uri: ${tokenUri.failure.message}` }),
      );
    }

    const assertion = yield* Effect.tryPromise({
      try: () => signServiceAccountJwt(account, nowMs),
      catch: (): RefreshError =>
        refreshError({
          message: "vertex service account private_key cannot sign (invalid RSA key)",
        }),
    });

    const request = HttpClientRequest.post(account.tokenUri).pipe(
      HttpClientRequest.setHeader("accept", "application/json"),
      HttpClientRequest.bodyUrlParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    );

    const reply = yield* send(request);

    if (reply.status !== 200)
      return yield* Effect.fail(statusFailure("vertex token request", reply));
    const body = parseJsonObject(reply.text);
    const accessToken = str(body?.access_token);

    if (body === undefined || accessToken === "") {
      return yield* Effect.fail(
        refreshError({ message: "vertex token response missing access_token" }),
      );
    }

    // Google answers 3599/3600; a missing value is treated as one hour like the JWT lifetime.
    const lifetime = seconds(body.expires_in) || JWT_LIFETIME_S;

    return { accessToken, expiresAt: nowMs + lifetime * 1000 };
  });

/** Per-credential cache of minted tokens, valid until `exp - 60 s`. Keyed by credential id + fingerprint. */
export class VertexTokenCache {
  readonly #entries = new Map<
    string,
    { readonly fingerprint: string; readonly token: VertexToken }
  >();

  /** The cached token when it is still usable at `now`; `fingerprint` changes when the credential is replaced. */
  get(id: string, fingerprint: string, now: number): VertexToken | undefined {
    const entry = this.#entries.get(id);

    if (entry === undefined || entry.fingerprint !== fingerprint) return undefined;

    return entry.token.expiresAt - VERTEX_EXPIRY_SKEW_MS > now ? entry.token : undefined;
  }

  set(id: string, fingerprint: string, token: VertexToken): void {
    this.#entries.set(id, { fingerprint, token });
  }

  delete(id: string): void {
    this.#entries.delete(id);
  }
}
