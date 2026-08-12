# @commissary/drizzle

## 0.2.0

### Minor Changes

- [#87](https://github.com/spiritledsoftware/commissary/pull/87) [`4f26a21`](https://github.com/spiritledsoftware/commissary/commit/4f26a21365a654df5c25a3556be10376f9d8c9aa) Thanks [@ian-pascoe](https://github.com/ian-pascoe)! - Bind PostgreSQL Drizzle definitions to host-owned databases with Collection, direct SQL, and verified serializable transaction capabilities.

  Allow Core Thread Stores to compose over either plain or transactional Store backends, preserving serialized one-attempt behavior for plain Stores and bounded conflict retries for Transaction Stores.

- [#85](https://github.com/spiritledsoftware/commissary/pull/85) [`2324e85`](https://github.com/spiritledsoftware/commissary/commit/2324e85533e5402fabce8b098c4147043fff0b10) Thanks [@ian-pascoe](https://github.com/ian-pascoe)! - Add connection-free PostgreSQL, MySQL, and SQLite Store definition factories.

### Patch Changes

- Updated dependencies [[`6d2223c`](https://github.com/spiritledsoftware/commissary/commit/6d2223cc44bfe0fb57cf9047a1742729f0985386), [`4f26a21`](https://github.com/spiritledsoftware/commissary/commit/4f26a21365a654df5c25a3556be10376f9d8c9aa), [`2d16d50`](https://github.com/spiritledsoftware/commissary/commit/2d16d50c770bb1016e33ae5534790b157ea33817), [`3594a68`](https://github.com/spiritledsoftware/commissary/commit/3594a686cb9ba45b0a161fb3a2b0afa3e64486ae), [`8afad5a`](https://github.com/spiritledsoftware/commissary/commit/8afad5a4271a26f383b72569290e064285b583ca), [`bd249e1`](https://github.com/spiritledsoftware/commissary/commit/bd249e178e42ee0756539cc68ebf9400d070f370), [`09aa5e1`](https://github.com/spiritledsoftware/commissary/commit/09aa5e1b3e0037b575887491179486f2fe01991f), [`89fa5c4`](https://github.com/spiritledsoftware/commissary/commit/89fa5c47ebf1658de2feb64496ef2c5ad24d66ae), [`4d3ce8c`](https://github.com/spiritledsoftware/commissary/commit/4d3ce8c0d8993ec5cb2a663b4e60344e053dcb3b), [`9484564`](https://github.com/spiritledsoftware/commissary/commit/948456423ea9dbff45aa4ed0911eb89742836450), [`764b292`](https://github.com/spiritledsoftware/commissary/commit/764b2927c3406ca2d581dcf6865fdc900de50ab8)]:
  - @commissary/core@0.3.0
  - @commissary/store@0.2.0
