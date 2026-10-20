/**
 * AWS Signature Version 4 (#206): the canonical request of an HTTP request, the string to sign under the date's,
 * region's and service's scope, and the `Authorization` header that carries the signature, as AWS's documentation and
 * its test suite define them. Each request is signed when it is made, for the toolkit's region and service.
 *
 * A request is sent with its path and query percent-encoded as RFC 3986 says ({@link sigV4Url}), so what AWS reads is
 * what was signed: the canonical URI is that path normalized and percent-encoded once more (each segment encoded twice,
 * as every service but S3 reads it; S3's is the path as sent, each segment encoded once), the canonical query every
 * parameter encoded and sorted.
 */
import { byteOrder, hmac, percentEncode, sha256Hex, sortedParameters } from "./encoding.ts";

/** AWS keys and what they sign for. */
export interface SigV4Keys {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  readonly service: string;
}

/** A request as its signature reads it: its path and query as sent, the headers to sign, and its payload's hash. */
export interface SigV4Request {
  readonly method: string;
  /** The path as sent (its percent-encoding the wire's, {@link sigV4Url}). */
  readonly path: string;
  /** The query as sent, without its `?`: `+` is a plus, as AWS reads it. */
  readonly query: string;
  /** The headers signed, `host` and `x-amz-date` among them (names in any case). */
  readonly headers: Readonly<Record<string, string>>;
  /** The payload's SHA-256 (hex), or `UNSIGNED-PAYLOAD`. */
  readonly payloadHash: string;
}

/** The request time as SigV4 writes it (`20150830T123600Z`), of epoch ms. */
export const amzDateOf = (epochMs: number): string =>
  new Date(epochMs)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** `text` percent-decoded, or as it is when it is not valid percent-encoding. */
const decoded = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/**
 * `url` as a SigV4 request sends it: each path segment and each query parameter percent-encoded as RFC 3986 says, so
 * AWS reads the URL as it is signed. The query is read as a form's (`+` a space), as `URLSearchParams` writes it, and
 * written with `%20` for a space and `%2B` for a plus, which AWS reads as a plus.
 */
export const sigV4Url = (url: string): URL => {
  const sent = new URL(url);
  const query = [...sent.searchParams];

  sent.pathname = sent.pathname
    .split("/")
    .map((segment) => percentEncode(decoded(segment)))
    .join("/");

  sent.search = query
    .map(([name, value]) => `${percentEncode(name)}=${percentEncode(value)}`)
    .join("&");

  return sent;
};

/**
 * The canonical URI of a path as sent: S3's is the path itself; every other service's is the path normalized (no empty,
 * `.` or `..` segments, as RFC 3986 resolves them) with each segment percent-encoded once more, so a segment sent
 * encoded once is signed encoded twice.
 */
const canonicalUri = (path: string, service: string): string => {
  if (service === "s3") return path === "" ? "/" : path;

  const segments: Array<string> = [];

  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;

    if (segment === "..") segments.pop();
    else segments.push(percentEncode(segment));
  }

  const trailing = segments.length > 0 && path.endsWith("/") ? "/" : "";

  return `/${segments.join("/")}${trailing}`;
};

/** The query's parameters, as AWS reads them (`%XX` decoded, `+` a plus), encoded and sorted by name, then value. */
const canonicalQuery = (query: string): string =>
  sortedParameters(
    query
      .split("&")
      .filter((parameter) => parameter !== "")
      .map((parameter) => {
        const at = parameter.indexOf("=");

        return at === -1
          ? [decoded(parameter), ""]
          : [decoded(parameter.slice(0, at)), decoded(parameter.slice(at + 1))];
      }),
  );

/** The canonical request of `request` for `service`, and the names of the headers it signs (`host;x-amz-date`). */
export const canonicalRequest = (request: SigV4Request, service: string) => {
  const headers = Object.entries(request.headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
    .toSorted(([a], [b]) => byteOrder(a, b));

  const signedHeaders = headers.map(([name]) => name).join(";");

  const canonical = [
    request.method.toUpperCase(),
    canonicalUri(request.path, service),
    canonicalQuery(request.query),
    ...headers.map(([name, value]) => `${name}:${value}`),
    "",
    signedHeaders,
    request.payloadHash,
  ].join("\n");

  return { canonical, signedHeaders };
};

/** The `Authorization` header of `request` signed with `keys` at `amzDate` ({@link amzDateOf}). */
export const sigV4Authorization = (
  request: SigV4Request,
  keys: SigV4Keys,
  amzDate: string,
): string => {
  const { canonical, signedHeaders } = canonicalRequest(request, keys.service);

  const date = amzDate.slice(0, 8);
  const scope = `${date}/${keys.region}/${keys.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonical)].join("\n");

  const signingKey = [date, keys.region, keys.service, "aws4_request"].reduce<Uint8Array | string>(
    (key, part) => hmac("sha256", key, part),
    `AWS4${keys.secretAccessKey}`,
  );

  const signature = hmac("sha256", signingKey, toSign).toString("hex");

  return `AWS4-HMAC-SHA256 Credential=${keys.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
};
