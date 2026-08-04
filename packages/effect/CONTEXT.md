# Effect Integration

Effect Integration adapts Commissary's plain JavaScript contracts to Effect-native services, clients, executions, and Effect AI Models.

## Language

**Effect Commissary Instance**:
An Effect-native view of a Commissary Instance whose asynchronous operations return Effect values.
_Avoid_: Core Commissary Instance, Effect Layer, global service

**Effect Agent Client**:
An Effect-native view of one Agent Client that preserves the installed Agent's typed commands and requirements.
_Avoid_: Core Agent Client, untyped service client, Agent

**Effect Execution**:
An Effect-native view of one Core Execution whose result and abort operation are Effect values.
_Avoid_: Core Execution, Run, Effect fiber

**Effect AI Integration**:
The adapter that translates between Commissary's provider-neutral Model protocol and Effect AI Models, Tools, provider data, and failures.
_Avoid_: Provider Package, Core Model, raw Effect AI LanguageModel
