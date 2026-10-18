---
status: accepted
---

# System One requests use TypeSafe's API, converted for other providers

System One models (TypeSafe's Jev, Subquadratic's SubQ Snap) do not generate text: they answer typed questions about a state, so no existing client format can carry them. Commissary adds one client format for them, TypeSafe's System One API (`POST /v1/systemone`, JSON or multipart), because Jev is the most used System One model and its SDKs are what clients already have. Every provider is converted to and from it: TypeSafe and OpenCode Zen (whose Jev endpoint relays TypeSafe's) need little more than the model id, SubQ needs its own request, image and error shapes. TypeSafe and SubQ are first-class providers with their own key groups and catalog additions, since models.dev lists none of these models and the conversions differ per provider.

## Considered Options

- A passthrough (`model` swapped, the body untouched): simpler, but a client would have to speak each provider's dialect, and a model alias or failover across providers would send one provider's body to another.
- One generic "System One endpoint" key group, like OpenAI-compatible endpoints: it cannot hold the per-provider conversions, and admins would type every model and price in by hand.

## Consequences

- Converting is lossy where SubQ is narrower: TypeSafe places an image where its reference appears, SubQ shows every image to every question, so on SubQ the references become labels (`[image 1]`) and an image is no longer scoped to one question.
- What a provider cannot serve is refused by Commissary with a TypeSafe-shaped error instead of being sent upstream: Box questions on models without them, images on OpenCode Zen (which drops TypeSafe's opt-in header), and requests over SubQ's image limits.
- Every `/v1/systemone` error, Commissary's own and the providers', reaches the client in TypeSafe's shape (`{"detail":{"error_type","message"}}`), so TypeSafe's SDKs parse failures and retry as they would against TypeSafe.
- System One models are listed in `/v1/models` like any other model but served only on `/v1/systemone`, and that endpoint serves nothing else.
