# @commissary/store

## 0.2.0

### Minor Changes

- [#87](https://github.com/spiritledsoftware/commissary/pull/87) [`4f26a21`](https://github.com/spiritledsoftware/commissary/commit/4f26a21365a654df5c25a3556be10376f9d8c9aa) Thanks [@ian-pascoe](https://github.com/ian-pascoe)! - Bind PostgreSQL Drizzle definitions to host-owned databases with Collection, direct SQL, and verified serializable transaction capabilities.

  Allow Core Thread Stores to compose over either plain or transactional Store backends, preserving serialized one-attempt behavior for plain Stores and bounded conflict retries for Transaction Stores.

- [#71](https://github.com/spiritledsoftware/commissary/pull/71) [`2d16d50`](https://github.com/spiritledsoftware/commissary/commit/2d16d50c770bb1016e33ae5534790b157ea33817) Thanks [@ian-pascoe](https://github.com/ian-pascoe)! - # Record composition and normalized Store values

  Add immutable Record definitions, explicit contributions and overrides, and Select-normalized Memory Store writes.

- [#72](https://github.com/spiritledsoftware/commissary/pull/72) [`3594a68`](https://github.com/spiritledsoftware/commissary/commit/3594a686cb9ba45b0a161fb3a2b0afa3e64486ae) Thanks [@ian-pascoe](https://github.com/ian-pascoe)! - # Portable SQL Record definitions

  Add immutable portable SQL Record metadata, type and literal helpers, Select Schema reflection, validation, and adapter-facing resolution contracts.

- [#80](https://github.com/spiritledsoftware/commissary/pull/80) [`8afad5a`](https://github.com/spiritledsoftware/commissary/commit/8afad5a4271a26f383b72569290e064285b583ca) Thanks [@ian-pascoe](https://github.com/ian-pascoe)! - Add SQLite Record metadata helpers and the synchronous adapter-facing Record resolver with immutable physical assets and codecs.

- [#78](https://github.com/spiritledsoftware/commissary/pull/78) [`bd249e1`](https://github.com/spiritledsoftware/commissary/commit/bd249e178e42ee0756539cc68ebf9400d070f370) Thanks [@ian-pascoe](https://github.com/ian-pascoe)! - Add PostgreSQL Record metadata helpers and the synchronous adapter-facing Record resolver with immutable physical assets and codecs.

- [#77](https://github.com/spiritledsoftware/commissary/pull/77) [`89fa5c4`](https://github.com/spiritledsoftware/commissary/commit/89fa5c47ebf1658de2feb64496ef2c5ad24d66ae) Thanks [@ian-pascoe](https://github.com/ian-pascoe)! - Add the portable SQL Store runtime under SQL-specific package entrypoints, shared SQL conformance suites, and the adapter transaction callback runner. Strengthen Store write-state errors and Memory Store transaction boundaries.

- [#79](https://github.com/spiritledsoftware/commissary/pull/79) [`9484564`](https://github.com/spiritledsoftware/commissary/commit/948456423ea9dbff45aa4ed0911eb89742836450) Thanks [@ian-pascoe](https://github.com/ian-pascoe)! - Add MySQL Record metadata helpers and the synchronous adapter-facing Record resolver with immutable physical assets and codecs.

- [#73](https://github.com/spiritledsoftware/commissary/pull/73) [`764b292`](https://github.com/spiritledsoftware/commissary/commit/764b2927c3406ca2d581dcf6865fdc900de50ab8) Thanks [@ian-pascoe](https://github.com/ian-pascoe)! - # Parameter-safe SQL Statements

  Add immutable SQL Statement composition helpers and the adapter-facing Statement compiler with exact segments, ordered parameter conversion, and structured failures.

### Patch Changes

- [#84](https://github.com/spiritledsoftware/commissary/pull/84) [`4d3ce8c`](https://github.com/spiritledsoftware/commissary/commit/4d3ce8c0d8993ec5cb2a663b4e60344e053dcb3b) Thanks [@ian-pascoe](https://github.com/ian-pascoe)! - Preserve literal PostgreSQL enum schema and name types so higher-tier integrations can infer exact definition schema keys.

## 0.1.1

### Patch Changes

- [#34](https://github.com/spiritledsoftware/commissary/pull/34) [`fa20e91`](https://github.com/spiritledsoftware/commissary/commit/fa20e91a0180821d7cba10c91d3f5342106c20f5) Thanks [@ian-pascoe](https://github.com/ian-pascoe)! - Update dependencies

## 0.1.0

### Minor Changes

- [#28](https://github.com/spiritledsoftware/commissary/pull/28) [`abff236`](https://github.com/spiritledsoftware/commissary/commit/abff2365a387446f9b4fe2119cd8aed70d7f4be9) Thanks [@ian-pascoe](https://github.com/ian-pascoe)! - Add typed generic Store primitives, adapter-owned transactions, host Record extensions, and the Core-owned Thread Store integration.
