# Contributing to wp2payload

Thanks for helping. This file covers setup, tests, branches, commits and pull requests.
Security problems are different: do not open a public issue, see [SECURITY.md](SECURITY.md).

## Setup

Requirements:

- Node.js 22.12 or newer (CI runs Node 22 and 24; see [ADR-0008](docs/adr/0008-esm-node22.md))
- pnpm through Corepack. `package.json` pins the version in `packageManager`, so `corepack pnpm`
  uses the right one.
- Docker, only for the WordPress fixtures. Unit and integration tests run without it.

```bash
git clone https://github.com/abdulrehmankz1/wp2payload
cd wp2payload
corepack pnpm install
cp .env.example .env
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm smoke     # runs the built CLI and checks its output
```

The examples below write `pnpm` for short. Install scripts are off: `pnpm-workspace.yaml` denies
the esbuild postinstall, and the package itself has no lifecycle scripts. Keep it that way.

## Tests

Vitest runs three projects (`vitest.config.ts`):

| Project | Files | Needs |
| --- | --- | --- |
| `unit` | `tests/unit/**/*.test.ts` | Nothing |
| `int` | `tests/int/**/*.int.test.ts` | Nothing: a real Payload instance on SQLite (or MongoDB, see below), started by the test |
| `e2e` | `tests/e2e/**/*.e2e.test.ts` | The hacked-site fixture (Docker). Skipped when it is not seeded |

| Script | What it runs |
| --- | --- |
| `pnpm test` | All three projects |
| `pnpm test:unit` | Unit tests only |
| `pnpm test:int` | Integration tests only |
| `pnpm test:security` | The e2e project, then the sanitizer fuzzing and security unit tests |
| `pnpm test:watch` | Vitest in watch mode |

### WordPress fixture

A local WordPress with the WordPress Theme Unit Test data and Yoast SEO, bound to
`127.0.0.1:8080`. Details and pins are in
[tests/fixtures/wordpress/README.md](tests/fixtures/wordpress/README.md).

```bash
pnpm fixture:up       # docker compose up -d
pnpm fixture:seed     # imports the test data; writes WP_URL, WP_USER, WP_APP_PASSWORD to .env
pnpm fixture:down     # docker compose down -v (drops the database and files)
```

The seed never prints the Application Password. It only writes it to `.env`, which git ignores.

### Hacked-site fixture

A second WordPress seeded with every threat in [docs/security.md](docs/security.md), bound to
`127.0.0.1:8091`. CI migrates it on every change and before every release. Details in
[tests/fixtures/hacked-site/README.md](tests/fixtures/hacked-site/README.md).

```bash
pnpm fixture:hacked                          # start, install and seed (writes HACKED_* to .env)
WP2P_REQUIRE_HACKED=1 pnpm test:security     # what CI runs: a missing fixture fails
docker compose -f tests/fixtures/hacked-site/docker-compose.yml down -v
```

Without the `HACKED_*` variables the e2e tests are skipped. With `WP2P_REQUIRE_HACKED=1` they fail
instead, so CI cannot pass by skipping them.

## Environment variables for development

`.env.example` lists them. Copy it to `.env`.

| Variable | Example | Used by |
| --- | --- | --- |
| `WP_URL` | `http://localhost:8080` | REST source; written by `pnpm fixture:seed` |
| `WP_USER` | `wp2p-editor` | Application Password auth; written by `pnpm fixture:seed` |
| `WP_APP_PASSWORD` | written by `pnpm fixture:seed` | Application Password auth |
| `PAYLOAD_SECRET` | any string for local use | Running the CLI inside a Payload project |
| `DATABASE_URI` | `file:./tmp/test.db` | Running the CLI inside a Payload project |
| `NO_COLOR` | `1` | Turns off coloured output |
| `WP2P_TEST_DB` | `sqlite` (default) or `mongodb` | Which database the integration tests use |
| `WP2P_TEST_MONGO_URL` | `mongodb://127.0.0.1:27017/?replicaSet=rs0` | MongoDB for `WP2P_TEST_DB=mongodb`. Each test file gets its own database, dropped afterwards. A single-node replica set exercises transactions, as in CI |

The integration tests start their own Payload (SQLite unless `WP2P_TEST_DB=mongodb`) and do not
read `DATABASE_URI`. CI runs them on both, and a weekly job runs them against the latest Payload
release.

## Branches

`main` is always releasable and protected. Work on short-lived branches named after the change:

- `feat/<short-name>`
- `fix/<short-name>`
- `test/<short-name>`
- `docs/<short-name>`
- `chore/<short-name>`

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `perf:`, `test:`,
`docs:`, `refactor:`, `build:`, `ci:`, `chore:`. A scope is welcome when it helps:
`fix(rest): ...`, `feat(scan): ...`.

- One line, in the imperative, lower case after the type: `fix(seo): drop canonicals with credentials`.
- No long bodies or bullet lists. If a change needs explaining, the pull request is the place.
- Keep commits small. Tests can go in their own `test:` commit next to the change.

## Pull requests

The [pull request template](.github/pull_request_template.md) has the checklist. In short:

- One change per pull request.
- Add or update tests. A transformer change needs an input fixture (under `tests/fixtures/`) and
  an expected output in the test.
- A security-relevant change (sanitizer, media checks, download guard, archives, dumps, reports)
  needs a hacked-site case: a fixture or test that shows the attack is stopped. Every security
  bug gets that case before its fix is merged.
- A new dependency needs a one-line reason in the pull request. Prefer the standard library;
  the dependency tree is part of the attack surface.
- User-facing changes add a line under `Unreleased` in [CHANGELOG.md](CHANGELOG.md), and update
  the README or `docs/` when behaviour, flags, config or codes change. A new report code goes in
  [docs/reference/codes.md](docs/reference/codes.md); codes keep their meaning once released.
- CI must pass: typecheck, tests, build and smoke on Node 22 and 24, the clean-install check,
  the hacked-site suite, and the security workflow (pnpm audit, OSV-Scanner, CodeQL).

## Releases

Maintainers release by tag. The steps are in [docs/runbook.md](docs/runbook.md#release).

## Reporting bugs

Use the bug template. Attach `.wp2payload/report.json` if you can: it holds no passwords, and no
email addresses unless you ran with `--include-pii`. Remove anything private (site names, titles,
URLs) before sharing.

## Scope

Please open an issue to discuss large features before writing code. Page-builder layouts and
two-way sync are out of scope for now. [docs/roadmap.md](docs/roadmap.md) lists what is planned.
