# Stream Adapter

Stream Adapter exposes bounded, single-consumer JavaScript and Effect streams for one Core Execution.

## Language

**Stream Adapter**:
An adapter that changes Execution Events into a bounded, single-consumer stream.
_Avoid_: Core event queue, relay, replay log, transport

**Events Dropped Event**:
An adapter Event that reports how many buffered Events a Stream Adapter discarded.
_Avoid_: Error Event, durable gap marker, execution backpressure, core event
