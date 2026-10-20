/**
 * A webhook trigger's deliveries (#231, ADR 0040): its secret, how a delivery proves it holds it, the run's input (the
 * trigger's template with `{{body}}` replaced by the body, or the body alone) and the delivery's idempotency key (its
 * delivery id, else a hash of its body and minute). The checks compare in constant time.
 *
 * A delivery proves itself with `Authorization: Bearer <secret>`, or with a signature, Standard Webhooks' way:
 * `X-Commissary-Delivery: <id>`, `X-Commissary-Timestamp: <unix seconds>` and `X-Commissary-Signature: sha256=<hex>`,
 * an HMAC-SHA256 under the secret of `<id>.<timestamp>.<raw body>`. A signature whose timestamp is more than
 * {@link WEBHOOK_TOLERANCE_SECONDS} from now is refused, so a captured signed delivery cannot be replayed later (as
 * Polar's webhooks); within the tolerance a replay either names the signed id, whose run it finds, or fails the proof.
 */
import { Buffer } from "node:buffer";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { WEBHOOK_BODY_PLACEHOLDER } from "@commissary/contract/agent-triggers";

/** The headers a delivery may name its id in, in this order: Commissary's, then Standard Webhooks'. */
export const DELIVERY_ID_HEADERS = ["x-commissary-delivery", "webhook-id"] as const;

/** The signature header: `sha256=<hex>`, an HMAC-SHA256 of `<delivery id>.<timestamp>.<raw body>` under the secret. */
export const SIGNATURE_HEADER = "x-commissary-signature";

/** The signature's timestamp header: unix seconds, signed with the body. */
export const TIMESTAMP_HEADER = "x-commissary-timestamp";

/** How far a signature's timestamp may be from now, either way (Standard Webhooks' default, as Polar's webhooks). */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** The longest delivery id kept as it is; a longer one is hashed into the key. */
const MAX_DELIVERY_ID = 128;

/** A new webhook secret: `whsec_` and 32 random bytes, base64url. */
export const freshWebhookSecret = (): string =>
  `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;

/** What a delivery presents: its `Authorization` header, and its signature, timestamp and delivery id headers. */
export interface WebhookProof {
  readonly authorization?: string | undefined;
  readonly signature?: string | undefined;
  readonly timestamp?: string | undefined;
  /** `X-Commissary-Delivery`: signed with the timestamp and body, and then the delivery's key. */
  readonly delivery?: string | undefined;
}

const sameText = (a: string, b: string): boolean => {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();

  // Compared as digests: equal lengths, so the comparison takes the same time whatever was sent.
  return timingSafeEqual(left, right);
};

/**
 * Whether `proof` shows the holder of `secret` sent `body`: as a bearer token, or as a signature of its delivery id,
 * timestamp and body whose timestamp is within {@link WEBHOOK_TOLERANCE_SECONDS} of `now` (epoch ms).
 */
export const proves = (
  proof: WebhookProof,
  secret: string,
  body: Uint8Array,
  now: number,
): boolean => {
  const bearer = /^Bearer\s+(.+)$/i.exec(proof.authorization?.trim() ?? "")?.[1]?.trim();

  if (bearer !== undefined && sameText(bearer, secret)) return true;

  const hex = /^sha256=([0-9a-f]{64})$/i.exec(proof.signature?.trim() ?? "")?.[1];
  const timestamp = /^\d{1,12}$/.exec(proof.timestamp?.trim() ?? "")?.[0];
  const delivery = proof.delivery?.trim() ?? "";

  if (hex === undefined || timestamp === undefined || delivery === "") return false;

  const expected = createHmac("sha256", secret)
    .update(`${delivery}.${timestamp}.`, "utf8")
    .update(body)
    .digest();

  const signed = timingSafeEqual(Buffer.from(hex, "hex"), expected);

  return signed && Math.abs(now / 1000 - Number(timestamp)) <= WEBHOOK_TOLERANCE_SECONDS;
};

/** The run's input: `template` with every `{{body}}` replaced by `body`, or `body` alone without a template. */
export const webhookInput = (template: string | undefined, body: string): string =>
  template === undefined ? body : template.replaceAll(WEBHOOK_BODY_PLACEHOLDER, () => body);

/**
 * The idempotency key of a delivery to the trigger: its delivery id (the first of {@link DELIVERY_ID_HEADERS} it
 * names), else the SHA-256 of its body and the minute it came in (`now`, epoch ms).
 */
export const deliveryKey = (
  headers: Readonly<Record<string, string | undefined>>,
  body: Uint8Array,
  now: number,
): string => {
  for (const header of DELIVERY_ID_HEADERS) {
    const id = headers[header]?.trim();

    if (id !== undefined && id !== "")
      return id.length <= MAX_DELIVERY_ID
        ? `webhook:id:${id}`
        : `webhook:id-sha256:${createHash("sha256").update(id, "utf8").digest("hex")}`;
  }

  const digest = createHash("sha256").update(body).digest("hex");

  return `webhook:body-sha256:${digest}:${Math.floor(now / 60_000)}`;
};
