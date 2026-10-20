/**
 * OAuth 1.0a request signatures (RFC 5849 §3.4, #206): the signature base string of a request (its method, its base
 * URI, its query and form body parameters and the protocol parameters), signed with HMAC-SHA1 or HMAC-SHA256 under the
 * consumer's and the token's secrets, and the `Authorization: OAuth` header that carries it. NetSuite's token-based
 * auth is this with HMAC-SHA256 and the account as the realm.
 */
import { hmac, percentEncode, sortedParameters } from "./encoding.ts";

export type OAuth1SignatureMethod = "HMAC-SHA1" | "HMAC-SHA256";

/** What signs a request: the consumer's key and secret, and the token's once there is one. */
export interface OAuth1Keys {
  readonly consumerKey: string;
  readonly consumerSecret: string;
  /** Absent: a temporary credential request (RFC 5849 §2.1). */
  readonly token?: string | undefined;
  readonly tokenSecret?: string | undefined;
  readonly signatureMethod: OAuth1SignatureMethod;
  /** The header's `realm`, which is not signed. */
  readonly realm?: string | undefined;
}

/** A request as its signature reads it. */
export interface OAuth1Request {
  readonly method: string;
  /** Its URL, its query included. */
  readonly url: string;
  /** An `application/x-www-form-urlencoded` body's parameters, decoded: they are signed (§3.4.1.3.1). */
  readonly form?: ReadonlyArray<readonly [string, string]> | undefined;
}

/** The protocol parameters of one signature beside the keys': what makes it unique, and any more. */
export interface OAuth1Params {
  readonly nonce: string;
  /** Seconds since the epoch. */
  readonly timestamp: number;
  /** More protocol parameters: `oauth_version`, `oauth_callback`, `oauth_verifier`. */
  readonly extra?: Readonly<Record<string, string>> | undefined;
}

/**
 * The signature base string (§3.4.1) of a request to `url` with `form` and the protocol parameters `oauth` (without
 * `oauth_signature`).
 */
export const signatureBaseString = (
  method: string,
  url: string,
  form: ReadonlyArray<readonly [string, string]>,
  oauth: Readonly<Record<string, string>>,
): string => {
  const parsed = new URL(url);
  const baseUri = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;

  const parameters = sortedParameters([
    ...new URLSearchParams(parsed.search),
    ...form,
    ...Object.entries(oauth),
  ]);

  return [method.toUpperCase(), percentEncode(baseUri), percentEncode(parameters)].join("&");
};

/** The `Authorization` header of `request` signed with `keys` (§3.5.1). */
export const oauth1Authorization = (
  request: OAuth1Request,
  keys: OAuth1Keys,
  { nonce, timestamp, extra = {} }: OAuth1Params,
): string => {
  const oauth = {
    oauth_consumer_key: keys.consumerKey,
    ...(keys.token === undefined ? {} : { oauth_token: keys.token }),
    oauth_signature_method: keys.signatureMethod,
    oauth_timestamp: String(timestamp),
    oauth_nonce: nonce,
    ...extra,
  };

  const base = signatureBaseString(request.method, request.url, request.form ?? [], oauth);
  const key = `${percentEncode(keys.consumerSecret)}&${percentEncode(keys.tokenSecret ?? "")}`;

  const signature = hmac(
    keys.signatureMethod === "HMAC-SHA256" ? "sha256" : "sha1",
    key,
    base,
  ).toString("base64");

  const parameters = Object.entries({ ...oauth, oauth_signature: signature }).map(
    ([name, value]) => `${name}="${percentEncode(value)}"`,
  );

  const realm = keys.realm === undefined ? [] : [`realm="${keys.realm.replace(/["\\]/g, "\\$&")}"`];

  return `OAuth ${[...realm, ...parameters].join(", ")}`;
};
