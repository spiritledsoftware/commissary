// Vite's `?raw` imports (a file's text, transformed by vitest in Node.js and workerd alike): the OpenAPI fixtures
// (test/fixtures/openapi). Declared here instead of pulling in `vite/client` types for the whole project.
declare module "*?raw" {
  const text: string;
  export default text;
}
