# Cloud credentials: which provider credentials a hosted multi-tenant org may connect

Research for the Commissary Cloud credential decision. Follows `docs/research/provider-terms.md` (on branch `origin/research/provider-terms`, researched 2026-10-15), which is not repeated here except where a point needed re-checking. Researched 2026-10-19. Sources are the providers' own legal, help, and docs pages, with the URL and the date shown on the page. Where a page showed no date, or I could not read the page, that is said. This is research, not legal advice.

Scope: Commissary Cloud holds an org's provider credential and routes several members' requests through it. "Hosted multi-tenant" below means exactly that: a third-party operator (Commissary) holds the credential and serves more than one person.

## Summary

| Credential kind | Allowed on a hosted multi-tenant service? | Key quote (source, date) |
|---|---|---|
| Anthropic consumer plan (Pro/Max, Claude Code OAuth) relayed by a hosted gateway | **No** | AUP, effective 2026-11-12: "Resell, proxy, or otherwise provide access to Claude through unauthorized means, including services that route requests through consumer subscriptions or misrepresent the product or client being used" |
| Anthropic API key (Claude Console, or a supported cloud provider) | **Yes** (the sanctioned route for products) | Claude Code legal page, undated: developers "building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider" |
| OpenAI ChatGPT plan usage via "Sign in with ChatGPT" (Go/Plus/Pro) | **No, unless OpenAI approves the app** (waitlist; no self-serve path for hosted apps) | Developer cookbook, "Usage policy and terms": "If you're building a paid or remotely hosted app, join the waitlist to request access before offering it to users." (undated) |
| Codex ChatGPT login or access token relayed by a gateway | **No** for a third-party hosted service. **Unclear** for an org-run gateway on an Enterprise workspace (documented by OpenAI, Codex clients only) | Codex auth docs, undated: "Access tokens are intended for trusted scripts, schedulers, and private CI runners." Gateway doc: "Your gateway can see request data and both credentials." |
| OpenCode Go key (monthly subscription, sold as an API key) | **No** | Terms of Use, effective 2026-08-15: "You will only use the Services for your own internal use, and not on behalf of or for the benefit of any third party." Go docs: "Go and Go Plus are for workspaces with a single member ... A workspace with a Go subscription cannot invite members." |
| OpenCode Zen key (pay-as-you-go balance) | **Unclear, leaning no** | Same Terms clause as above. Zen team sharing exists for an org's own members (Zen docs); nothing addresses a third-party operator holding the key. |
| Kimi Code membership key (Kimi Code Console) | **No** (inferred from the guidelines; no page names hosted gateways) | Kimi Code Community Guidelines, undated: "Don't resell Kimi Code's capabilities as a service"; "Don't use Kimi Code for non-interactive automation"; "Sharing your account with others through a reverse proxy is a violation." |
| Kimi Open Platform API key (pay-as-you-go, platform.kimi.ai / api.moonshot.ai) | **Unclear** | Open Platform Terms, last updated 2026-07-30: may offer "Customer Applications" to "End Users" (§1), but may not "buy, sell, or transfer API keys from, to or with a third party" (§3.4(9)). |
| Google Vertex AI service-account key, in the customer's own GCP project and billing | **Unclear, leaning yes** (not prohibited; not addressed) | Google Cloud Terms, undated page: "Customer ... is responsible for ... the security of its passwords for the Account (including any keys for Google APIs) and for any use of its Account" (§1.3(a)). |

Not repeated here (see `provider-terms.md`): xAI, Meta, Devin, Google consumer subscriptions, and the team-plan seat-sharing questions.

**Cross-provider risk for the current repo.** Three providers' terms prohibit misrepresenting the client, and the repo's cloaking does exactly that: Anthropic's AUP ("misrepresent the product or client being used"), Kimi ("Don't spoof or alter client identity information"), and OpenCode Go's guidance ("Identify itself with its own user agent ... rather than a generic SDK"). See "Repo findings" below.

---

## 1. Anthropic Usage Policy, effective 2026-11-12

**Sources.** Usage Policy, "Effective November 12, 2026" (https://www.anthropic.com/legal/aup; the policy was published with the news post of 2026-10-08, https://www.anthropic.com/news/2026-usage-policy-update, which I could not fully re-read; the PDF copy at https://www-cdn.anthropic.com/files/4zrzovbb/website/6ae2f5bb8675bcd9fac006125817ba1393b396e4.pdf is labelled as a reference copy).

**The clause.** Under "Do Not Abuse Our Platform" (the section lists prohibitions under "This includes using our products or services to:"):

> "Resell, proxy, or otherwise provide access to Claude through unauthorized means, including services that route requests through consumer subscriptions or misrepresent the product or client being used"

Related clauses in the same policy:

- "Intentionally bypass or interfere with capabilities, restrictions, or guardrails established within our products ... without prior authorization from Anthropic" (same section).
- "Engage in actions or behaviors that circumvent the guardrails or terms of other platforms or services" (under "Do Not Engage in Fraudulent, Abusive, or Predatory Practices").
- "Circumvent a ban through the use of a different account ... or providing access to a person or entity that was previously banned" (same section as the first clause).
- "Agentic use cases must comply with the Usage Policy. Users are responsible for ensuring that agents they build or deploy, including actions those agents take through tools, browsers, or connected systems, comply with this Usage Policy."

**Who it binds.** The scope paragraph reads: the policy "applies to anyone who submits inputs to Anthropic's products or services, all of whom we refer to as 'users.' This includes individuals using our apps (such as Claude.ai and Claude Code), developers and businesses using our API and developer platforms, customers accessing Claude through cloud providers and authorized resellers, and the end users of products or services integrating Claude." So:

- **The operator** (a developer or business routing requests through its own service) is bound as a "developer or business using our API".
- **The subscriber** whose consumer plan is used is bound as an individual using Claude.ai or Claude Code.
- The clause itself is framed as conduct ("using our products or services to ... route requests through consumer subscriptions"), so it does not single out one party. Enforcement is against the account: "we may warn you or throttle, limit, suspend, or terminate your access."

**What the README paraphrase drops.** README lines 132-137 say the AUP "prohibits services that route requests through consumer subscriptions or misrepresent the client." The operative words are "through unauthorized means". The policy does not define "unauthorized", and the Claude Code legal page (below) describes sanctioned routes: an end user signing in to the unmodified Claude Code binary with their own subscription, and API-key or cloud-provider routes. A paraphrase should keep "unauthorized means" or cite the clause.

**Subscription sign-in for products, for context** (Claude Code legal page, https://code.claude.com/docs/en/legal-and-compliance, undated; quoted in `provider-terms.md`, re-read today): "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens." The same page says: "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code."

**Unresolved.** Anthropic's support page "Use the Claude Agent SDK with your Claude plan" (https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan; per `provider-terms.md`, "Update October 7, 2026") says "you can still use ... third-party apps with your subscription limits". That conflicts with the legal page. I did not reconcile them.

**Not confirmed.** Whether the "misrepresent" clause text changed from the previous version (the policy page links "Previous Version"; I did not open it).

---

## 2. OpenCode Zen and OpenCode Go

**Sources.**
- Terms of Use, "Effective date: Aug 15, 2026" (https://opencode.ai/legal/terms-of-service). It covers "OpenCode's website, inference product and hosted software offering" and applies to Zen and Go.
- Go docs (https://opencode.ai/docs/go/, page undated; the Go page on opencode.ai/go and the console pages say the same prices).
- Zen docs (https://opencode.ai/docs/zen/, page undated; its "For teams" section describes team features).

**Clauses that decide it.** Terms of Use, "What are the basics of using OpenCode?":

> "You will only use the Services for your own internal use, and not on behalf of or for the benefit of any third party, and only in a manner that complies with all laws that apply to you."

Terms of Use, "What about Third Party Models?": "Your ability to access Third Party Models is contingent on you having API keys or otherwise having the right to access such Third Party Models."

Terms of Use, "Are there restrictions in how I can use the Services?" (the list includes): "creates, maintains, or uses accounts in bulk, or creates, maintains, or uses multiple accounts to circumvent usage limits, access restrictions, billing obligations ... or any other restriction or policy applicable to the Services" and "automatically or programmatically extracts data or Output". A violation "is grounds for termination", and "OpenCode has the sole right to decide whether you are in violation".

I found no separate clause that says "do not resell" in the Terms text I read. The "own internal use ... not on behalf of ... any third party" clause does that work.

**Go-specific terms (docs, not the Terms).**
- "Go and Go Plus are for workspaces with a single member, such as the Personal workspace created when you sign up. A workspace with a Go subscription cannot invite members."
- "OpenCode Go is designed for OpenCode and other coding agents that produce similar types of requests. Traffic is monitored for abuse that degrades the experience for other users."
- Clients "should ... Identify itself with its own user agent, such as `my-coding-agent/1.0`, rather than a generic SDK or HTTP-library name", and send "a stable session ID in `x-opencode-session`".
- Plans: Go $10/month, Go Plus $40/month; monthly dollar limits per model, with 5-hour, weekly and monthly windows.

**Zen-specific.** Zen is pay-as-you-go. Its docs say "You are charged per request and can add credits to your account", and that owners and admins "can invite members, choose which models are enabled ..., set budgets, and connect their own providers". So Zen has an internal team feature. The docs say nothing about a third party operating a gateway on a customer's key.

**Answers.**
- **Go key on a hosted multi-tenant gateway: No.** Two independent reasons: the Terms bar use "on behalf of or for the benefit of any third party"; and a Go workspace cannot have members, so several people sharing one Go key is outside the product as sold.
- **Zen key: Unclear, leaning no.** The same clause applies. An org's own members sharing a Zen team workspace is a documented feature; an operator serving other orgs through the key is a third party. Not stated either way.
- A **private** key (one member's key, used only by that member through Cloud) is still "on behalf of ... a third party" in the sense that Commissary serves the member. Not stated either way; I read it as the same answer.

**Repo finding.** Commit `c426a9cc` (2026-10-19, "cloak OpenCode Zen free models as OpenCode") makes Commissary's Zen requests present as OpenCode's own client: "a User-Agent with an OpenCode client token", an "OpenCode-format `ses_` session id derived per conversation", and "a stub `read` tool". The Go docs ask a client to identify itself with its own user agent. That is the opposite of the Go guidance, and not in a clause I could quote as a breach. It should be reviewed before any hosted use.

**Not confirmed.** Any Go-specific or Zen-specific terms beyond the Terms of Use and the docs pages; any written view from OpenCode on a hosted relay (the Terms say contact help@anoma.ly).

---

## 3. OpenAI: "Using your ChatGPT plan in other apps and sites" and "Sign in with ChatGPT"

**Sources.**
- Help Center, "Using your ChatGPT plan in other apps and sites" (https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites). The page showed "Updated: 12 days ago" when fetched on 2026-10-19, so roughly 2026-10-07.
- Help Center, "Sign in with ChatGPT" (https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt).
- Partner directory (https://learn.chatgpt.com/docs/sign-in-with-chatgpt), undated.
- Developer quickstart (https://developers.openai.com/siwc/quickstart.md), undated.
- Developer docs, "Request a client ID" (https://developers.openai.com/siwc/request-client-id.md), undated.
- Developer cookbook (https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt), undated.

**What the user gets.** "If you have a Go, Plus, or Pro plan, you can also choose to use your ChatGPT plan for AI requests in participating commercial apps and sites that support this feature." Limits: "You can set a weekly usage limit for each app"; credit use is "off by default"; "The app may charge separately for its subscription, infrastructure, services, or premium features." "Availability also depends on the app's own plan requirements. Supported open-source tools remain available to all ChatGPT users."

**How an app becomes "participating".** This is a gated program, not a self-serve one:

- Developer request-client-id page: "Sign in with ChatGPT is currently offered to a select group of commercial partners. To join the waitlist, complete the Sign in with ChatGPT interest form" (https://openai.com/form/sign-in-with-chatgpt-interest/; the form itself was not opened).
- Quickstart: "Sign in with ChatGPT is currently available to selected commercial partners through a limited trial. ChatGPT plan usage is available to all open-source partners and selected private clients." It also refers to "Apps approved for ChatGPT plan usage".
- Cookbook, "Usage policy and terms": "The ChatGPT plan usage integration described here is available for open-source tools and personal projects that run locally. If you're building a paid or remotely hosted app, join the waitlist to request access before offering it to users."
- Help Center, for commercial partners: "If you're a commercial partner interested in integrating Sign in with ChatGPT, with or without token sharing, please complete this interest form."

**Who is on the list today.** The partner directory (learn.chatgpt.com) lists 12 "Apps with ChatGPT plan usage" (including hosted products such as Vercel, Notion, Devin, Kilo Code and Warp) and 5 "sign-in only" apps. It lists four "Open-source integrations": OpenClaw, OpenCode, Pi and T3. So hosted commercial apps can be approved; approval is the gate. Requirements and fees for approval are not published on the pages I read. The Help Center refers to "the published requirements" for eligibility but I did not find them.

**Could Commissary qualify?**
- **Commissary Cloud (paid, remotely hosted, multi-tenant): not on the self-serve path.** The cookbook sends a paid or remotely hosted app to the waitlist, so it would need OpenAI's approval. Whether OpenAI would approve a gateway is not stated.
- **A self-hosted Commissary run by the same org:** the cookbook's "open-source tools and personal projects that run locally" could fit, but no page says whether an org-run self-hosted gateway counts. Unclear.

**Is Codex (ChatGPT-login) access part of it?**
- The Help Center says plan usage counts "toward the ChatGPT Work and Codex usage included in your plan". Codex usage is inside the same plan pool.
- OpenAI documents one gateway pattern that carries a ChatGPT token: "Sign in with ChatGPT through a gateway" (https://learn.chatgpt.com/docs/enterprise/sign-in-with-chatgpt-through-a-gateway, undated). It is for "an organization-provided model gateway" used with Codex. The gateway receives `Authorization: Bearer <ChatGPT token>` and forwards it to `https://chatgpt.com/backend-api/codex`, and the doc warns: "Your gateway can see request data and both credentials." The page is for the org's own gateway, and it does not address a third-party vendor operating one.
- Codex access tokens (ChatGPT Enterprise, admin-granted): "Access tokens are intended for trusted scripts, schedulers, and private CI runners" (https://developers.openai.com/codex/auth, undated).
- Codex in CI: "The right way to authenticate automation is with an API key" (prior research, `provider-terms.md`, citing https://developers.openai.com/codex/auth/ci-cd-auth/; not re-read today).

**Verdict for Commissary Cloud.** No today. A hosted third party relaying ChatGPT plan usage or Codex tokens is not on any documented path. The only route is OpenAI's waitlist, and the gateway pattern above is for an org's own gateway.

**Not confirmed.** The approval criteria; any fee schedule for partners; the interest form's content; the "published requirements" the Help Center mentions.

---

## 4. Vertex AI service-account keys and Google Cloud terms

**Sources.**
- Google Cloud Platform Terms of Service (https://cloud.google.com/terms), undated page (the page refers to a February 2026 renumbering in the Service Specific Terms).
- Service Specific Terms (https://cloud.google.com/terms/service-terms), undated; it states that "as of February 18, 2026" section numbers moved.
- IAM, "Service account credentials" (https://docs.cloud.google.com/iam/docs/service-account-creds), undated.
- IAM, "Best practices for managing service account keys" (https://docs.cloud.google.com/iam/docs/best-practices-for-managing-service-account-keys), undated.
- Google Cloud blog, "How to authenticate service accounts to help keep applications secure" (https://cloud.google.com/blog/products/identity-security/how-to-authenticate-service-accounts-to-help-keep-applications-secure), published 2021-04-28.

**Clauses.**
- §1.3(a): "Customer must have an Account to use the Services and is responsible for the information it provides to create the Account, the security of its passwords for the Account (including any keys for Google APIs) and for any use of its Account."
- §3.1: "Customer will (a) ensure that Customer and its End Users' use of the Services complies with this Agreement ..."
- Definitions: "End Users" are "the individuals who are permitted by Customer to use the Services ... End Users may include employees of Customer Affiliates and other authorized third parties."
- §1.1: Customer "may use the Services, and integrate the GCP Services ... into any Customer Application that has material value independent of the Services". "Customer Application" means "a software program that Customer creates or hosts using the GCP Services".
- §3.3(c): Customer will not "sell, resell, sublicense, transfer, or distribute any or all of the Services".
- Google's key guidance (2021 blog, dated): "In situations where other authentication approaches are not viable (and only in those situations), create a service account key for the application." The IAM page: "Always store your service account keys in a secure location."

**Analysis.**
- The Terms do not say a third party may hold a customer's service-account key, and do not say it may not. The customer owns the account, the key and the bill, and is responsible for "any use of its Account" (§1.3(a)).
- A hosted service calling Vertex with the customer's own key, in the customer's own project and billing, is therefore not expressly prohibited. Whether it is permitted depends on whether the customer authorises the operator as its agent and remains responsible under §1.3(a) and §3.1.
- If the operator marks up or resells Vertex usage, §3.3(c) is the clause that applies. Not confirmed whether a pass-through with no markup is "resell".
- Google's own guidance prefers workload identity over keys. A design that avoids custody of a long-lived key (for example, Google's workload identity or impersonation, which the 2021 blog names as alternatives) is outside these terms and is a design choice, not a provider permission.

**Not confirmed.**
- The Generative AI Additional Terms (https://cloud.google.com/terms/generative-ai-additional-terms) and the Generative AI Prohibited Use Policy (https://cloud.google.com/terms/generative-ai-prohibited-use-policy). My fetch returned no usable body, so I did not check them for a clause on third-party access.
- The Acceptable Use Policy (https://cloud.google.com/terms/aup), not read in full.
- Whether the Gemini Enterprise Agent Platform (Vertex) service terms add a rule on third-party custody of credentials.

---

## 5. Kimi: kimi.com vs kimi.ai, Kimi Code membership vs Open Platform

**Sources.**
- Kimi Code FAQ, "Distinguish Platforms" table (https://www.kimi.ai/help/kimi-code/faq), undated.
- Kimi Code Overview (https://www.kimi.ai/help/kimi-code/membership-guide), undated.
- Kimi Code membership benefits (https://www.kimi.com/code/docs/en/kimi-code/membership), undated; it says "All logged-in devices and API Keys share the same quota".
- Kimi API troubleshooting (https://www.kimi.ai/help/kimi-api/api-troubleshooting), undated.
- Kimi Code Community Guidelines (https://www.kimi.com/en/help/kimi-code/community-guidelines), undated.
- Kimi Open Platform Terms of Service, "Last Updated: July 30th, 2026" (https://platform.kimi.ai/docs/agreement/modeluse).
- Kimi consumer Terms of Service, "Effective Date: January 5, 2024" (https://www.kimi.com/user/agreement/en/modelUse). Counterparty: "Beijing Moonshot Technology Co., Ltd"; PRC law.

**The distinction, as the pages state it.**

| Product | Endpoint (per the Kimi Code FAQ) | Billing | Key source | Counterparty and governing terms |
|---|---|---|---|---|
| Kimi Code membership, China | `https://api.kimi.com/coding/` (Anthropic) and `/coding/v1` (OpenAI) | Membership subscription | Kimi Code Console | Community Guidelines. Whether the Kimi consumer Terms (Beijing Moonshot, PRC law) also apply to Kimi Code is not stated. |
| Kimi Code membership, overseas | `https://api.kimi.ai/coding/` and `/coding/v1` | Membership subscription | Kimi Code Console | Community Guidelines |
| Kimi Open Platform, China | `https://api.moonshot.cn/v1` | Pay-as-you-go | Open Platform console | Open Platform Terms (Moonshot AI PTE. LTD., Singapore) |
| Kimi Open Platform, overseas | `https://api.moonshot.ai/v1` (platform.kimi.ai) | Pay-as-you-go | platform.kimi.ai console | Open Platform Terms (Moonshot AI PTE. LTD., Singapore; SIAC arbitration) |

- Keys, balances and benefits are not interchangeable across these: "The Kimi API Open Platform, Kimi Code, and Kimi Membership are independent products ... their API keys are not interchangeable" (API troubleshooting). A key from the wrong product returns 401 or 404.
- "For users outside mainland China, use platform.kimi.ai" (API troubleshooting).
- **Inferred, not stated:** that kimi.com is the mainland-China surface and kimi.ai the overseas one. The pages label endpoints "China" and "Overseas", and the membership pricing is in ¥ on the kimi.com pages. I did not find a page that says so in those words.

**Which terms govern a hosted gateway.**

- **Kimi Code membership key.** The Community Guidelines say: "Kimi Code subscriptions are for interactive use only" and the compatible tools are "Kimi CLI, VS Code, Claude Code, OpenCode, OpenClaw, etc." Relevant bars:
  - "Don't resell your account or API access."
  - "Don't resell Kimi Code's capabilities as a service ... Repackaging it as a product to sell to others bypasses our pricing and service structure."
  - "Don't use Kimi Code for non-interactive automation."
  - "Accessing Kimi through a forward proxy (like a VPN or company network) is fine. Sharing your account with others through a reverse proxy is a violation."
  - "For enterprise integrations, commercial services, or other platform-related inquiries, visit the Kimi Platform."
  - Consequence: review, then action "such as limiting concurrent access". Separately, if the subscription was bought "through unauthorized channels (such as resold accounts or third-party sellers)", the account "may be suspended upon verification".
  - **Answer: No.** No page names a hosted gateway, but a multi-tenant relay fits the resell and reverse-proxy language. The Kimi Code Overview says subscribers "can also obtain an API Key to integrate Kimi Code's model capabilities into third-party development tools and platforms", which is the only text that points the other way; it does not override the guidelines.
- **Kimi consumer Terms (kimi.com, 2024-01-05).** "you may only use Kimi in a non-commercial, personal research, and study manner"; "if you use Kimi to provide any services to any third parties, the corresponding rights, obligations, and responsibilities are borne by you". Older than the guidelines; it applies to the consumer chat product.
- **Open Platform key.** §1: the license lets you integrate the Services "into your own applications, products, or Services ... and to offer those Customer Applications to End Users." §1 also: "You must not share your account credentials or make your account accessible to others, including not transferring, lending, leasing, or providing it to anyone for use in any form without authorization." §3.4(9): "buy, sell, or transfer API keys from, to or with a third party." §3.2(6): no "sub-licensing or re-licensing of the Services ... without authorization."
  - **Answer: Unclear.** The org may offer a Customer Application to its own End Users. Handing the key to a hosted operator is "providing it to anyone ... without authorization" unless authorised, and it may be a transfer "with a third party". Written authorisation from Moonshot would settle it.

**Not confirmed.**
- The kimi.ai consumer terms (search failed during the research; not read).
- The "Extra Usage Agreement" (https://www.kimi.com/user/agreement/extra-usage-rules-cn), mentioned by the membership page, not read.
- Whether the Community Guidelines apply identically to kimi.ai and kimi.com (the page shows no date).
- Any written statement from Moonshot on hosted relays.

---

## Repo findings

1. **README is accurate in substance but drops "unauthorized means"** (README lines 133-137). It also says cloaking "misrepresents the client, so using it is at your own risk". On Commissary Cloud, Commissary would be the party cloaking, so the AUP's "misrepresent the product or client being used" clause would fall on the operator, not only on the subscriber. Not legal advice; this is a plain reading of the clause.
2. **OpenCode Zen cloaking (commit `c426a9cc`, 2026-10-19)** presents requests as OpenCode's own client. The Go docs ask clients to identify themselves with their own user agent. The Zen free-model access it works around is described in the commit as "403 FreeTierError otherwise" (the commit's own words, not a provider statement).
3. **Kimi cloaking.** If Commissary's Kimi path changes the client identity, the Kimi Code Community Guidelines' "Don't spoof or alter client identity information" applies. The Kimi Code Overview also says: "Tampering with the client identifier (User-Agent) is considered a violation and may result in suspension of membership benefits."
4. **Shared Anthropic subscriptions** are covered by the AUP "through unauthorized means" clause, the Claude Code legal page, and the consumer terms (per `provider-terms.md`). A per-member private subscription relayed by a hosted service is the same clause.

## Gaps I could not close

- **Anthropic:** the diff against the previous Usage Policy; the support-page vs legal-page conflict on third-party apps; whether Anthropic's commercial terms say anything about an operator holding a customer's API key (expected to be allowed, not checked).
- **OpenAI:** partner approval criteria and fees (the interest form was not opened); whether an org-run self-hosted gateway counts as an "open-source tool"; the Services Agreement text (only quoted from `provider-terms.md`, not re-read).
- **Google:** the Generative AI Additional Terms and Prohibited Use Policy (no usable body returned); the AUP; whether markup counts as resale under §3.3(c).
- **OpenCode:** any Go- or Zen-specific terms beyond the Terms of Use and docs; any written view on a hosted relay.
- **Kimi:** the kimi.ai consumer terms (search tool rate-limited); whether kimi.com and kimi.ai have separate terms for the membership product; the Extra Usage Agreement; written view on hosted relays.
- **Not re-verified in this pass:** xAI, Meta, Devin and Google consumer subscriptions (see `provider-terms.md`).
- Terms change often. Re-check each page before any launch decision. This is research, not legal advice.
