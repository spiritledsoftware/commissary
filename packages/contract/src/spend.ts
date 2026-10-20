/**
 * Spend limits (`/v9/management/spend`, `apps/app/src/management/spend-routes.ts`; the rules live in
 * `packages/state/src/spend/`): what a member, team, the org, a shared credential (a Models credential, or an org
 * toolkit's) or an API key may spend in a day, week or month of the org's time zone; model attempts and priced tool
 * calls (#199) count toward the same limits. Workers addition, no Go counterpart. Shared with the browser: imports `effect` and
 * `./errors.ts` only.
 *
 * Amounts are micro-USD (1 USD = 1,000,000). An org admin sees and writes every limit and sets the calendar; a plain
 * member sees the limits that bind them (their own, their teams', the org's and those on their API keys) and writes
 * limits on their own API keys, never above an admin's limit on that key. A credential limit names the credential by
 * its `auth_index`, a `toolkit_credential` limit the toolkit by its id. Each limit has a revision: an edit names the one it was based on in `If-Match`.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { managementErrors } from "./errors.ts";

const optional = Schema.optionalKey;

/** `toolkit_credential`: an org toolkit's shared credential (#199), named by the toolkit's id; its tool calls count toward it. */
export const SpendSubjectKind = Schema.Literals([
  "member",
  "team",
  "org",
  "credential",
  "key",
  "toolkit_credential",
]);

export type SpendSubjectKind = typeof SpendSubjectKind.Type;

export const SpendPeriod = Schema.Literals(["day", "week", "month"]);

export type SpendPeriod = typeof SpendPeriod.Type;

export const SpendWeekStart = Schema.Literals([
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
]);

export type SpendWeekStart = typeof SpendWeekStart.Type;

/** A limit with what has been spent under it in the current period. Times are ISO. */
export const SpendLimitView = Schema.Struct({
  id: Schema.String,
  kind: SpendSubjectKind,
  /** Member, team, API key and toolkit ids; the `auth_index` of a credential; empty for the org. */
  subject: Schema.String,
  /** What to show for the subject: an email, a team name, an API key's name, a credential's label, a toolkit's name. */
  label: Schema.String,
  period: SpendPeriod,
  amount_micros: Schema.Number,
  /** Who wrote it: an org admin, or a member on their own API key. */
  source: Schema.Literals(["admin", "member"]),
  revision: Schema.Int,
  /** Spent so far in the current period, and what is left of the amount (0 once it is reached). */
  spent_micros: Schema.Number,
  remaining_micros: Schema.Number,
  period_start: Schema.String,
  /** When the current period ends and the counter starts over. */
  resets_at: Schema.String,
  /** Whether the caller may edit and delete it. */
  editable: Schema.Boolean,
  updated_at: Schema.String,
  updated_by: Schema.String,
});

export type SpendLimitView = typeof SpendLimitView.Type;

export const SpendSettingsView = Schema.Struct({
  /** An IANA time zone name; periods run from local midnight to local midnight. */
  time_zone: Schema.String,
  week_start: SpendWeekStart,
});

export type SpendSettingsView = typeof SpendSettingsView.Type;

/** `GET /spend`: the calendar and the limits the caller sees; `now` is when the Spend was read. */
export const SpendView = Schema.Struct({
  ...SpendSettingsView.fields,
  now: Schema.String,
  limits: Schema.Array(SpendLimitView),
});

export type SpendView = typeof SpendView.Type;

export const CreateSpendLimit = Schema.Struct({
  kind: SpendSubjectKind,
  subject: Schema.String,
  period: SpendPeriod,
  amount_micros: Schema.Number,
});

export type CreateSpendLimit = typeof CreateSpendLimit.Type;

export const UpdateSpendLimit = Schema.Struct({ amount_micros: Schema.Number });

export type UpdateSpendLimit = typeof UpdateSpendLimit.Type;

export const UpdateSpendSettings = Schema.Struct({
  time_zone: optional(Schema.String),
  week_start: optional(Schema.String),
});

export type UpdateSpendSettings = typeof UpdateSpendSettings.Type;

/** The `If-Match` request header: the limit's revision the edit was based on (a bare number or `"<number>"`). */
const IfMatch = { headers: Schema.Struct({ "if-match": Schema.String }) };

const idParam = { params: { id: Schema.String } };

export class SpendGroup extends HttpApiGroup.make("spend").add(
  HttpApiEndpoint.get("overview", "/spend", { success: SpendView, error: managementErrors }),
  /**
   * `422 invalid_limit` (amount, subject), `422 exceeds_admin_limit` (a member above an admin's limit on their key),
   * `409 conflict` (the subject has a limit for the period), `404 subject_not_found`, `403 forbidden` (a member
   * limits something but their own API keys).
   */
  HttpApiEndpoint.post("create", "/spend/limits", {
    payload: CreateSpendLimit,
    success: SpendLimitView.pipe(HttpApiSchema.status(201)),
    error: managementErrors,
  }),
  /** Change the amount; `409 conflict` when the revision is stale. */
  HttpApiEndpoint.put("update", "/spend/limits/:id", {
    ...idParam,
    ...IfMatch,
    payload: UpdateSpendLimit,
    success: SpendLimitView,
    error: managementErrors,
  }),
  /** Remove a limit (and, with the last one on a subject and period, its counter); `409 conflict` when stale. */
  HttpApiEndpoint.delete("remove", "/spend/limits/:id", {
    ...idParam,
    ...IfMatch,
    success: SpendLimitView,
    error: managementErrors,
  }),
  /** Org admins only. A new calendar starts new counters for periods that begin differently. */
  HttpApiEndpoint.patch("settings", "/spend/settings", {
    payload: UpdateSpendSettings,
    success: SpendSettingsView,
    error: managementErrors,
  }),
) {}
