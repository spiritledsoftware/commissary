// The ways to connect an account (packages/models/src/management/oauth-routes.ts, packages/models/src/oauth/service.ts): sign-in
// flows that end with a pasted address (the provider only redirects to localhost), sign-in flows with a device code,
// the Vertex service-account import and auth-file upload. Pure: no DOM, tested in test/connect.test.ts.
import type { OAuthProvider } from "@commissary/contract/oauth";

export type ConnectMethod =
  | {
      readonly kind: "sign-in";
      readonly provider: OAuthProvider;
      /** "paste": the operator pastes the address the provider redirected to; "code": a device code. */
      readonly flow: "paste" | "code";
      /** Codex offers both: a device code instead of the pasted address. */
      readonly codeAlternative?: boolean;
    }
  | { readonly kind: "vertex" }
  | { readonly kind: "file" };

export interface ConnectOption {
  readonly id: string;
  readonly name: string;
  /** One sentence: what the operator does. */
  readonly how: string;
  /**
   * What the provider's terms say about use through a gateway or hosted service, shown with the steps (ADR 0034: a
   * warning, never a block). Quotes come from docs/research/provider-terms.md and docs/research/cloud-credentials.md.
   */
  readonly notice?: string;
  readonly method: ConnectMethod;
}

/** Both Kimi sign-ins connect a Kimi Code membership, under the same Community Guidelines. */
const KIMI_NOTICE =
  'Kimi Code\'s Community Guidelines say "Kimi Code subscriptions are for interactive use only" and "Don\'t resell Kimi Code\'s capabilities as a service", and call sharing an account through a reverse proxy a violation. They do not mention a hosted gateway, so you use it at your own risk.';

export const CONNECT_OPTIONS: ReadonlyArray<ConnectOption> = [
  {
    id: "claude",
    name: "Claude",
    how: "Sign in at claude.ai, then paste the address your browser lands on.",
    notice:
      'Anthropic\'s Usage Policy (from 12 November 2026) bars using Claude to "resell, proxy, or otherwise provide access to Claude through unauthorized means, including services that route requests through consumer subscriptions or misrepresent the product or client being used". Cloaking, which a subscription needs, misrepresents the client, so you use it at your own risk: keep a subscription as your private account, and for anything shared add a Claude provider key.',
    method: { kind: "sign-in", provider: "claude", flow: "paste" },
  },
  {
    id: "codex",
    name: "Codex",
    how: "Sign in with your ChatGPT account, then paste the address or enter a code.",
    notice:
      'OpenAI offers ChatGPT plan use in other apps through its own program, and for a paid or remotely hosted app its guide says "join the waitlist to request access before offering it to users". OpenAI documents no way for a hosted service to relay a ChatGPT login, so you use it at your own risk.',
    method: { kind: "sign-in", provider: "codex", flow: "paste", codeAlternative: true },
  },
  {
    id: "xai",
    name: "xAI",
    how: "Enter a code on x.ai.",
    notice:
      'xAI endorses SuperGrok sign-in in OpenCode, an open-source client, but its Acceptable Use Policy bars "Accessing the Services through unauthorized automated or non-human means, whether through a bot, script, or otherwise", and nothing xAI publishes addresses a hosted service. You use it at your own risk.',
    method: { kind: "sign-in", provider: "xai", flow: "code" },
  },
  {
    id: "antigravity",
    name: "Antigravity",
    how: "Sign in with Google, then paste the address your browser lands on.",
    notice:
      'Google\'s Antigravity terms say "Using third party software, tools, or services to access the Service" is a breach of the agreement and may be grounds for suspending or terminating your Antigravity or Gemini CLI accounts. You use it at your own risk.',
    method: { kind: "sign-in", provider: "antigravity", flow: "paste" },
  },
  {
    id: "devin",
    name: "Devin",
    how: "Sign in at app.devin.ai, then paste the address your browser lands on.",
    notice:
      'Cognition limits Devin to "internal business purposes only, solely for use by you and your Authorized Users", and its Acceptable Use Policy says "users must not provide other users with access to their account or their account credentials". It documents no way to relay an account through another service, so you use it at your own risk.',
    method: { kind: "sign-in", provider: "devin", flow: "paste" },
  },
  {
    id: "meta",
    name: "Meta",
    how: "Enter a code on meta.com.",
    notice:
      'Meta\'s Model API terms bar providing access to the Services to any third party "through any model aggregator, API gateway, proxy, or similar offering" without Meta\'s written authorization, and a Coding Harness Subscription credential "may not be used to access the Services outside the coding harness". You use it at your own risk.',
    method: { kind: "sign-in", provider: "meta", flow: "code" },
  },
  {
    id: "kimi",
    name: "Kimi (kimi.com)",
    how: "Enter a code on kimi.com.",
    notice: KIMI_NOTICE,
    method: { kind: "sign-in", provider: "kimi", flow: "code" },
  },
  {
    id: "kimi-ai",
    name: "Kimi (kimi.ai)",
    how: "Enter a code on kimi.ai.",
    notice: KIMI_NOTICE,
    method: { kind: "sign-in", provider: "kimi-ai", flow: "code" },
  },
  {
    id: "vertex",
    name: "Vertex AI",
    how: "Import a Google Cloud service-account key.",
    method: { kind: "vertex" },
  },
  {
    id: "file",
    name: "Auth file",
    how: "Upload credential files saved by CLIProxyAPI.",
    notice:
      "An auth file usually carries an account like those above; most of those providers' terms bar or don't address use through a gateway or hosted service. Check the terms of the file's provider: you use it at your own risk.",
    method: { kind: "file" },
  },
];

/**
 * The sharing notice (ADR 0034): shown when an account is connected as a shared credential, owned by the org and used
 * through grants. Provider terms (docs/research/provider-terms.md): every one that addresses sharing forbids it;
 * ADR 0034 says most providers do.
 */
export const SHARED_ACCOUNT_NOTICE =
  "Providers' terms forbid sharing a subscription. A shared account belongs to the org and members use it through grants, so your org uses it at its own risk. Connect it as a private account to keep it to your own requests.";

/**
 * What to show beside an option's steps: its provider's terms notice, then the sharing notice when the account is
 * connected as a shared credential. Vertex service-account keys are no subscription, so they show neither. Notices
 * inform; nothing here gates the connect flow.
 */
export const connectNotices = (option: ConnectOption, shared: boolean): ReadonlyArray<string> => [
  ...(option.notice === undefined ? [] : [option.notice]),
  ...(shared && option.method.kind !== "vertex" ? [SHARED_ACCOUNT_NOTICE] : []),
];

/** The host a sign-in link goes to ("claude.ai"), shown on its button so the operator knows where they land. */
export const linkHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export type PastedAddress =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly problem: string };

/**
 * Checks the address the operator pasted: a whole URL whose query carries the provider's answer (`code`, or `error`
 * when they declined). Nothing is sent until it is.
 */
export const readPastedAddress = (raw: string): PastedAddress => {
  const text = raw.trim();

  if (text === "") return { ok: false, problem: "Paste the address from your browser first." };

  let url: URL;

  try {
    url = new URL(text);
  } catch {
    return {
      ok: false,
      problem:
        "That is not a whole address. Copy everything in the address bar, starting with http.",
    };
  }

  if (!url.searchParams.has("code") && !url.searchParams.has("error")) {
    return {
      ok: false,
      problem:
        "This address has no sign-in answer in it. Paste the address of the page the provider sent you to after you approved.",
    };
  }

  return { ok: true, url: text };
};

/** Auth files are JSON; larger than this is not a credential. */
export const MAX_AUTH_FILE_BYTES = 10 * 1024 * 1024;

/** A file's name as an auth-file name: its base name, which must end in `.json`. */
export const authFileName = (fileName: string): string | undefined => {
  const base = fileName.split(/[\\/]/).at(-1) ?? "";

  return /\.json$/i.test(base) && base.length > 5 ? base : undefined;
};
