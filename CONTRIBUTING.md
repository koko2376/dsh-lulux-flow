# Contributing to DSH-LULUX Flow

Thanks for helping. Bug reports, CLI adapters, translations and docs fixes are
all welcome.

## Ground rules

- Be kind. This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- Security problems go to the email in [SECURITY.md](SECURITY.md), not to a
  public issue.
- Never paste real API keys, gateway tokens or private paths into issues, logs
  or test fixtures.

## Development setup

Requirements: Node.js `>=22.15.0`, pnpm, and (for manual testing) DeepSeek
Harness `>=0.2.1-rc.2 <0.3.0`.

```bash
git clone https://github.com/koko2376/dsh-lulux-flow.git
cd dsh-lulux-flow
pnpm install
pnpm check          # lint + typecheck + test + build
pnpm test:client    # browser-side tests (jsdom)
```

To try your checkout in a real DSH profile, link it and restart DSH:

```bash
pnpm build
dsh plugin --profile web add "link:$PWD"
```

Host changes (`src/`) need a DSH restart; client changes (`client/`) need a
rebuild and a hard refresh of the browser tab.

## Project layout

| Path | What lives there |
|---|---|
| `src/gateway/` | Scoped gateway: wire-protocol translation, tokens, MCP approval bridge |
| `src/kernels/` | CLI catalog, launcher, binary detection, installer, registry probing |
| `src/dsh/` | DSH integration: model routes, subagent providers, agent runner |
| `src/workflow/` | DAG engine, executors, validation, cron, webhooks, SSRF guard, script runtime |
| `src/http/` | HTTP API under `/dsh-lulux-flow/` |
| `client/` | Browser bundle: canvas, runs, kernels, settings, session kernel picker |
| `test/` | Unit and integration tests (Vitest); `test/fixtures/` holds a fake CLI |

## Adding a CLI

Implement a `KernelDefinition` (see `src/kernels/types.ts` and the built-ins in
`src/kernels/catalog.ts`): package name, binary, minimum version, which gateway
protocols it needs, how to launch it in scoped and global mode, and a parser
for its machine-readable output. Third-party plugins can call the exported
`registerKernel()` instead of patching this repo. Add tests that check the
scoped launch does not leak credentials.

## Pull requests

- Keep each PR to one change and describe how you tested it.
- `pnpm check` must pass. CI runs it on Ubuntu, macOS and Windows.
- Add or update tests for behaviour changes, and a line under `Unreleased` in
  [CHANGELOG.md](CHANGELOG.md).
- User-facing strings go in both `client/src/i18n/zh.ts` and `en.ts`.
- Follow the existing style (`.editorconfig`, ESLint). Commit messages use the
  [Conventional Commits](https://www.conventionalcommits.org/) style, e.g.
  `fix(gateway): …`.

## Developer Certificate of Origin (DCO)

This project uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/)
instead of a CLA. By signing off a commit you certify that you wrote the
change, or otherwise have the right to submit it under the project's license
(Apache-2.0).

Sign off every commit with `-s`:

```bash
git commit -s -m "fix(gateway): reject empty bearer tokens"
```

which adds a trailer with your real name or a consistent public handle and an
email you can be reached at:

```
Signed-off-by: Your Name <you@example.com>
```

Forgot? Amend the last commit with `git commit --amend -s --no-edit`, or sign
off a whole branch with `git rebase --signoff main`, then force-push your
branch. PRs with unsigned commits cannot be merged.

The full DCO text:

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

## Releasing (maintainers)

The update check reads GitHub Releases, so a release is what users are told
about:

1. Tag the release commit `vX.Y.Z` (valid semver; the `version` in
   `package.json` at that tag must be `X.Y.Z`) and publish a GitHub release
   from it. Mark test builds as pre-releases: the stable check ignores them.
2. Start the release body with a short summary; the first lines (plain text,
   up to about 600 characters) are what the in-app notice shows.
3. jsDelivr caches `@latest` for up to 7 days. Purge it so users on the mirror
   nodes see the release within minutes:
   `curl https://purge.jsdelivr.net/gh/koko2376/dsh-lulux-flow@latest/package.json`

## License

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
