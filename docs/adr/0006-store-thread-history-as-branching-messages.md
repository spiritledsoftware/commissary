# Store Thread history as branching Messages

## Message tree

The Thread Store keeps a parent-linked tree of immutable Message Entries. Each Message Entry contains one canonical Model Message.

Run, Execution Claim, Tool Call Graph, suspension, and result records stay outside the Message tree. Delegated Tool Calls and child results also stay outside it. Only the parent Tool result becomes model-visible history.

## Branches

Each Branch has a stable opaque ID, a mutable Thread-local name, and a head Message Entry ID. A Branch can fork from any existing Message Entry without copying its ancestors.

Core allocates Message Entry IDs. The Thread Store checks the expected Branch head and derives parent links from append order. It advances the head in the same atomic operation.

Each append uses a commit ID. The commit ID makes a retry safe when the first append result is unknown.

## Read interface

The required Thread Store interface supports Thread and Branch creation, Branch rename, one-Branch path reads, and atomic append. Full-tree navigation and pagination belong to an optional inspection adapter.

`readBranchHistory` returns the committed Branch path from oldest to newest. Each item contains its stable ID, parent ID, and canonical Model Message.

[ADR 0004](0004-pass-dependencies-through-factories-and-closures.md) defines the safe Commissary Instance methods for this interface.
