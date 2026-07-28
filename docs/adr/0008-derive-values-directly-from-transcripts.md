# Derive values directly from Transcripts

Render-time integrations receive the immutable current Transcript and Run identity. They derive invocation-local values with ordinary functions.

Reusable folds and decoders remain helpers that integration factories can share. Durable application data stays in application storage behind captured clients. Durable conversation data stays in Message Entries.

Core has no reducer installation, derived-value registry, replay scheduler, or snapshot cache. A later design can add a projection module when real integrations need shared deterministic folds.
