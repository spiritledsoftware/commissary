import type { Codec as CodecContract } from "./codec.js";
import type { EncodedMessageData, ModelMessage, Transcript } from "./protocol.js";
import type { JsonValue } from "./types.js";

export class MessageDataMismatchError extends Error {
  readonly item: EncodedMessageData;

  constructor(
    readonly expectedKey: string,
    readonly expectedVersion: number,
    item: EncodedMessageData,
  ) {
    super(
      `Expected Message Data ${expectedKey}@${expectedVersion}, received ${item.key}@${item.version}`,
    );
    this.name = "MessageDataMismatchError";
    this.item = item;
  }
}

export interface MessageDataDefinition<
  Key extends string,
  Version extends number,
  Value,
  _Encoded extends JsonValue,
> {
  readonly key: Key;
  readonly version: Version;
  readonly attach: (message: ModelMessage, value: Value) => Promise<ModelMessage>;
  readonly decode: (item: EncodedMessageData) => Promise<Value>;
  readonly collect: (transcript: Transcript) => Promise<readonly Value[]>;
}

export const MessageData = {
  define<
    const Key extends string,
    const Version extends number,
    Value,
    const Encoded extends JsonValue,
  >(definition: {
    readonly key: Key;
    readonly version: Version;
    readonly codec: CodecContract<Value, Encoded>;
  }): MessageDataDefinition<Key, Version, Value, Encoded> {
    const { key, version, codec } = definition;

    const decode = async (item: EncodedMessageData): Promise<Value> => {
      if (item.key !== key || item.version !== version) {
        throw new MessageDataMismatchError(key, version, item);
      }
      return codec.decode(item.value);
    };

    return Object.freeze({
      key,
      version,
      async attach(message: ModelMessage, value: Value): Promise<ModelMessage> {
        const encoded = await codec.encode(value);
        const data: EncodedMessageData<Key, Version, Encoded> = Object.freeze({
          key,
          version,
          value: encoded,
        });
        return Object.freeze({
          ...message,
          content: Object.freeze([...message.content]),
          data: Object.freeze([...(message.data ?? []), data]),
        });
      },
      decode,
      async collect(transcript: Transcript): Promise<readonly Value[]> {
        const values: Value[] = [];
        for (const message of transcript) {
          for (const item of message.data ?? []) {
            if (item.key === key && item.version === version) {
              values.push(await decode(item));
            }
          }
        }
        return Object.freeze(values);
      },
    });
  },
};

export namespace MessageData {
  export type Value<Definition> =
    Definition extends MessageDataDefinition<string, number, infer Domain, JsonValue>
      ? Domain
      : never;
}
