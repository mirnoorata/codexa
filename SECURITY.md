# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue for security problems.** Public issues are
visible immediately to everyone, which is the opposite of what responsible
disclosure needs.

Instead, use **GitHub's private security advisory flow**:

1. Go to the **Security** tab on this repository.
2. Click **Report a vulnerability**.
3. Describe what you found. Include reproduction steps when possible.

That opens a private thread visible only to you and the maintainer. If you
prefer, the same channel is reachable from
`https://github.com/mirnoorata/codexa/security/advisories/new`.

If the private advisory flow is unavailable for some reason, you can also reach
the maintainer through the contact information on
[@mirnoorata](https://github.com/mirnoorata)'s GitHub profile.

## What to expect

These are targets, not guarantees. This is a solo-maintained project. If the
maintainer is traveling, between jobs, or otherwise offline, all of these
numbers may stretch. If you haven't heard back by roughly 3× the target below,
it is reasonable to post a short follow-up in the advisory thread.

- **Acknowledgement**: target 7 days. Stretches to 2–3 weeks when the
  maintainer is offline.
- **Triage outcome**: target 30 days — either a confirmed fix plan, a
  "not a vulnerability in our threat model" with reasoning, or a request for
  more detail. Genuinely complex issues can take longer; if so, I will say so.
- **Disclosure coordination**: if a fix is needed, we will coordinate a public
  advisory + release on a timeline that gives users time to upgrade. 90-day
  default, shorter or longer when circumstances warrant.

Serious issues always take priority over the above targets. I will not silently
let a report sit — you will get at least "I saw this, looking into it" within
the acknowledgement window in almost every case.

## Scope

In scope:
- Privilege escalation, sandbox escape, arbitrary code/file/secret exfiltration
  from running the Codexa CLI or MCP server against a normal repo.
- Injection through repo content (filenames, file content, git metadata)
  reaching the model or another tool via Codexa output.
- Dependency vulnerabilities that are reachable from Codexa's surface area.

Out of scope:
- Findings that require the attacker to already have write access to the target
  repo's source (we trust the repo contents — Codexa is a reader).
- Self-XSS or social-engineering scenarios that do not involve a Codexa code
  path.
- Running Codexa against a deliberately malformed index file that was hand-
  crafted by the same user running the command.

## Credit

If you would like public credit for a reported and fixed vulnerability, say so
in the report. A credit line in the release notes is the default.
