---
status: accepted
---

# Commissary Cloud has two plans: Free and Pay as you go

Commissary Cloud charges for its own platform and never for model access: orgs bring their own provider keys and accounts (ADR 0034) and pay providers directly, so there is no resale and no markup on tokens. Each org holds one **plan**, Free or Pay as you go, the way Upstash prices: no monthly fee, the same **free usage** every month on either plan, and Pay as you go billed per unit above it. There are no seats: every plan has unlimited members. Plans exist only on Commissary Cloud; a self-hosted Commissary has no plans, limits or billing.

## What a plan counts

Three units, counted per org per calendar month in UTC:

| Unit                                                      | Free usage | Pay as you go, above free usage |
| --------------------------------------------------------- | ---------- | ------------------------------- |
| Requests and tool calls, counted together                 | 25,000     | $0.50 per 100,000               |
| Browser hours (the browser toolkit, ADR 0039)             | 1          | $0.15 per hour                  |
| Computer hours (the sandbox toolkit's computer, ADR 0041) | 0          | $0.15 per hour                  |

- A request or tool call counts once, whatever served it: any client or agent run, a shared or a private credential, success or failure. Failover does not count again, since attempts are not counted.
- What is refused before any work (authentication, a spend limit, a plan limit) does not count.
- An agent run has no unit of its own (ADR 0040): its requests, tool calls and computer time are counted. just-bash sandbox time is not counted.
- With no computer hours on Free, the computer needs Pay as you go. Every other feature is on both plans: Tools, the browser toolkit, Agents, shared agents, spend limits, teams.

The rates sit above Cloudflare's cost (about $1.50 per million requests including the usage row, $0.09 per browser hour, about $0.07 per small computer hour) because, with no base fee, they carry all the margin.

## Plan limits

- **Free usage on Free.** A unit used up refuses further use of it with `429 plan_limit_reached` and `Retry-After` until the month resets; work in flight finishes.
- **Billing cap on Pay as you go.** What Commissary Cloud may bill an org in a month, default $50, which org owners raise or remove. Reaching it refuses use the same way. Polar has no customer spending cap, so Commissary enforces it.
- **Ceilings for fairness between orgs**, which ADR 0039 and ADR 0040 left to plans. A platform admin may raise them for one org; agent runs stay uncapped.

  | Ceiling                     | Free        | Pay as you go |
  | --------------------------- | ----------- | ------------- |
  | Concurrent browser sessions | 1           | 5             |
  | Concurrent computers        | 0           | 3             |
  | Request rate                | 60 a minute | 600 a minute  |

Plans and spend limits stay apart. A spend limit caps what an org's own traffic costs at provider and admin-set prices; a plan decides what Commissary Cloud bills. Neither counts toward the other.

## Billing

- **Polar is the merchant of record.** It files sales tax and VAT, handles disputes, and hosts the customer portal (invoices, receipts, payment method, tax ID). Billing sits behind a small adapter so Stripe direct remains possible.
- **Each org is a Polar customer.** Its billing email is the owner who first added a card. Usage goes to Polar as batched meter events and is invoiced monthly in arrears.
- **No minimum charge.** Polar carries invoices under 50¢ forward to the next one; Polar's fixed fee on a $1–$3 invoice is accepted.
- **Org owners only** switch plans, change the payment method and set the billing cap. Every org admin sees the plan, the month's usage against free usage, and invoices.
- **Upgrading** takes effect at once.
- **A failed payment** puts the org under Free's limits as soon as Polar marks the subscription past due. It keeps Pay as you go, flagged, and its limits return when a payment succeeds. When Polar revokes the subscription after its last retry, the org moves to Free.
- **Switching to Free** takes effect at once, and the open month's usage is still invoiced. Nothing is deleted or suspended for non-payment.
- **Deleting an org** cancels its subscription after sending the open month's usage; deletion does not wait for payment.
- **Notices.** Commissary sends no billing email. The panel tells owners and admins at 80% and 100% of free usage on Free and of the billing cap on Pay as you go, and when a payment fails. A `plan_limit_reached` refusal names the limit and links to the billing page. Polar sends invoices, receipts and failed-payment emails.
- **Unbilled orgs.** A platform admin may mark any org unbilled: Pay as you go with no card and no invoice, for the operator's own orgs, design partners and support credit.
- **At launch** every existing Cloud org starts on Free, and nothing from before is billed.

The owned-org limit stays as it is and bounds how much free usage one person can collect.

## Considered Options

- **A paid plan with a monthly fee, allowances and overage** (a $20 Pro, as Composio and Portkey price). It forces a tier break before usage shows where one belongs, and a fee for orgs that use little.
- **Prepaid credits** (OpenRouter). One fee per top-up, but a balance to hold and refund, and Polar's fixed fee hurts small top-ups.
- **Seats.** Commissary serves programs more than people, and ADR 0026 already declined to make each member a cost.
- **Reselling model access** with Cloud's own provider keys. It would add provider contracts, credit balances and margin risk.
- **Stripe direct with Stripe Tax.** The cheapest percentage and the most flexible metering, but Commissary would register, file and handle disputes itself. Stripe Managed Payments' usage billing is unconfirmed and Paddle's meters are in beta; Polar's meters are documented.
- **Free usage only on Free**, as Upstash does. Keeping it on Pay as you go means adding a card never costs more than staying on Free.

## Consequences

- ADR 0039, 0040 and 0041 dropped every default cap and left fairness to Commissary Cloud's plans; the ceilings above are those plans' answer, and none applies to a self-hosted Commissary.
- Whether Polar accepts a $0 fixed price beside metered prices is unconfirmed; a product with only metered prices is the fallback. Polar files meter events into the period it receives them, so a late batch lands in the next invoice.
- Commissary sending its own email (billing notices among others) joins the launch work.
