/**
 * The hosted agents' Durable Object classes, retired (ADR 0048): `AgentRun`, one object per agent run, and
 * `AgentSchedule`, one per schedule trigger. Cloudflare refuses to delete a class another Worker still binds
 * (`tombstone_delete_blocked_by_external_bindings`), and the app Worker that bound them is deployed after this one, so
 * this release keeps both classes, and their bindings in alchemy.run.ts, as tombstones. A tombstone answers nothing:
 * its alarm and any call it receives delete its alarm and all its storage, so each object an earlier release left
 * behind empties itself the next time it is reached. A follow-up release removes the classes and the two bindings
 * (Alchemy then emits `deleted_classes`).
 */
import { DurableObject } from "cloudflare:workers";

/**
 * An object of a retired class: forgets its alarm and everything it stored as soon as the runtime constructs it, which
 * any call it receives (its alarm, a request, an RPC call) does, before the call is answered.
 */
abstract class RetiredObject extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      await ctx.storage.deleteAlarm();
      await ctx.storage.deleteAll();
    });
  }

  /** The alarm an earlier release set fires once more at most; the constructor has emptied the object by then. */
  override alarm(): void {}

  override fetch(_request: Request): Response {
    return new Response("retired", { status: 410 });
  }
}

/** The retired agent run object. */
export class AgentRun extends RetiredObject {}

/** The retired schedule trigger object. */
export class AgentSchedule extends RetiredObject {}
