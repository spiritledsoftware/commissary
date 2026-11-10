/**
 * Thinking signatures: provider detection and validation, the cache Antigravity's "cache mode" reads, and the store
 * interface its persistence goes through. Port of internal/signature and internal/cache.
 */
export { bytesToBinaryString } from "./base64.ts";

export {
  cacheSignature,
  DEFAULT_SIGNATURE_SCOPE,
  getCachedSignature,
  isolateSignatureCache,
  MemorySignatureCache,
  SIGNATURE_CACHE_TTL_MS,
  type SignatureCache,
  type SignatureSettings,
  type SignatureWrite,
  signatureBypassStrictMode,
  signatureCacheEnabled,
  signatureStoreKey,
  withSignatureContext,
} from "./cache.ts";

export {
  CODEX_COMMENTARY_SIGNATURE_MARKER,
  isCodexCommentarySignatureMarker,
  restoreCodexCommentaryMarkers,
  sanitizeClaudeMessagesForClaudeUpstream,
} from "./claude-messages.ts";

export { isValidGptReasoningSignature } from "./gpt.ts";

export { isValidGrokEncryptedContent } from "./grok.ts";

export {
  detectSignatureProvider,
  type SignatureProvider,
  signatureProviderFromModelName,
} from "./provider.ts";

export {
  flushSignatureWrites,
  makeMemorySignatureStore,
  prefetchSignatures,
  type SignatureStore,
} from "./store.ts";
