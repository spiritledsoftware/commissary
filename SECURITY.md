# Security policy

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting:
[report a vulnerability](https://github.com/spiritledsoftware/commissary/security/advisories/new) (the repository's
**Security** tab, then **Report a vulnerability**). Please do not open a public issue, pull request or discussion for it.

Include what you can of:

- what the problem is and what an attacker gains (another org's data, a secret, a gate that does not hold);
- the version or commit, and whether it is a self-hosted Commissary or Commissary Cloud;
- steps to reproduce, or a proof of concept;
- any logs or requests that help, with keys and tokens removed.

## What happens next

We read every report, reply on the advisory, and keep you posted while we confirm and fix it. Once a fix is deployed,
we publish the advisory and credit you if you wish. This is a small project: there is no bounty and no fixed response
time, but a report that shows a leak of secrets or one org reaching another's data comes first.

## Supported versions

Only `main` and Commissary Cloud, which deploys from `main`, get fixes. There are no release branches. A self-hosted
Commissary updates by deploying `main` ([README](README.md#updating-and-removing)).

## What Commissary defends

[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) says what Commissary protects, who it trusts, how it limits what a
steered agent can do (ADR 0044), and the risks it accepts. A report that shows one of its defences not holding is in
scope; behaviour the threat model lists under "Accepted risks" is by design.
