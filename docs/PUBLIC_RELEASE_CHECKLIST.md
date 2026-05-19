# Public release checklist

This is a maintainer-side checklist for going from "private repo" to "public on
GitHub" without leaking PII, without signing up for unbounded work, and without
getting surprised by GitHub features that are off by default.

It is written as a sequence. Do each step once, in order, the first time. After
that, most of these are either "already done" or "only touch when something
changes."

---

## Before you push for the first time

### Local hygiene — must pass

Run from the repo root, with a clean working tree:

```bash
npm run check                  # build + lint + tests
npm run privacy                # tracked files and .codex/ hints
npm run privacy:history        # full git log scan
npm run security:check         # dependency audit
npm run public:snapshot-check  # refuses to run if the tree is dirty
```

All five must exit zero. `privacy:history` is the one that catches local
home-directory paths, workspace-root paths, hardcoded emails, tokens, and
private-key blocks that slipped into any historical commit, even commits
you plan to squash away. Run
it anyway — one bad `git reflog` recovery away from re-surfacing is not the
story you want.

If `privacy:history` flags something real and you intend to use the
single-squash strategy, the squash removes the history — but the scanner still
has to come back clean against the *new* single commit before you push.

### Files that should exist

- `LICENSE`
- `README.md` with the maintainer-expectations banner at the top
- `SECURITY.md`
- `CONTRIBUTING.md`
- `CODE_OF_CONDUCT.md`
- `.github/ISSUE_TEMPLATE/bug_report.md`
- `.github/ISSUE_TEMPLATE/feature_request.md`
- `.github/ISSUE_TEMPLATE/config.yml`
- `.github/pull_request_template.md`
- `.github/workflows/check.yml` (already exists — CI)

### Identity

- `LICENSE` has your real name on the copyright line.
- Every commit in the outgoing history was authored as
  `Codexa <codexa@example.invalid>` (or equivalent pseudonymous identity).
- Your real GitHub email is not in any commit, any file, or any git log line.

Verify with:

```bash
git log --format='%an <%ae>' | sort -u
```

One line. One author. One pseudonymous address.

---

## The GitHub repo itself (settings → set once)

These are all under `Settings` for the repository after it exists.

### General

- **Default branch:** `main`.
- **Features to disable** unless you actually want them:
  - Wiki — disable. Issues and the repo itself are enough.
  - Projects — disable unless you plan to use GitHub Projects.
  - Sponsorships: leave off unless you want it.
- **Features you MUST enable before the first push lands in search results:**
  - **Discussions** — `Settings → General → Features → Discussions`. The
    README banner, `SECURITY.md`, and `.github/ISSUE_TEMPLATE/config.yml`
    all point users at `https://github.com/mirnoorata/codexa/discussions`.
    If Discussions is not enabled, that URL returns a 404 and new
    contributors bounce. Enable it in the same session that you make the
    repo public — do not defer.

### Access

- **Who can create issues:** default (anyone with a GitHub account). Fine.
- **Limit interactions** (`Settings → Moderation options → Code interaction
  limits`) is useful if you ever get a burst of low-quality traffic. Leave
  off on day one. Know it exists.

### Branches

- **Protect `main`.** Under `Settings → Branches → Add rule`:
  - Branch name pattern: `main`
  - Require a pull request before merging: on
  - Require status checks to pass before merging: on
  - Add `check` (from `.github/workflows/check.yml`) as required
  - Require branches to be up to date before merging: on
  - Do not allow bypassing the above settings: leave unchecked (you want to
    be able to push emergency fixes as maintainer)
  - Restrict who can push to matching branches: just you

This means "I cannot accidentally merge a PR whose CI failed." It does not
mean "I cannot merge my own PRs." It just makes the CI green light mandatory.

### Security

- **Private vulnerability reporting:** `Settings → Code security and analysis
  → Private vulnerability reporting → Enable`. This is the flow
  `SECURITY.md` and the issue template `config.yml` point at.
- **Dependency graph:** enable.
- **Dependabot alerts:** enable.
- **Dependabot security updates:** enable. (This is the one that actually
  opens PRs that bump vulnerable deps. You can always close a PR you don't
  like.)
- **Secret scanning / push protection:** enable both. Catches the kind of
  mistake you are specifically trying to avoid.
- **Code scanning (CodeQL):** optional day one. Enabling it opens one more PR
  (default setup or advanced). Fine to defer.

### Actions

- `Settings → Actions → General`:
  - Allow `check.yml` to run. Default "Allow all actions and reusable
    workflows" is usually fine on a new solo repo; tightening later is cheap.
  - Under `Fork pull request workflows from outside collaborators`: pick
    **Require approval for all outside collaborators**. Prevents a drive-by
    fork PR from running your Actions minutes without your review.

### Notifications

- `https://github.com/settings/notifications` — this is account-wide:
  - Participating / watching: your call. "Only participating" keeps the
    volume down.
  - Watching this repo specifically: `Watch → Custom → Issues, Pull requests,
    Releases, Security alerts`. Turn off Discussions notifications if you
    don't want a ping every time someone posts a question.
- Consider a label/filter in your mail client that routes
  `notifications@github.com` away from your inbox.

---

## The first week of being public

Things that might happen, in rough descending order of likelihood.

### An automated bot files a low-quality issue

Close it. No reply needed. If it repeats, use `Settings → Moderation options`
to limit interactions temporarily. GitHub has a "spammy issue" report button;
use it when applicable.

### Someone opens a PR without opening an issue first

If it's a real fix: thank them, merge if good, ask them to link an issue next
time.

If it's scope creep, a new language, an LLM layer, etc: reply kindly, close,
point at `CONTRIBUTING.md` "Scope is deliberately narrow." The PR template
tells them this is likely; closing it is not mean, it is what you told them
to expect.

### Someone wants to "help maintain" the project

Do not hand out write access. Ever, early. The path is:
consistent useful contributions over months → maybe a formal invite. Before
then, they help by opening good issues and good PRs. If that pattern is not
already happening, the answer to "can I help maintain" is "not yet — the way
to help is to send a good PR first."

### A real security report comes in through the advisory flow

Acknowledge within the SLA from `SECURITY.md` (7 days). Even "I received this
and am looking at it" counts as acknowledgment. Do not publish a fix
commit with the vulnerability in the message before the advisory is
published.

### Someone asks "is this the right tool for X?"

Point at Discussions. If it is the right tool, great. If it is not, say that
plainly — it is a kinder answer than silence. This is literally what
`CODE_OF_CONDUCT.md` says you will do.

### You want to stop

You can:

- Archive the repo (`Settings → General → Archive`). It becomes read-only and
  shows an "Archived" banner. Nothing is lost; nobody can open issues/PRs.
- Add a single line to README: "Not currently maintained. See forks." That
  is also a complete answer.

Neither of these is failure. Both are normal open-source lifecycles.

---

## Quarterly (or whenever you remember)

- Re-run `npm run security:check` locally. Dependabot is the continuous
  version of this, but a local run confirms nothing is stuck.
- Glance at open issues. Close anything you would not pick up in the next six
  months, with a short "out of scope / not planned" note. Issues that sit
  open for a year with no reply are worse for everyone than closed issues.
- Cut a release if there are shipped changes:
  `npm run release:github -- --tag v0.2.0`. This runs the release gate, pushes
  the project source tag, and creates the GitHub Release timeline entry with
  a changelog-style summary, changed-area summary, exact GitHub restore
  commands, exact branch/worktree commands, and a forward-only rollback branch
  recipe.
  Releases give Dependabot and downstream users something to pin against.
- Verify the visible GitHub surfaces before calling the release done:
  `git ls-remote --tags origin refs/tags/v0.2.0` and
  `gh release view v0.2.0 --repo mirnoorata/codexa --json tagName,name,url,targetCommitish`.
  If either check is empty, the change is not released yet.

---

## If something scary happens

- **Someone posts a real vulnerability publicly as an issue:** delete the
  comment/issue quickly (you can redact via `Edit → Hide`), open a private
  advisory, reply to the reporter privately. Then publish a fix on your
  schedule, not theirs.
- **A commit went out with a real secret:** rotate the secret first, push
  second. Force-pushing to remove it from history does not help — it is
  already cached. Rotation is the only real fix.
- **A PR you merged broke main:** use the most recent GitHub Release notes'
  "Revert Changes Via PR" block to create a forward-only rollback branch. If
  the bad change is a single merge commit, `git revert -m 1 <sha>` is fine.
  Do not force-push `main`.
- **Harassment in an issue or PR:** lock the thread (`Lock conversation`),
  add a maintainer reply explaining why, consider blocking the user from the
  repo (`Settings → Moderation options → Block user`). `CODE_OF_CONDUCT.md`
  gives you the authority; use it early rather than late.

---

## What this checklist is and is not

It is: a reminder of the specific levers GitHub hands maintainers that are
off or misconfigured by default, and a sketch of the first week.

It is not: a promise that nothing will go wrong. Most of what goes wrong with
a public solo repo is "low-quality noise takes more time than the useful
contributions saved." The defenses against that are the CONTRIBUTING.md
scope section, the issue templates, the PR template, and closing things
quickly and kindly. Everything else is second-order.
