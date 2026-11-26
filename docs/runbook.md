# Runbook

wp2payload has no production server. "Production" means the package published on npm, and the
migrations people run with it.

## Release

Releases are published by tag. `.github/workflows/release.yml` runs on every pushed `v*` tag.

1. On a branch, set the new version in `package.json`, and move the `Unreleased` entries in
   `CHANGELOG.md` under a heading for that version with today's date. Commit as
   `chore: release <version>`.
2. Open a pull request. CI runs typecheck, tests, build and smoke on Node 22 and 24, the
   clean-install check, the hacked-site suite and the security workflow. Merge when it passes.
3. Tag the merge commit on `main` and push the tag:

   ```bash
   git switch main && git pull
   git tag v<version>
   git push origin v<version>
   ```

4. The release workflow:
   - runs the hacked-site suite first, and stops if it fails;
   - checks that the tag matches the version in `package.json`;
   - checks that npm is 11.5.1 or newer, which trusted publishing needs;
   - installs with `--frozen-lockfile`, then runs typecheck, tests, build and smoke;
   - publishes with `npm publish --access public` through npm trusted publishing (OIDC), with
     provenance. No npm token is stored anywhere.
5. Check that the npm package page shows the new version and its provenance.
6. Run `npx wp2payload@latest doctor` in a clean sample Payload project.
7. Publish release notes on GitHub Releases, copied from `CHANGELOG.md`.

If the tag does not match `package.json`, nothing is published. Delete the tag, fix the version
and tag again.

**Account hygiene.** npm 2FA is on for the maintainer account. Releases come only from GitHub
Actions through trusted publishing, so there is no long-lived npm token to leak.

## A bad release

Do not unpublish: it breaks installs for everyone who pinned that version.

1. Move `latest` back:

   ```bash
   npm dist-tag add wp2payload@<previous> latest
   ```

2. Deprecate the bad version:

   ```bash
   npm deprecate wp2payload@<bad> "Broken: <reason>. Use <previous> or <fixed>."
   ```

3. Open a public issue describing the impact and the workaround.
4. Fix it, add a regression test, and release a patch.
5. Close the issue with a link to the fix.

## CI fixture breaks

The usual cause is an upstream Docker image that changed. Images are pinned by tag and digest in
`docker-compose.yml` (the WordPress fixture) and `tests/fixtures/hacked-site/docker-compose.yml`.
The Theme Unit Test data is pinned by commit and sha256 in `scripts/fixture-seed.mjs`.

1. Update one pin at a time.
2. Reset and seed again: `pnpm fixture:down`, `pnpm fixture:up`, `pnpm fixture:seed`, or
   `pnpm fixture:hacked` for the hacked site.
3. Change expected test output only after reviewing the diff.
4. Update the pins table in `tests/fixtures/wordpress/README.md`.

## A user reports data loss or wrong content

1. Ask for `report.json`, the config with secrets removed, the WordPress version, the Payload
   version and database adapter, and the source type.
2. Reproduce with a fixture. If the content type is new, add it to the fixtures first.
3. Label the issue `data-integrity`. These go ahead of all feature work.
4. Ship the fix as a patch and reply with the version.

## Running a client migration

1. **Agreement.** A written scope (content types, page count, custom fields), a timeline and
   data-handling terms, before receiving any files.
2. **Receive data.** Backups over a shared link the client controls, never as email
   attachments.
3. **Store.** In an encrypted folder, outside any Git repository.
4. **Scan first.** Run `wp2payload doctor` and `wp2payload scan`, and share the security findings
   (`scan.html`) with the client.
5. **Dry run.** On a staging copy of the client's Payload project. Share the dry-run report.
6. **Migrate.** Run for real on staging. The client reviews a sample of pages. Go through the
   quarantine with `wp2payload review`. If authors became login accounts, check every
   `AUTHOR_ACCOUNT_CREATED` entry.
7. **Launch.** The client applies the redirects. Check that 20 random old URLs return a redirect
   to the right page.
8. **Content freeze.** If the old site changed after the migration, run
   `wp2payload migrate --since <date of the first run>`.
9. **Credentials.** Remind the client to revoke the WordPress Application Password and, if the
   old site was compromised, to rotate every credential it used.
10. **Clean up.** Delete the backup, `.wp2payload/` (state, reports and quarantine) and any
    temporary copies. Confirm the deletion to the client in writing.

## Handling a security report

Reports arrive through GitHub private vulnerability reporting ([SECURITY.md](../SECURITY.md)).

1. Acknowledge privately within 7 days.
2. Reproduce and assess the severity.
3. Fix it in a private fork from the GitHub security advisory, and add a hacked-site fixture case
   or a test with an inert sample.
4. Release a patch, publish the advisory, and credit the reporter unless they prefer otherwise.
5. For high severity, deprecate the affected versions with a message pointing to the fix.

For high severity, a fix or a mitigation plan is due within 30 days.
