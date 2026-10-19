---
status: accepted
---

# Sandboxes are a built-in toolkit, and sandboxes and browsers come from pluggable providers

A hosted agent needs somewhere to run commands and keep files. Rather than give the Agents area a workspace of its own, Tools gains a second built-in toolkit beside the browser toolkit (ADR 0039): the **sandbox toolkit**. Like the browser, it runs on Cloudflare by default. Unlike the browser, other services can stand behind the same tools later, and the browser toolkit gets the same arrangement.

## The sandbox toolkit

- **Tools.** Along the lines of `sandbox_open`, `sandbox_bash`, `sandbox_read`, `sandbox_write`, `sandbox_edit` and `sandbox_close`. MCP calls are stateless, so opening returns a **sandbox session** id, and the other tools take it, as with browser sessions.
- **Who uses it.** Clients use it as well as hosted agents, under the gates every toolkit has (ADR 0038): grants, tool scope, tool class, prices, approval rules and usage records.
- **Hosted agents.** A hosted agent's definition may name a sandbox toolkit. Its run then opens one sandbox session, and pi's bash and file tools are routed to it.
- **Lifecycle.**
  - A run's sandbox session lives as long as the run, and its files follow the retention of agent runs (ADR 0040).
  - A client's sandbox session belongs to the member and API key that opened it. It and its files are deleted when it is closed, or after a fixed idle limit of about a day. A sandbox is not file storage, which is outside v1.

## Cloudflare's sandbox: just-bash, then the computer

The built-in sandbox runs on `@cloudflare/computer`. Its Workspace is a filesystem in one Durable Object's SQLite, with two ways to run a command: just-bash, a shell interpreter, and the **computer**, a Cloudflare Container that works on the same files.

- **just-bash first.** Every command runs on just-bash first. It is cheap and starts at once, but has no npm, git or Python.
- **Fallback.** When just-bash cannot run a command at all (a command it lacks, or syntax it does not support), the sandbox runs the command again on the computer. A command that ran on just-bash and failed is not run again, since its side effects may already have happened. The package offers no fallback of its own, so this is Commissary's code.
- **"May use the computer"** is a setting, off by default because the computer costs money. With it off, an unsupported command returns just-bash's error.
- **The computer's lifecycle.** It starts at the first fallback and stops after ten idle minutes. The files stay in the Workspace, so the next fallback starts a fresh computer with the same files. Each deployment fixes one instance size in v1.
- **Network.** None by default. It may be widened to a list of allowed hosts (with a "package registries" preset: npm, PyPI, GitHub) or to the open internet, and the setting covers both just-bash and the computer. A sandbox with a network and tool results that may carry prompt injection is a way to leak data, so it is off unless someone turns it on.
- **Credentials never enter a sandbox.** A run reaches other services only through tools, and v1 has no secret environment variables.
- **Who sets what.** The toolkit carries the org's ceiling: whether the computer is allowed, and the widest network allowed. A hosted agent's definition, or a client's `sandbox_open`, chooses within it. For a private agent, its member chooses.
- **Cost.** Usage records carry computer seconds. An org admin may set a price per computer hour, which counts toward the dollar spend limits. A deployment setting caps concurrent computers per org. just-bash's small cost is part of the run and is not priced.
- **Requirements.** The computer is present only when the deployment has a container binding, as the browser toolkit needs a `browser` binding. Without one, "may use the computer" cannot be turned on. Workers Paid is needed in either case.

## Sandbox and browser providers

A **sandbox provider** is the service behind a sandbox toolkit, and a **browser provider** is the service behind a browser toolkit. Commissary reaches each one through its own adapter behind one interface:

- for sandboxes: open, run a command, files, network policy and close;
- for browsers: the session and Quick Action tools of ADR 0039.

So every provider gives the same tools and session model, and a hosted agent can name any of them.

- **v1 builds one provider of each:** Cloudflare's sandbox (above) and Browser Run. Their credential is the deployment's own binding, of kind `none`, reached under grants.
- **Later providers** (Daytona, E2B, Modal or Vercel Sandbox for sandboxes; Browserbase or Kernel for browsers) each arrive as a new adapter plus a toolkit catalog entry. An org connects one with its own key for that service, as the toolkit's shared credential, or a member does with a private one.
- **Their own MCP servers still work.** A service's MCP server can still be added from the toolkit catalog as an ordinary toolkit with its own tools (ADR 0036, ADR 0039). That route needs no adapter, but a hosted agent's bash and file tools cannot be routed through it.
- **just-bash, then the computer, is Cloudflare's own arrangement.** Another sandbox provider runs every command on its own machine.

"Provider" on its own still means a model provider. A sandbox or browser provider is always named in full.

## Considered Options

- **A workspace inside the Agents area.** Only hosted agents could use it, and it would repeat Tools' gating, prices and records.
- **Two tools, `bash` and `computer_bash`, with the model picking.** Models would pick the computer for its comfort and run up its cost. Or they would retry on just-bash in a loop.
- **Other sandboxes only as catalog toolkits.** It is the least code, but every service has its own tool names and session model, and a hosted agent's tools could not be routed to them.
- **Calling the services "hosts" or "backends".** `@cloudflare/computer` already calls just-bash and the container its backends, and "provider" says what the service is: one that provides sandboxes or browsers.

## Consequences

- ADR 0039 is amended: Browser Run becomes the first browser provider of the browser toolkit, rather than its only possible one.
- `@cloudflare/computer` is a preview ("not suitable for production"), and its just-bash backend runs in a Dynamic Worker. Commissary pins exact versions behind its own adapter.
- A self-hosted Commissary on Workers Free has no Agents area and no sandbox that runs commands. That joins the self-hosted parity question.
