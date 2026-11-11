/**
 * `Platform` Durable Object: the Platform registry (ADR 0021), one object per deployment (`platformOf`, registry.ts).
 * It holds what spans orgs: the list of orgs, an index of which orgs each person and each Access service token belong to
 * (the orgs' ControlPlanes stay authoritative for membership), and deployment-wide named leases (`lease.ts`:
 * the model catalog refresh takes one, so one refresh of the shared catalog runs at a time). It stays out of the
 * request path for clients, which name their org with their API key. New in the Workers port.
 *
 * The platform admins are not stored here: the deployment's variables name them, so they can always repair this
 * registry. Methods are exposed to the Worker through JS RPC and exchange plain data only.
 */
import { DurableObject } from "cloudflare:workers";
import type { IndexRepair, OrgIndex, SsoDomainRecord, Standing } from "@commissary/auth";
import type { StateObjectEnv } from "../env.ts";
import { type LeaseSource, LeaseStore, type TakeLease } from "../lease.ts";
import {
  type OrgInput,
  type OrgPatch,
  type OrgRecord,
  type OrgRemoval,
  type OrgWriteResult,
  type PersonPatch,
  type PersonRecord,
  PlatformStore,
  type SignInState,
  type SsoDomainClaim,
} from "./registry-store.ts";

export class Platform extends DurableObject<StateObjectEnv> {
  readonly #store: PlatformStore;
  readonly #leases: LeaseStore;

  constructor(ctx: DurableObjectState, env: StateObjectEnv) {
    super(ctx, env);
    this.#store = new PlatformStore(ctx.storage.sql);
    this.#leases = new LeaseStore(ctx.storage.sql, () => Date.now());
  }

  /** Every org: the seeded `global` first, then oldest first. */
  listOrgs(): ReadonlyArray<OrgRecord> {
    return this.#store.listOrgs();
  }

  getOrgBySlug(slug: string): OrgRecord | undefined {
    return this.#store.orgBySlug(slug);
  }

  getOrgById(id: string): OrgRecord | undefined {
    return this.#store.orgById(id);
  }

  /** `now` is the caller's clock (Effect `Clock`, so tests control it). */
  createOrg(input: OrgInput, now: number = Date.now()): OrgWriteResult {
    return this.#store.createOrg(input, now);
  }

  /** Renames the org addressed by `slug` (its name, its slug, or both). */
  updateOrg(slug: string, patch: OrgPatch): OrgWriteResult {
    return this.#store.updateOrg(slug, patch);
  }

  /** Sets (or, with `null`, clears) how many days the org's usage records are kept (ADR 0027). */
  setUsageRetention(id: string, days: number | null): OrgWriteResult {
    return this.#store.setUsageRetention(id, days);
  }

  /** Deletes the org and its index rows at once; `global` is refused (ADR 0027). */
  deleteOrg(id: string): OrgRemoval {
    return this.#store.deleteOrg(id);
  }

  /** Deletes a person's index rows in every org; answers how many orgs listed them. */
  removePerson(email: string): number {
    return this.#store.removePerson(email);
  }

  orgsOfEmail(email: string): ReadonlyArray<OrgRecord> {
    return this.#store.orgsOfEmail(email);
  }

  orgOfServiceToken(clientId: string): OrgRecord | undefined {
    return this.#store.orgOfServiceToken(clientId);
  }

  /** Rebuilds one org's membership index from the lists its ControlPlane holds. */
  replaceOrgIndex(org: string, index: OrgIndex): IndexRepair {
    return this.#store.replaceOrgIndex(org, index);
  }

  // --- people of Commissary Cloud (ADR 0026, the Worker's sign-in) ---------------------------------------------------

  /** A person signed in: suspended, signed up, or due the Personal org created for them here. `now`: epoch ms. */
  signIn(email: string, now: number): SignInState {
    return this.#store.signIn(email, now);
  }

  /** The person owns their Personal org (or was invited): they are signed up. */
  finishSignUp(email: string, now: number): void {
    this.#store.finishSignUp(email, now);
  }

  /** `defaultLimit`: the deployment's owned-org limit (`OWNED_ORG_LIMIT`). */
  person(email: string, defaultLimit: number): PersonRecord {
    return this.#store.person(email, defaultLimit);
  }

  updatePerson(email: string, patch: PersonPatch, now: number, defaultLimit: number): PersonRecord {
    return this.#store.updatePerson(email, patch, now, defaultLimit);
  }

  setOrgSuspended(slug: string, suspended: boolean, now: number): OrgWriteResult {
    return this.#store.setOrgSuspended(slug, suspended, now);
  }

  standing(org: string, email?: string): Standing {
    return this.#store.standing(org, email);
  }

  emailsOfOrg(org: string): ReadonlyArray<string> {
    return this.#store.emailsOfOrg(org);
  }

  // --- single sign-on domains of Commissary Cloud (issue #76, `sso/store.ts`) ----------------------------------------

  /** Gives a verified email domain (lowercased) to `org`; refused while another org holds it. */
  claimSsoDomain(domain: string, org: string): SsoDomainClaim {
    return this.#store.claimSsoDomain(domain, org);
  }

  releaseSsoDomain(domain: string, org: string): void {
    this.#store.releaseSsoDomain(domain, org);
  }

  setSsoDomainRequired(domain: string, org: string, required: boolean): boolean {
    return this.#store.setSsoDomainRequired(domain, org, required);
  }

  ssoDomainsOf(org: string): ReadonlyArray<string> {
    return this.#store.ssoDomainsOf(org);
  }

  ssoDomain(domain: string): SsoDomainRecord | undefined {
    return this.#store.ssoDomain(domain);
  }

  // --- deployment-wide leases (`lease.ts`) ---------------------------------------------------------------------------

  /** Takes the lease `name` at this object's own time; refused while a live holder has it. */
  takeLease(name: string, source: LeaseSource): TakeLease {
    return this.#leases.take(name, source);
  }

  /** Gives back the lease taken with `token` (a lease taken over meanwhile is left alone). */
  releaseLease(token: string): void {
    this.#leases.release(token);
  }
}
