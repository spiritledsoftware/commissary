# Memory Store

Memory Store defines the process-local adapters used for development, tests, and local execution.

## Language

**Memory Store**:
The `MemoryStore.make` factory and its generic process-local Transaction Store result. It accepts an explicit Record catalog and uses the shared memory storage engine.
_Avoid_: Memory Thread Store, conditional Core mode, second memory engine

**Memory Thread Store**:
The `MemoryThreadStore.make` factory and its process-local Thread Store result. It composes the shared memory Transaction Store engine with Core Records, Hooks, and operations. The engine locks each complete transaction and owns rollback.
_Avoid_: Generic Memory Store, duplicated Runtime rules, conditional factory return, durable storage
