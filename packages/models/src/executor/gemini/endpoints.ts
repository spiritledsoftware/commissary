/**
 * The Gemini and Vertex default base URLs, a leaf module so the management views can read them without loading the
 * executors' targets (whose variants hold the session-state replay ledgers).
 *
 * Go source: internal/runtime/executor/gemini_executor.go (glEndpoint), internal/runtime/executor/gemini_vertex_executor.go (vertexAPIKeyModelsURL's default base).
 */
export const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com";

export const VERTEX_DEFAULT_BASE_URL = "https://aiplatform.googleapis.com";
