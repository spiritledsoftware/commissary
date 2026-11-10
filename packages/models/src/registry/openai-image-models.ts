/**
 * The OpenAI `gpt-image-*` model ids served over the Codex Images API.
 *
 * Go source: sdk/api/handlers/openai/openai_images_handlers.go (`isCodexImagesToolModel`),
 * sdk/api/handlers/handlers_routing.go (`isOpenAIImageOnlyModel`), internal/client/codex/models/models.go
 * (`isCodexClientImageOrVideoModel`), internal/runtime/executor/codex_openai_images.go (`codexIsDirectOpenAIImageModel`).
 * One list feeds the handlers, the executor and the client catalog.
 */
export const OPENAI_IMAGE_MODEL_IDS: ReadonlyArray<string> = [
  "gpt-image-1.5",
  "gpt-image-2",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5",
  "gpt-image-2.6-flare",
  "gpt-image-2.6-sunburst",
  "gpt-image-2.6",
];
