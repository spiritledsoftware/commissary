/**
 * The OAuth 2 state of the org's toolkits (#202), in the ControlPlane's SQLite beside the toolkits (`toolkits/store.ts`):
 *
 * - each toolkit's own OAuth app (`toolkit_oauth_apps`), its client secret sealed with the org's data key for its row
 *   (an OAuth 1.0a consumer when it names a temporary credential request URL, #206);
 * - the client dynamic registration gave Commissary at a toolkit's authorization server (`toolkit_oauth_clients`), kept
 *   per toolkit with the issuer and redirect URI it was made for, so a changed authorization server registers again. A
 *   new registration is kept once a sign-in with it completed (it rides in the sign-in's flow until then), so a sign-in
 *   that is abandoned never replaces the client the toolkit's credentials refresh their tokens with;
 * - the toolkit sign-ins in flight (`toolkit_sign_ins`), named by their state, with Models' login session rules (a
 *   sign-in expires {@link SESSION_TTL_MS} after it starts or fails, a completed one {@link COMPLETED_TTL_MS} after;
 *   the browser has {@link CALLBACK_WINDOW_MS} to come back; one exchange at a time under a lease). A sign-in's flow
 *   (its PKCE verifier, a new registration's secret) is sealed in its row, never answered, and wiped when it ends.
 *
 * Every table is keyed by `toolkit_id`, so removing a toolkit removes its rows (`TOOLS_TABLES`).
 */
import type { GrantSubject } from "@commissary/contract/grants";
import type { ClientVia } from "@commissary/contract/tools";
import type { Sealer } from "@commissary/state";
import type { ClientAuth } from "./token.ts";

/** How long a sign-in lives once started or failed (Models' `SESSION_TTL_MS`). */
export const SESSION_TTL_MS = 30 * 60_000;

/** How long a completed sign-in is kept, so its starter learns that it completed. */
export const COMPLETED_TTL_MS = 60_000;

/** How long the browser has to come back from the authorization server (Models' `CALLBACK_WINDOW_MS`). */
export const CALLBACK_WINDOW_MS = 5 * 60_000;

/** An exchange in flight holds its session at most this long (an interrupted request lets go). */
export const BUSY_LEASE_MS = 2 * 60_000;

export const OAUTH_TABLES = [
  "toolkit_oauth_apps",
  "toolkit_oauth_clients",
  "toolkit_sign_ins",
] as const;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS toolkit_oauth_apps (
     toolkit_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, secret TEXT NOT NULL, authorize_url TEXT NOT NULL,
     token_url TEXT NOT NULL, scopes TEXT NOT NULL, issuer TEXT NOT NULL, updated_at INTEGER NOT NULL,
     updated_by TEXT NOT NULL, request_token_url TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS toolkit_oauth_clients (
     toolkit_id TEXT PRIMARY KEY, issuer TEXT NOT NULL, redirect_uri TEXT NOT NULL, client_id TEXT NOT NULL,
     secret TEXT NOT NULL, auth TEXT NOT NULL, registered_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS toolkit_sign_ins (
     state TEXT PRIMARY KEY, toolkit_id TEXT NOT NULL, owner TEXT NOT NULL, started_by TEXT NOT NULL,
     status TEXT NOT NULL, completed INTEGER NOT NULL, expires_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL,
     busy_until INTEGER NOT NULL, flow TEXT NOT NULL
   )`,
];

/** A toolkit's OAuth app. */
export interface OAuthApp {
  readonly toolkitId: string;
  readonly clientId: string;
  readonly clientSecret: string | undefined;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly scopes: ReadonlyArray<string>;
  /** The authorization server's issuer, which a sign-in's answer must name (RFC 9207); undefined: not checked. */
  readonly issuer: string | undefined;
  /**
   * An OAuth 1.0a consumer's temporary credential request URL (#206): the app signs in with OAuth 1.0a then, its
   * `authorizeUrl` the resource owner authorization URL and its `tokenUrl` the token request URL.
   */
  readonly requestTokenUrl?: string | undefined;
  readonly updatedAt: number;
  readonly updatedBy: string;
}

/** A client dynamic registration gave Commissary. */
export interface RegisteredOAuthClient {
  readonly toolkitId: string;
  readonly issuer: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly clientSecret: string | undefined;
  readonly auth: ClientAuth;
}

export type { ClientVia };

/** What an OAuth 2 sign-in needs at its callback. */
export interface OAuth2SignInFlow {
  /** Absent in a flow kept before OAuth 1.0a sign-ins (#206). */
  readonly kind?: "oauth2";
  readonly verifier: string;
  readonly redirectUri: string;
  readonly via: ClientVia;
  readonly clientId: string;
  readonly tokenEndpoint: string;
  readonly auth: ClientAuth;
  /** The authorization server's issuer, which an `iss` in the callback must name (RFC 9207). */
  readonly issuer: string | undefined;
  /** The authorization server names itself in its answer: an answer without `iss` is refused. */
  readonly issRequired: boolean;
  /** The resource the sign-in names (RFC 8707). */
  readonly resource: string | undefined;
  /** The dynamic registration made for this sign-in, kept for the toolkit once it completes. */
  readonly registered?: RegisteredOAuthClient | undefined;
  /** Who started it, as the credential's `connected_by` names them. */
  readonly by: string;
  /** A shared credential's subject, whose grant connecting it writes. */
  readonly subject: GrantSubject | undefined;
}

/**
 * An OAuth 1.0a sign-in's flow (#206): the consumer (the toolkit's OAuth app) and its token request URL, and the
 * temporary credentials, which the callback's `oauth_token` must name and which sign the token request.
 */
export interface OAuth1SignInFlow {
  readonly kind: "oauth1";
  readonly consumerKey: string;
  readonly tokenRequestUrl: string;
  readonly token: string;
  readonly tokenSecret: string;
  readonly by: string;
  readonly subject: GrantSubject | undefined;
}

export type SignInFlow = OAuth2SignInFlow | OAuth1SignInFlow;

export interface SignInSession {
  readonly state: string;
  readonly toolkitId: string;
  /** The member of a private credential; undefined for the shared one. */
  readonly owner: string | undefined;
  /** The member who started it; empty for a caller without a member. */
  readonly startedBy: string;
  /** Why it failed; empty while it waits or once it completed. */
  readonly status: string;
  readonly completed: boolean;
  readonly expiresAt: number;
  readonly deadlineAt: number;
  readonly busyUntil: number;
  /** Empty once the session ended. */
  readonly flow: SignInFlow | undefined;
}

interface AppRow {
  [column: string]: SqlStorageValue;
  toolkit_id: string;
  client_id: string;
  secret: string;
  authorize_url: string;
  token_url: string;
  scopes: string;
  issuer: string;
  updated_at: number;
  updated_by: string;
  request_token_url: string | null;
}

interface ClientRow {
  [column: string]: SqlStorageValue;
  toolkit_id: string;
  issuer: string;
  redirect_uri: string;
  client_id: string;
  secret: string;
  auth: string;
}

interface SessionRow {
  [column: string]: SqlStorageValue;
  state: string;
  toolkit_id: string;
  owner: string;
  started_by: string;
  status: string;
  completed: number;
  expires_at: number;
  deadline_at: number;
  busy_until: number;
  flow: string;
}

const appContext = (toolkitId: string): string => `toolkit_oauth_apps/${toolkitId}`;

const clientContext = (toolkitId: string): string => `toolkit_oauth_clients/${toolkitId}`;

const flowContext = (state: string): string => `toolkit_sign_ins/${state}`;

export class OAuthStore {
  readonly #sql: SqlStorage;
  readonly #secrets: Sealer;

  constructor(sql: SqlStorage, secrets: Sealer) {
    this.#sql = sql;
    this.#secrets = secrets;

    for (const statement of SCHEMA) sql.exec(statement);

    // OAuth 1.0a apps (#206) came later: an app from before is an OAuth 2 one.
    const appColumns = sql
      .exec<{ name: string }>("PRAGMA table_info(toolkit_oauth_apps)")
      .toArray()
      .map((column) => column.name);

    if (!appColumns.includes("request_token_url"))
      sql.exec(`ALTER TABLE toolkit_oauth_apps ADD COLUMN request_token_url TEXT`);
  }

  #open(sealed: string, context: string): string | undefined {
    return sealed === "" ? undefined : this.#secrets.open(sealed, context);
  }

  #seal(value: string | undefined, context: string): string {
    return value === undefined || value === "" ? "" : this.#secrets.seal(value, context);
  }

  // --- OAuth apps -------------------------------------------------------------------------------------------------

  app(toolkitId: string): OAuthApp | undefined {
    const row = this.#sql
      .exec<AppRow>(`SELECT * FROM toolkit_oauth_apps WHERE toolkit_id = ?`, toolkitId)
      .toArray()[0];

    return row === undefined
      ? undefined
      : {
          toolkitId: row.toolkit_id,
          clientId: row.client_id,
          clientSecret: this.#open(row.secret, appContext(row.toolkit_id)),
          authorizeUrl: row.authorize_url,
          tokenUrl: row.token_url,
          // SAFETY: the column holds the JSON array of strings this store wrote.
          scopes: JSON.parse(row.scopes) as ReadonlyArray<string>,
          issuer: row.issuer === "" ? undefined : row.issuer,
          requestTokenUrl: row.request_token_url ?? undefined,
          updatedAt: row.updated_at,
          updatedBy: row.updated_by,
        };
  }

  putApp(app: OAuthApp): void {
    this.#sql.exec(
      `INSERT OR REPLACE INTO toolkit_oauth_apps
         (toolkit_id, client_id, secret, authorize_url, token_url, scopes, issuer, updated_at, updated_by,
          request_token_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      app.toolkitId,
      app.clientId,
      this.#seal(app.clientSecret, appContext(app.toolkitId)),
      app.authorizeUrl,
      app.tokenUrl,
      JSON.stringify(app.scopes),
      app.issuer ?? "",
      app.updatedAt,
      app.updatedBy,
      app.requestTokenUrl ?? null,
    );
  }

  deleteApp(toolkitId: string): boolean {
    return (
      this.#sql.exec(`DELETE FROM toolkit_oauth_apps WHERE toolkit_id = ?`, toolkitId).rowsWritten >
      0
    );
  }

  // --- dynamic registrations --------------------------------------------------------------------------------------

  client(toolkitId: string): RegisteredOAuthClient | undefined {
    const row = this.#sql
      .exec<ClientRow>(`SELECT * FROM toolkit_oauth_clients WHERE toolkit_id = ?`, toolkitId)
      .toArray()[0];

    return row === undefined
      ? undefined
      : {
          toolkitId: row.toolkit_id,
          issuer: row.issuer,
          redirectUri: row.redirect_uri,
          clientId: row.client_id,
          clientSecret: this.#open(row.secret, clientContext(row.toolkit_id)),
          // SAFETY: the store writes `auth` from a `ClientAuth`.
          auth: row.auth as ClientAuth,
        };
  }

  putClient(client: RegisteredOAuthClient, now: number): void {
    this.#sql.exec(
      `INSERT OR REPLACE INTO toolkit_oauth_clients
         (toolkit_id, issuer, redirect_uri, client_id, secret, auth, registered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      client.toolkitId,
      client.issuer,
      client.redirectUri,
      client.clientId,
      this.#seal(client.clientSecret, clientContext(client.toolkitId)),
      client.auth,
      now,
    );
  }

  // --- sign-ins ---------------------------------------------------------------------------------------------------

  #purge(now: number): void {
    this.#sql.exec(`DELETE FROM toolkit_sign_ins WHERE expires_at <= ?`, now);
  }

  #put(session: SignInSession): void {
    this.#sql.exec(
      `INSERT OR REPLACE INTO toolkit_sign_ins
         (state, toolkit_id, owner, started_by, status, completed, expires_at, deadline_at, busy_until, flow)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      session.state,
      session.toolkitId,
      session.owner ?? "",
      session.startedBy,
      session.status,
      session.completed ? 1 : 0,
      session.expiresAt,
      session.deadlineAt,
      session.busyUntil,
      session.flow === undefined
        ? ""
        : this.#secrets.seal(JSON.stringify(session.flow), flowContext(session.state)),
    );
  }

  #flowOf(sealed: string, state: string): SignInFlow {
    // SAFETY: the column holds the sealed JSON of the `SignInFlow` this store wrote.
    return JSON.parse(this.#secrets.open(sealed, flowContext(state))) as SignInFlow;
  }

  /** A sign-in that has not expired at `now`. */
  session(state: string, now: number): SignInSession | undefined {
    this.#purge(now);

    const row = this.#sql
      .exec<SessionRow>(`SELECT * FROM toolkit_sign_ins WHERE state = ?`, state)
      .toArray()[0];

    return row === undefined
      ? undefined
      : {
          state: row.state,
          toolkitId: row.toolkit_id,
          owner: row.owner === "" ? undefined : row.owner,
          startedBy: row.started_by,
          status: row.status,
          completed: row.completed === 1,
          expiresAt: row.expires_at,
          deadlineAt: row.deadline_at,
          busyUntil: row.busy_until,
          flow: row.flow === "" ? undefined : this.#flowOf(row.flow, row.state),
        };
  }

  /** Starts a sign-in, pending until its callback. */
  start(
    session: Pick<SignInSession, "state" | "toolkitId" | "owner" | "startedBy"> & {
      readonly flow: SignInFlow;
    },
    now: number,
  ): SignInSession {
    this.#purge(now);

    const started: SignInSession = {
      ...session,
      status: "",
      completed: false,
      expiresAt: now + SESSION_TTL_MS,
      deadlineAt: now + CALLBACK_WINDOW_MS,
      busyUntil: 0,
    };

    this.#put(started);

    return started;
  }

  /**
   * Takes a pending sign-in for its one exchange: the state is single-use, so a session already taken (in flight, done
   * or failed), past its callback window or unknown answers `undefined`. A sign-in past its window fails.
   */
  take(state: string, now: number): SignInSession | undefined {
    const session = this.session(state, now);

    if (
      session === undefined ||
      session.completed ||
      session.status !== "" ||
      session.busyUntil > now ||
      session.flow === undefined
    )
      return undefined;

    if (now > session.deadlineAt) {
      this.fail(state, "the sign-in took too long: start it again", now);

      return undefined;
    }

    this.#put({ ...session, busyUntil: now + BUSY_LEASE_MS });

    return session;
  }

  /** Ends a sign-in as failed (its flow wiped); kept {@link SESSION_TTL_MS} for its starter to read why. */
  fail(state: string, message: string, now: number): void {
    const session = this.session(state, now);

    if (session === undefined || session.completed) return;

    this.#put({
      ...session,
      status: message,
      expiresAt: now + SESSION_TTL_MS,
      busyUntil: 0,
      flow: undefined,
    });
  }

  /** Ends a sign-in as completed (its flow wiped). */
  complete(state: string, now: number): void {
    const session = this.session(state, now);

    if (session === undefined || session.completed) return;

    this.#put({
      ...session,
      status: "",
      completed: true,
      expiresAt: now + COMPLETED_TTL_MS,
      busyUntil: 0,
      flow: undefined,
    });
  }

  /** Forgets the sign-ins `member` started or would hold (they left the org). */
  deleteMember(member: string): void {
    this.#sql.exec(
      `DELETE FROM toolkit_sign_ins WHERE owner = ? OR started_by = ?`,
      member,
      member,
    );
  }
}
