import type { JsonValue, MaybePromise } from "./types.js";

export interface Codec<Value, Encoded extends JsonValue = JsonValue> {
  readonly encode: (value: Value) => MaybePromise<Encoded>;
  readonly decode: (encoded: JsonValue) => MaybePromise<Value>;
}

type CodecValue<Definition> = Definition extends {
  readonly encode: (value: infer Value) => unknown;
}
  ? Value
  : never;

type CodecEncoded<Definition> = Definition extends {
  readonly encode: (...arguments_: never[]) => infer Encoded;
}
  ? Awaited<Encoded>
  : never;

export const Codec = {
  define<const Value, const Encoded extends JsonValue>(
    definition: Codec<Value, Encoded>,
  ): Codec<Value, Encoded> {
    return Object.freeze({ ...definition });
  },
};

export namespace Codec {
  export type Value<Definition> = CodecValue<Definition>;
  export type Encoded<Definition> = CodecEncoded<Definition>;
}
