/**
 * `multipart/form-data` for System One requests (ADR 0032): TypeSafe's SDKs upload images as file parts next to a
 * JSON `request` part. Workers addition, no Go counterpart.
 *
 * The body is split by hand rather than with `Request.formData()`: a part without a filename would come back as a
 * string there, decoded as UTF-8, which corrupts image bytes. Here every part keeps its bytes (a view into the body,
 * nothing is copied), its name, filename and content type. {@link encodeMultipart} writes parts the way TypeSafe's
 * JavaScript SDK does (`request` first as `application/json` without a filename, files with a filename and their
 * content type), as a `Blob` that only references the files, so a retry sends the same bytes without reading them.
 */

/** One part of a multipart body. */
export interface MultipartPart {
  readonly name: string;
  /** `filename` of the part's `Content-Disposition`, when it has one. */
  readonly filename?: string;
  /** The part's `Content-Type` (lower case, parameters kept), when it has one. */
  readonly contentType?: string;
  readonly body: Uint8Array;
}

export type MultipartResult =
  | { readonly ok: true; readonly parts: ReadonlyArray<MultipartPart> }
  | { readonly ok: false; readonly error: string };

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const CRLF = encoder.encode("\r\n");

const HEADER_END = encoder.encode("\r\n\r\n");

/** The `boundary` parameter of a `multipart/form-data` content type (quoted or not). */
export const multipartBoundary = (contentType: string): string | undefined => {
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = (match?.[1] ?? match?.[2] ?? "").trim();

  return boundary === "" || boundary.length > 70 ? undefined : boundary;
};

/** First index of `needle` in `haystack` at or after `from`; -1 when absent. */
const indexOf = (haystack: Uint8Array, needle: Uint8Array, from: number): number => {
  const first = needle[0];

  if (first === undefined) return from;
  const last = haystack.length - needle.length;

  for (let at = haystack.indexOf(first, from); at !== -1 && at <= last;) {
    let matched = true;

    for (let offset = 1; offset < needle.length; offset += 1) {
      if (haystack[at + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }

    if (matched) return at;
    at = haystack.indexOf(first, at + 1);
  }

  return -1;
};

const startsWith = (bytes: Uint8Array, prefix: Uint8Array, at: number): boolean =>
  prefix.every((byte, offset) => bytes[at + offset] === byte);

/** `name="x"; filename="y"` parameters of a `Content-Disposition` value (quoted strings may hold `;`). */
const dispositionParams = (value: string): Map<string, string> => {
  const params = new Map<string, string>();
  const pattern = /;\s*([A-Za-z0-9_*-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g;

  for (const match of value.matchAll(pattern)) {
    const key = (match[1] ?? "").toLowerCase();
    const raw = match[2] !== undefined ? match[2].replace(/\\(.)/g, "$1") : (match[3] ?? "").trim();

    if (key !== "" && !params.has(key)) params.set(key, raw);
  }

  return params;
};

const parsePartHeaders = (
  text: string,
): { name: string; filename?: string; contentType?: string } | string => {
  let disposition: Map<string, string> | undefined;
  let contentType: string | undefined;

  for (const line of text.split("\r\n")) {
    const colon = line.indexOf(":");

    if (colon <= 0) continue;
    const header = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (header === "content-disposition") {
      if (!/^form-data\b/i.test(value)) return "a part is not form-data";
      disposition = dispositionParams(value);
    } else if (header === "content-type") {
      contentType = value.toLowerCase();
    }
  }

  const name = disposition?.get("name");

  if (name === undefined) return "a part has no name";
  const filename = disposition?.get("filename");

  return {
    name,
    ...(filename === undefined ? {} : { filename }),
    ...(contentType === undefined || contentType === "" ? {} : { contentType }),
  };
};

/** Splits a `multipart/form-data` body into its parts (RFC 7578), in order. */
export const parseMultipart = (body: Uint8Array, contentType: string): MultipartResult => {
  const boundary = multipartBoundary(contentType);

  if (boundary === undefined) return { ok: false, error: "multipart body has no boundary" };
  const delimiter = encoder.encode(`--${boundary}`);
  const separator = encoder.encode(`\r\n--${boundary}`);
  const parts: MultipartPart[] = [];
  let at = indexOf(body, delimiter, 0);

  if (at !== 0 && at !== -1) {
    // A preamble is allowed; the delimiter then starts a line.
    at = indexOf(body, separator, 0);
    at = at === -1 ? -1 : at + 2;
  }

  if (at === -1) return { ok: false, error: "multipart body has no parts" };

  for (;;) {
    at += delimiter.length;

    if (body[at] === 0x2d && body[at + 1] === 0x2d) return { ok: true, parts };

    // Transport padding after the delimiter, then the line break.
    while (body[at] === 0x20 || body[at] === 0x09) at += 1;

    if (!startsWith(body, CRLF, at)) return { ok: false, error: "malformed multipart delimiter" };
    const headersStart = at + CRLF.length;
    const headersEnd = indexOf(body, HEADER_END, headersStart);

    if (headersEnd === -1) return { ok: false, error: "malformed multipart part headers" };
    const headers = parsePartHeaders(decoder.decode(body.subarray(headersStart, headersEnd)));

    if (typeof headers === "string") return { ok: false, error: headers };
    const contentStart = headersEnd + HEADER_END.length;
    const next = indexOf(body, separator, contentStart);

    if (next === -1) return { ok: false, error: "multipart body is not terminated" };
    parts.push({ ...headers, body: body.subarray(contentStart, next) });
    at = next + CRLF.length;
  }
};

/** A part to write: text or a file (its name is the filename, its type the content type). */
export interface EncodedPart {
  readonly name: string;
  readonly value: { readonly json: string } | { readonly file: File };
}

/** `"` and line breaks in a disposition parameter, escaped as browsers do (HTML's form submission). */
const quoted = (value: string): string =>
  `"${value.replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/"/g, "%22")}"`;

/** A fresh boundary: 32 random hex digits, like TypeSafe's SDK. */
export const newBoundary = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

/** An encoded `multipart/form-data` body and the content type naming its boundary. */
export interface MultipartBody {
  readonly body: Blob;
  readonly contentType: string;
}

/** The multipart body of `parts` and its content type. */
export const encodeMultipart = (
  parts: ReadonlyArray<EncodedPart>,
  boundary: string = newBoundary(),
): MultipartBody => {
  const chunks: Array<string | Blob> = [];

  for (const part of parts) {
    const value = part.value;
    let head = `--${boundary}\r\nContent-Disposition: form-data; name=${quoted(part.name)}`;

    if ("json" in value) {
      chunks.push(`${head}\r\nContent-Type: application/json\r\n\r\n`, value.json, "\r\n");
      continue;
    }

    head += `; filename=${quoted(value.file.name)}`;

    if (value.file.type !== "") head += `\r\nContent-Type: ${value.file.type}`;
    chunks.push(`${head}\r\n\r\n`, value.file, "\r\n");
  }

  chunks.push(`--${boundary}--\r\n`);

  return {
    body: new Blob(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
};
