# Store versioned Data with core Messages

`MessageData.define` accepts a namespaced key, a version, and a Codec. It infers the domain type and returns typed attach, decode, and collect helpers.

Core appends Message Data atomically with its Model Message. The Thread Store keeps the encoded value without interpretation. Render receives the value unchanged.

Model Request construction adds each Message Data item after that Message's Content Parts. It uses stored order and deterministic JSON with the key, version, and value.

Core does not hide recognized data or rebuild derived values. It does not interpret version compatibility. Optional upcasters remain local helper functions.

Message Data is always message-scoped and model-visible. It does not contain Provider Data. [ADR 0005](0005-own-the-provider-neutral-model-protocol.md) defines provider-owned replay data.
