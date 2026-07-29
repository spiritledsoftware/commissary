# Interrupt Model work with Redirects

Steering remains a FIFO Message for the next safe Step. Redirect is a separate durable command with its own request ID because it can cancel the active uncommitted root Model invocation without aborting the Run.

The first durable commit wins. When Redirect commits first, core cancels the root Model invocation and its Composite Model children, does not commit its partial response, and prepares the Redirect Message. Process-local Events can still show the discarded partial response. When a Model response and its Tool Calls commit first, Redirect waits until that Tool work resolves. A terminal result cannot commit while Redirect is pending.

Core keeps distinct Redirects in FIFO order. An exact request replay returns its first acceptance and never cancels another Model invocation.
