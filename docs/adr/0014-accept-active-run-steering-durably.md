# Accept active-Run Steering durably

`Runtime.steer` accepts a canonical Model Message only while its Run is nonterminal. It records the Message as Pending Steering and does not advance the Branch head.

The caller can supply a Steering Request ID. Without an ID, each call creates a new submission. An unknown ID records the submission. An exact replay returns the first acceptance. Conflicting reuse fails.

The Thread Store assigns accepted Steering a stable FIFO order. At a safe boundary, the Machine appends the Messages and marks them as consumed in one atomic operation. It then renders the next Step.

The host cannot cancel or reorder accepted Steering. Steering is a durable command, not a Hook side channel.
