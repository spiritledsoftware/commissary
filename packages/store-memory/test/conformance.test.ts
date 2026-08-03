import { createCoreRuntimeConformanceSuite } from "@commissary/core/conformance";
import {
  createStoreAdapterConformanceSuite,
  storeConformanceRecordDefinitions,
} from "@commissary/store/conformance";
import { it } from "vitest";

import { MemoryStore, MemoryThreadStore } from "../src/index.js";
import { memoryConformanceProfile } from "./conformance-profile.js";

for (const scenario of createStoreAdapterConformanceSuite({
  profile: memoryConformanceProfile,
  makeStore: () => MemoryStore.make({ records: storeConformanceRecordDefinitions }),
})) {
  it(`Memory Store conformance: ${scenario.name}`, scenario.run);
}

for (const scenario of createCoreRuntimeConformanceSuite({
  adapter: "MemoryThreadStore",
  makeThreadStore: () => MemoryThreadStore.make(),
  makeConfiguredThreadStore: (configuration) => MemoryThreadStore.make(configuration),
})) {
  it(`Core Runtime conformance: ${scenario.name}`, scenario.run);
}
