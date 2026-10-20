// Vite's `import.meta.glob` (transformed at build time by vitest); declared here instead of pulling in `vite/client`
// types for the whole project.
interface ImportMeta {
  glob<T>(
    pattern: string,
    options: { readonly query: string; readonly import: string; readonly eager: true },
  ): Record<string, T>;
}
