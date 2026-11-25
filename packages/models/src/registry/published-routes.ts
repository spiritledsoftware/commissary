/**
 * Published routes: the providers whose catalog models register as `<provider>/<native id>`, that qualified id being
 * the route's source (`ModelInfo.sourceModelId`).
 *
 * Go source: sdk/cliproxy/service_models.go (`applyModelNamespace`, `setCopilotModelDisplayName`),
 * sdk/cliproxy/auth/conductor_models.go (`usesPublishedModelRoutes`), f89d408e.
 */

interface PublishedProviderSpec {
  /** The namespace of the provider's published ids (Go `copilot.ModelPrefix`). */
  readonly prefix: string;
  /** Appended to each published model's display name, if any. */
  readonly displaySuffix?: string;
}

export const PUBLISHED_PROVIDERS = {
  copilot: { prefix: "copilot/", displaySuffix: " (Copilot)" },
  devin: { prefix: "devin/" },
} as const satisfies Record<string, PublishedProviderSpec>;

export type PublishedProvider = keyof typeof PUBLISHED_PROVIDERS;

const isPublishedProvider = (provider: string): provider is PublishedProvider =>
  Object.hasOwn(PUBLISHED_PROVIDERS, provider);

/** `provider` (trimmed, lower-cased) when its models publish under `<provider>/`, else `undefined`. */
export const publishedProvider = (provider: string): PublishedProvider | undefined => {
  const key = provider.trim().toLowerCase();

  return isPublishedProvider(key) ? key : undefined;
};

/** `id` without the provider's namespace (compared case-insensitively); other ids are returned as they are. */
export const stripPublishedPrefix = (provider: PublishedProvider, id: string): string => {
  const { prefix } = PUBLISHED_PROVIDERS[provider];

  return id.toLowerCase().startsWith(prefix) ? id.slice(prefix.length) : id;
};

/** The native id of a published route's source (`copilot/gpt-6-sol` -> `gpt-6-sol`); other ids as they are. */
export const sourceNativeId = (source: string): string => {
  const slash = source.indexOf("/");
  const provider = slash === -1 ? undefined : publishedProvider(source.slice(0, slash));

  return provider === undefined ? source : stripPublishedPrefix(provider, source);
};
