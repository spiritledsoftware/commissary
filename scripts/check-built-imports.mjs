const specifiers = [
  "@commissary/core",
  "@commissary/core/internal",
  "@commissary/store-memory",
  "@commissary/effect",
  "@commissary/effect/ai",
  "@commissary/stream",
  "@commissary/stream/effect",
];

for (const specifier of specifiers) {
  const module = await import(specifier);
  if (Object.keys(module).length === 0) {
    throw new Error(`Built package '${specifier}' has no exports`);
  }
}

console.log(`imports:${specifiers.length}`);
