import type { Codec as CodecContract } from "./codec.js";
import type { ContentPart, EncodedProviderData } from "./protocol.js";
import type { JsonValue } from "./types.js";

export class ProviderDataMismatchError extends Error {
  constructor(
    readonly expectedNamespace: string,
    readonly expectedVersion: number,
    readonly part: ContentPart,
  ) {
    super(
      `Expected Provider Data ${expectedNamespace}@${expectedVersion} on ${part.type} Content Part`,
    );
    this.name = "ProviderDataMismatchError";
  }
}

export interface ProviderDataDefinition<
  Namespace extends string,
  Version extends number,
  Value,
  _Encoded extends JsonValue,
> {
  readonly namespace: Namespace;
  readonly version: Version;
  readonly attach: <Part extends ContentPart>(part: Part, value: Value) => Promise<Part>;
  readonly decode: (part: ContentPart) => Promise<Value>;
}

export const ProviderData = {
  define<
    const Namespace extends string,
    const Version extends number,
    Value,
    const Encoded extends JsonValue,
  >(definition: {
    readonly namespace: Namespace;
    readonly version: Version;
    readonly codec: CodecContract<Value, Encoded>;
  }): ProviderDataDefinition<Namespace, Version, Value, Encoded> {
    const { namespace, version, codec } = definition;

    return Object.freeze({
      namespace,
      version,
      async attach<Part extends ContentPart>(part: Part, value: Value): Promise<Part> {
        const encoded = await codec.encode(value);
        const data: EncodedProviderData<Namespace, Version, Encoded> = Object.freeze({
          namespace,
          version,
          value: encoded,
        });
        return Object.freeze({
          ...part,
          providerData: Object.freeze([...(part.providerData ?? []), data]),
        }) as unknown as Part;
      },
      async decode(part: ContentPart): Promise<Value> {
        const item = part.providerData?.find(
          (candidate) => candidate.namespace === namespace && candidate.version === version,
        );
        if (item === undefined) {
          throw new ProviderDataMismatchError(namespace, version, part);
        }
        return codec.decode(item.value);
      },
    });
  },
};

export namespace ProviderData {
  export type Value<Definition> =
    Definition extends ProviderDataDefinition<string, number, infer Domain, JsonValue>
      ? Domain
      : never;
}
