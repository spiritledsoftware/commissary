export const modelEnvironment: unique symbol = Symbol("commissary.internal.modelEnvironment");

export interface InternalCommissaryConfiguration {
  readonly [modelEnvironment]?: unknown;
}
