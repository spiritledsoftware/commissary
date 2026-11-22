---
status: partly superseded by ADR-0025, amended by ADR-0052
---

# What the port leaves out, and how it treats the Go server's keys

The proxy does not port these features:

- plugins and the Home mode;
- the TUI, mDNS and pprof;
- git, Postgres and object-store backends;
- request-log files;
- outbound proxies and TLS fingerprinting;
- Codex live/realtime;
- the AI Studio relay;
- the deprecated v0 management API.

Config keys the proxy cannot honour are handled in one of two ways:

- keys that only make sense for a process on a host are dropped on import;
- keys a Go document commonly sets are kept as not-applied keys, so the document imports and round-trips unchanged; they are named on the Settings page and have no other effect.

The control panel shows only what takes effect on this deployment.
