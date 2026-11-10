/** A strict-valid single-layer (`E…`) Claude signature: protobuf field 2 -> container(field 1 channel, field 2). */
const field = (num: number, bytes: number[]): number[] => [(num << 3) | 2, bytes.length, ...bytes];

const zeros = (length: number): number[] => Array.from({ length }, () => 0);

export const claudeSignature = (): string => {
  const channel = [(1 << 3) | 0, 11, (3 << 3) | 0, 2, ...field(5, zeros(64))];
  const container = [...field(1, channel), ...field(2, zeros(12))];

  return btoa(String.fromCharCode(...field(2, container)));
};
