// Connecting a toolkit's credentials (#208, ADR 0036, ADR 0038, GLOSSARY "Toolkit sign-in", "Credential settings"):
// which ways to sign in a slot offers, the form of every credential type the management API takes, the body each sends,
// the credential settings some types need, and who may use a shared credential. Pure: no DOM, tested in
// test/toolkit-credentials.test.ts.
import { Option, Schema } from "effect";
import type { GrantSubject, ToolGrant } from "@commissary/contract/grants";
import {
  ConnectCredential,
  CredentialSettings,
  type ConnectedGrant,
  type CredentialSlot,
  JwtAlgorithm,
  type ToolkitCredentialKind,
  type ToolkitView,
} from "@commissary/contract/tools";

/**
 * A way to sign in to a toolkit: one of the credential types. `oauth` is the OAuth sign-in in a browser (an OAuth 1.0a
 * one where the toolkit's OAuth app is an OAuth 1.0a consumer); every other is connected from a form.
 */
export type CredentialWay = ToolkitCredentialKind;

// ---------------------------------------------------------------------------------------------------------------
// The forms

/** One field of a form: its value is a string, read into the body the form sends. */
export interface FormField {
  readonly key: string;
  readonly label: string;
  /** Typed into a password field (a text area obscured until shown), and sent as typed (never trimmed). */
  readonly secret: boolean;
  readonly optional: boolean;
  /** A text area: a PEM private key, a template a line, JSON. */
  readonly multiline?: boolean;
  /** A choice of these values (a select). */
  readonly options?: ReadonlyArray<string>;
  readonly hint?: string;
  /** What the form says when a required field is empty. */
  readonly missing?: string;
}

/** A form's values by field key; a field never typed in reads as empty. */
export type FieldValues = Readonly<Record<string, string>>;

/** What a form sends, or why it cannot yet: a message per field key (`form`: the whole form's). */
export type FormResult<A> =
  | { readonly ok: true; readonly body: A }
  | { readonly ok: false; readonly problems: Readonly<Record<string, string>> };

/** The key of a problem that belongs to no one field. */
export const FORM_PROBLEM = "form";

const field = (
  key: string,
  label: string,
  options: Partial<Omit<FormField, "key" | "label">> = {},
): FormField => ({ key, label, secret: false, optional: false, ...options });

const secret = (key: string, label: string, options: Partial<FormField> = {}): FormField =>
  field(key, label, { ...options, secret: true });

const optional = (key: string, label: string, options: Partial<FormField> = {}): FormField =>
  field(key, label, { ...options, optional: true });

/** A field's value as it is sent: a secret as typed, anything else trimmed; empty is `undefined`. */
const valueOf = (spec: FormField, values: FieldValues): string | undefined => {
  const raw = values[spec.key] ?? "";

  if (raw.trim() === "") return undefined;

  return spec.secret ? raw : raw.trim();
};

/** The filled fields of a form, or a problem for each required one left empty. */
export const readFields = (
  specs: ReadonlyArray<FormField>,
  values: FieldValues,
): FormResult<Readonly<Record<string, string>>> => {
  const read: Record<string, string> = {};
  const problems: Record<string, string> = {};

  for (const spec of specs) {
    const value = valueOf(spec, values);

    if (value !== undefined) read[spec.key] = value;
    else if (!spec.optional)
      problems[spec.key] = spec.missing ?? `Enter the ${spec.label.toLowerCase()}.`;
  }

  return Object.keys(problems).length > 0 ? { ok: false, problems } : { ok: true, body: read };
};

/** The values of a form's secret fields emptied: what a cancelled form keeps. */
export const withoutSecrets = (specs: ReadonlyArray<FormField>, values: FieldValues): FieldValues =>
  Object.fromEntries(
    Object.entries(values).filter(
      ([key]) => !specs.some((spec) => spec.key === key && spec.secret),
    ),
  );

/** The names a compound credential's template uses (`{api_key}`), each once, in the order they appear. */
const templateNames = (toolkit: ToolkitView): ReadonlyArray<string> => {
  const compound = toolkit.credential_settings?.compound;

  const templates = [
    ...Object.values(compound?.headers ?? {}),
    ...Object.values(compound?.query ?? {}),
    ...(compound?.base_url === undefined ? [] : [compound.base_url]),
  ];

  return [
    ...new Set(
      templates.flatMap((template) =>
        [...template.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1] ?? ""),
      ),
    ),
  ].filter((name) => name !== "");
};

const COMPOUND_FIELD = "fields.";

/** Where a key goes that the catalog source names (`catalog.credential`), when the toolkit was added that way. */
const catalogPlace = (toolkit: ToolkitView, way: CredentialWay) => {
  const credential = toolkit.catalog?.credential;

  return credential?.kind === way && credential.name !== undefined ? credential : undefined;
};

const placedKeyFields = (
  toolkit: ToolkitView,
  way: "header" | "query",
): ReadonlyArray<FormField> => {
  const place = catalogPlace(toolkit, way);
  const label = way === "header" ? "Header" : "Query parameter";
  const missing = `Enter the ${label.toLowerCase()} the key goes in.`;
  const key = secret("value", "Key");

  if (place === undefined) return [field("name", label, { missing }), key];

  const where =
    way === "header"
      ? `${place.name}${place.prefix === undefined ? "" : `, after ${place.prefix}`}`
      : `the query parameter ${place.name}`;

  return [
    optional("name", label, {
      hint: `Leave it empty to send the key in ${where}, as the catalog says.`,
    }),
    key,
  ];
};

/** A credential type's settings entry as stored (`CredentialSettings`): JSON, an object. */
type SettingsEntry = Schema.JsonObject;

/** Template lines (`headers`, `query`) as their text area shows them: `Name: template` a line. */
const linesOf = (record: Schema.Json | undefined, between: string): string =>
  typeof record === "object" && record !== null && !Array.isArray(record)
    ? Object.entries(record)
        .map(
          ([name, template]) =>
            `${name}${between}${typeof template === "string" ? template : JSON.stringify(template)}`,
        )
        .join("\n")
    : "";

/** A template a line (`Name: template` or `name=template`), or `undefined` when a line has no separator. */
const readLines = (
  lines: string | undefined,
  separator: string,
): Readonly<Record<string, string>> | undefined => {
  const record: Record<string, string> = {};

  for (const line of (lines ?? "").split("\n").map((each) => each.trim())) {
    if (line === "") continue;
    const at = line.indexOf(separator);

    if (at <= 0) return undefined;
    record[line.slice(0, at).trim()] = line.slice(at + separator.length).trim();
  }

  return record;
};

/** A JWT's extra claims as typed: a JSON object. */
const decodeClaims = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

const LIFETIME = { min: 120, max: 3600 } as const;

/** What a JWT's settings form reads that is not sent as typed: its lifetime, a number, and its claims, JSON. */
const parsedJwt = (read: Readonly<Record<string, string>>): FormResult<SettingsEntry> => {
  const problems: Record<string, string> = {};
  const { lifetime_seconds: lifetimeText, claims: claimsText, ...rest } = read;
  const lifetime = lifetimeText === undefined ? undefined : Number(lifetimeText);
  const claims = claimsText === undefined ? Option.none() : decodeClaims(claimsText);

  if (!JwtAlgorithm.literals.some((algorithm) => algorithm === read["algorithm"]))
    problems["algorithm"] = "Pick the algorithm.";

  if (
    lifetime !== undefined &&
    !(Number.isInteger(lifetime) && lifetime >= LIFETIME.min && lifetime <= LIFETIME.max)
  )
    problems["lifetime_seconds"] = "A lifetime is a whole number of seconds from 120 to 3600.";

  if (claimsText !== undefined && Option.isNone(claims))
    problems["claims"] = "Claims are a JSON object.";

  return Object.keys(problems).length > 0
    ? { ok: false, problems }
    : {
        ok: true,
        body: {
          ...rest,
          ...(lifetime === undefined ? {} : { lifetime_seconds: lifetime }),
          ...(Option.isSome(claims) ? { claims: claims.value } : {}),
        },
      };
};

/** What a compound template's settings form reads: headers and query parameters a line each. */
const parsedCompound = (read: Readonly<Record<string, string>>): FormResult<SettingsEntry> => {
  const headers = readLines(read["headers"], ":");
  const query = readLines(read["query"], "=");
  const problems: Record<string, string> = {};

  if (headers === undefined)
    problems["headers"] = "Write each header as Name: template, one a line.";

  if (query === undefined)
    problems["query"] = "Write each query parameter as name=template, one a line.";

  const some = (key: string, lines: Readonly<Record<string, string>> | undefined) =>
    lines === undefined || Object.keys(lines).length === 0 ? {} : { [key]: lines };

  return Object.keys(problems).length > 0
    ? { ok: false, problems }
    : {
        ok: true,
        body: {
          ...some("headers", headers),
          ...some("query", query),
          ...(read["base_url"] === undefined ? {} : { base_url: read["base_url"] }),
        },
      };
};

/** A credential type's settings, the toolkit's (#206): their form, and how it reads and shows what is not plain text. */
interface SettingsSpec {
  /** Connecting is refused until the toolkit has them (`oauth1`'s and `app`'s are optional). */
  readonly required: boolean;
  readonly fields: ReadonlyArray<FormField>;
  /** The form's values of the fields not stored as text or a number. */
  readonly shown?: (entry: SettingsEntry) => FieldValues;
  /** What is stored of the fields not sent as typed, or a problem per field. */
  readonly parsed?: (read: Readonly<Record<string, string>>) => FormResult<SettingsEntry>;
}

/** One credential type: its names, its form's fields and its settings. */
interface CredentialType {
  /** On its own: a picker's option. */
  readonly label: string;
  /** Inside a sentence. */
  readonly name: string;
  /** Its form's fields; none for the sign-in, whose form is a browser's. */
  readonly fields: (toolkit: ToolkitView) => ReadonlyArray<FormField>;
  readonly settings?: SettingsSpec;
}

const NO_FIELDS = (): ReadonlyArray<FormField> => [];

const SCOPES = optional("scope", "Scopes", { hint: "Space separated." });

/** Every credential type the management API takes, in the order the form offers them. */
const TYPES: Readonly<Record<CredentialWay, CredentialType>> = {
  oauth: { label: "Sign in with OAuth", name: "OAuth sign-in", fields: NO_FIELDS },
  none: { label: "No sign-in", name: "no sign-in", fields: NO_FIELDS },
  bearer: { label: "Bearer token", name: "bearer token", fields: () => [secret("token", "Token")] },
  header: {
    label: "Key in a header",
    name: "key in a header",
    fields: (toolkit) => placedKeyFields(toolkit, "header"),
  },
  query: {
    label: "Key in the query",
    name: "key in the query",
    fields: (toolkit) => placedKeyFields(toolkit, "query"),
  },
  basic: {
    label: "Username and password",
    name: "basic auth",
    fields: () => [field("username", "Username"), secret("password", "Password")],
  },
  client_credentials: {
    label: "OAuth client credentials",
    name: "OAuth client credentials",
    fields: () => [
      field("client_id", "Client ID"),
      secret("client_secret", "Client secret"),
      optional("token_url", "Token URL", {
        hint: "Leave it empty to use the token endpoint the MCP server's authorization server names.",
      }),
      SCOPES,
    ],
  },
  oauth1: {
    label: "OAuth 1.0a tokens",
    name: "OAuth 1.0a",
    fields: () => [
      field("consumer_key", "Consumer key"),
      secret("consumer_secret", "Consumer secret"),
      field("token", "Token"),
      secret("token_secret", "Token secret"),
    ],
    settings: {
      required: false,
      fields: [
        optional("signature_method", "Signature method", {
          options: ["HMAC-SHA1", "HMAC-SHA256"],
          hint: "HMAC-SHA1 unless the service says otherwise.",
        }),
        optional("realm", "Realm"),
      ],
    },
  },
  tba: {
    label: "NetSuite token-based auth",
    name: "NetSuite token-based auth",
    fields: () => [
      field("consumer_key", "Consumer key"),
      secret("consumer_secret", "Consumer secret"),
      field("token_id", "Token ID"),
      secret("token_secret", "Token secret"),
    ],
    settings: {
      required: true,
      fields: [field("account_id", "Account ID", { hint: "Like 1234567_SB1." })],
    },
  },
  jwt: {
    label: "Signed JWT",
    name: "signed JWT",
    fields: () => [
      secret("private_key", "Private key", {
        multiline: true,
        hint: "A PEM private key, or an HMAC algorithm's shared secret.",
      }),
      optional("key_id", "Key ID"),
      optional("issuer", "Issuer"),
      optional("sub", "Subject", { hint: "The JWT's sub claim: a user the key acts for." }),
      optional("client_id", "Client ID"),
      secret("client_secret", "Client secret", { optional: true }),
    ],
    settings: {
      required: true,
      fields: [
        field("algorithm", "Algorithm", {
          options: JwtAlgorithm.literals,
          missing: "Pick the algorithm.",
        }),
        optional("token_url", "Token URL", {
          hint: "Where the JWT is exchanged for a token; leave it empty to send the JWT itself.",
        }),
        optional("audience", "Audience", { hint: "Leave it empty for the token URL." }),
        SCOPES,
        optional("lifetime_seconds", "Lifetime in seconds", { hint: "120 to 3600 (the default)." }),
        optional("claims", "More claims", { multiline: true, hint: "A JSON object." }),
      ],
      shown: (entry) => ({
        claims: entry["claims"] === undefined ? "" : JSON.stringify(entry["claims"], null, 2),
      }),
      parsed: parsedJwt,
    },
  },
  app: {
    label: "GitHub App",
    name: "GitHub App",
    fields: () => [
      field("app_id", "App ID"),
      secret("private_key", "Private key", { multiline: true }),
      field("installation_id", "Installation ID"),
    ],
    settings: {
      required: false,
      fields: [
        optional("api_url", "API URL", {
          hint: "Leave it empty for https://api.github.com; set it for GitHub Enterprise.",
        }),
      ],
    },
  },
  token_exchange: {
    label: "Token exchange",
    name: "token exchange",
    fields: () => [
      secret("subject_token", "Subject token"),
      optional("client_id", "Client ID"),
      secret("client_secret", "Client secret", { optional: true }),
    ],
    settings: {
      required: true,
      fields: [
        field("token_url", "Token URL"),
        optional("subject_token_type", "Subject token type", {
          hint: "Leave it empty for urn:ietf:params:oauth:token-type:access_token.",
        }),
        optional("requested_token_type", "Requested token type"),
        optional("audience", "Audience"),
        optional("resource", "Resource"),
        SCOPES,
      ],
    },
  },
  aws_sigv4: {
    label: "AWS keys",
    name: "AWS keys",
    fields: () => [
      field("access_key_id", "Access key ID"),
      secret("secret_access_key", "Secret access key"),
      secret("session_token", "Session token", { optional: true }),
    ],
    settings: {
      required: true,
      fields: [
        field("region", "Region", { hint: "Like us-east-1." }),
        field("service", "Service", { hint: "Like execute-api or s3." }),
      ],
    },
  },
  compound: {
    label: "Several secret fields",
    name: "several secret fields",
    fields: (toolkit) =>
      templateNames(toolkit).map((name) => secret(`${COMPOUND_FIELD}${name}`, name)),
    settings: {
      required: true,
      fields: [
        optional("headers", "Headers", {
          multiline: true,
          hint: "One a line, as Name: template, with {field} where a field goes: DD-API-KEY: {api_key}.",
        }),
        optional("query", "Query parameters", {
          multiline: true,
          hint: "One a line, as name=template.",
        }),
        optional("base_url", "Base URL", {
          hint: "An OpenAPI toolkit's, with fields in it: https://{subdomain}.example.com/api.",
        }),
      ],
      shown: (entry) => ({
        headers: linesOf(entry["headers"], ": "),
        query: linesOf(entry["query"], "="),
      }),
      parsed: parsedCompound,
    },
  },
};

export const wayLabel = (way: CredentialWay): string => TYPES[way].label;

export const wayName = (way: CredentialWay): string => TYPES[way].name;

/**
 * Whether a toolkit signs in with OAuth in a browser: an MCP server registers Commissary as its client by itself (CIMD
 * or dynamic registration); any other kind needs an OAuth app, the toolkit's own or Commissary Cloud's managed one.
 */
export const offersSignIn = (toolkit: ToolkitView): boolean =>
  toolkit.built_in !== true &&
  (toolkit.kind === "mcp" || toolkit.oauth_app !== undefined || toolkit.managed_oauth_app === true);

const ALL_WAYS = Object.keys(TYPES).filter((key): key is CredentialWay => key in TYPES);

/** The ways a slot of a toolkit offers: a client credentials grant is a shared credential's only. */
export const waysFor = (toolkit: ToolkitView, slot: CredentialSlot): ReadonlyArray<CredentialWay> =>
  ALL_WAYS.filter(
    (way) =>
      (way !== "oauth" || offersSignIn(toolkit)) &&
      (way !== "client_credentials" || slot === "shared"),
  );

/**
 * The way a form starts from: the kind of the credential it replaces, else the way the toolkit was added with from the
 * catalog, else the sign-in where there is one, else a bearer token.
 */
export const defaultWay = (toolkit: ToolkitView, slot: CredentialSlot): CredentialWay => {
  const ways = waysFor(toolkit, slot);
  const current = slot === "shared" ? toolkit.credentials.shared : toolkit.credentials.mine;

  const preferred = [current?.kind, toolkit.catalog?.credential?.kind, "oauth" as const].find(
    (way) => way !== undefined && ways.includes(way),
  );

  return preferred ?? "bearer";
};

/** The fields of a way's form (none for the sign-in, whose form is a browser's). */
export const credentialFields = (
  way: CredentialWay,
  toolkit: ToolkitView,
): ReadonlyArray<FormField> => TYPES[way].fields(toolkit);

const isConnectCredential = Schema.is(ConnectCredential);

/**
 * The body a way's form sends to connect a credential (`PUT /toolkits/:id/credentials/:slot`), with who may use it for a
 * shared credential (`subject`; none for a private one). Its fields are named as the API names them, but a compound
 * credential's, which go under `fields`. Not for the sign-in, which starts instead.
 */
export const connectBody = (
  way: Exclude<CredentialWay, "oauth">,
  values: FieldValues,
  toolkit: ToolkitView,
  subject: GrantSubject | undefined,
): FormResult<ConnectCredential> => {
  const read = readFields(credentialFields(way, toolkit), values);

  if (!read.ok) return read;

  const secret =
    way === "compound"
      ? {
          kind: way,
          fields: Object.fromEntries(
            Object.entries(read.body).map(([key, value]) => [
              key.slice(COMPOUND_FIELD.length),
              value,
            ]),
          ),
        }
      : { kind: way, ...read.body };

  const body = subject === undefined ? secret : { ...secret, subject };

  return isConnectCredential(body)
    ? { ok: true, body }
    : { ok: false, problems: { [FORM_PROBLEM]: "The form does not make a credential." } };
};

/** The body that starts a sign-in: a shared credential's names who may use it, a private one's nobody. */
export const signInBody = (
  slot: CredentialSlot,
  subject: GrantSubject,
): { readonly subject?: GrantSubject } => (slot === "shared" ? { subject } : {});

// ---------------------------------------------------------------------------------------------------------------
// Credential settings

/** The ways whose use the toolkit's credential settings describe. */
export type SettingsWay = Extract<CredentialWay, keyof CredentialSettings>;

export const isSettingsWay = (way: CredentialWay): way is SettingsWay =>
  TYPES[way].settings !== undefined;

/** Whether a way needs settings the toolkit lacks: connecting it would be refused (`422 invalid`). */
export const missingSettings = (way: CredentialWay, toolkit: ToolkitView): boolean =>
  isSettingsWay(way) &&
  TYPES[way].settings?.required === true &&
  toolkit.credential_settings?.[way] === undefined;

/** The fields of a way's settings (none for a way without settings). */
export const settingsFields = (way: CredentialWay): ReadonlyArray<FormField> =>
  TYPES[way].settings?.fields ?? [];

/** A stored setting as its field shows it: text as it is, a number in figures; empty when it is not set. */
const shownValue = (value: Schema.Json | undefined): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";

/** A way's settings as its form shows them, read from the toolkit's. */
export const settingsValuesOf = (
  way: CredentialWay,
  settings: CredentialSettings | undefined,
): FieldValues => {
  const spec = TYPES[way].settings;

  const entry: SettingsEntry = (isSettingsWay(way) ? settings?.[way] : undefined) ?? {};
  const plain = (spec?.fields ?? []).map((each) => [each.key, shownValue(entry[each.key])]);

  return Object.fromEntries([...plain, ...Object.entries(spec?.shown?.(entry) ?? {})]);
};

const isCredentialSettings = Schema.is(CredentialSettings);

/**
 * The settings a way's settings form sends, holding only that way's entry: the toolkit's managers save it whole with
 * the toolkit's other entries ({@link withSettings}, `PATCH /toolkits/:id`).
 */
export const settingsPatch = (
  way: SettingsWay,
  values: FieldValues,
):
  | { readonly ok: true; readonly settings: CredentialSettings }
  | { readonly ok: false; readonly problems: Readonly<Record<string, string>> } => {
  const spec = TYPES[way].settings;
  const read = readFields(spec?.fields ?? [], values);

  if (!read.ok) return read;
  const parsed = spec?.parsed?.(read.body) ?? { ok: true, body: read.body };

  if (!parsed.ok) return parsed;
  const settings = { [way]: parsed.body };

  return isCredentialSettings(settings)
    ? { ok: true, settings }
    : { ok: false, problems: { [FORM_PROBLEM]: "The settings are not valid." } };
};

/** The toolkit's settings with a way's entry replaced by `patch`'s. */
export const withSettings = (
  settings: CredentialSettings | undefined,
  patch: CredentialSettings,
): CredentialSettings => ({ ...settings, ...patch });

// ---------------------------------------------------------------------------------------------------------------
// Who may use a shared credential (ADR 0038: no default tool grant)

const EVERYONE: GrantSubject = { kind: "everyone" };

const sameSubject = (a: GrantSubject, b: GrantSubject): boolean =>
  a.kind === b.kind && (a.kind === "everyone" || (b.kind !== "everyone" && a.id === b.id));

const grantsOn = (toolkitId: string, grants: ReadonlyArray<ToolGrant>) =>
  grants.filter((grant) => grant.toolkit === toolkitId);

/**
 * Who a shared credential's form names at first: everyone, unless it replaces a shared credential (a key rotation) and
 * a subject holds a grant on the toolkit already (everyone first, else the first such grant's subject), so connecting
 * keeps everyone's reach as it is rather than widen it with a new all-tools grant (#198).
 */
export const defaultSubject = (
  toolkit: ToolkitView,
  grants: ReadonlyArray<ToolGrant>,
): GrantSubject => {
  if (toolkit.credentials.shared === undefined) return EVERYONE;
  const held = grantsOn(toolkit.id, grants).map((grant) => grant.subject);

  return held.find((subject) => subject.kind === "everyone") ?? held[0] ?? EVERYONE;
};

/**
 * Who a shared credential's form names: the org admin's pick once they made one, else {@link defaultSubject}, which
 * follows the tool grants as they load (they may arrive after the form opens) without overriding a pick.
 */
export const pickedSubject = (
  picked: GrantSubject | undefined,
  toolkit: ToolkitView,
  grants: ReadonlyArray<ToolGrant>,
): GrantSubject => picked ?? defaultSubject(toolkit, grants);

/** What connecting will do to the subject's tool grants, said beside the picker. */
export const grantNote = (
  subject: GrantSubject,
  toolkitId: string,
  grants: ReadonlyArray<ToolGrant>,
  label: string,
): string =>
  grantsOn(toolkitId, grants).some((grant) => sameSubject(grant.subject, subject))
    ? `${label} holds a tool grant on this toolkit already, which stays as it is.`
    : `Connecting gives ${label} every tool of this toolkit, with a new tool grant.`;

/** What connecting did, from the answer's `grant` (none for a private credential). */
export const connectedText = (
  grant: ConnectedGrant | undefined,
  label: string | undefined,
): string => {
  if (grant === undefined || label === undefined) return "Connected.";

  return grant.created
    ? `Connected. ${label} may use every tool of it, through a new tool grant.`
    : `Connected. The tool grant ${label} holds on it stays as it is.`;
};
