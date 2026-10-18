# Releases

Pull requests to `main` build the runtime image, run Go tests and the CRD drift
check, compile TypeScript, and smoke-test the container's version, health, and
SPA endpoints. The same validation gates publishing on main, tags, and manual
runs. Configure repository branch protection to require the `validate` check.

Push `main` to publish `:sha-<full-commit>` and, if the commit is still the main
head, `:dev`. Push a tag such as `v1.2.3` to publish that version. Only the highest
stable version tag in the repository receives `:latest`; prerelease tags such as
`v1.3.0-rc.1` never do. Accepted tags contain three numeric version components,
optionally followed by dot-separated prerelease identifiers (no build metadata).
Do not move or delete release tags. Protect release tags in repository rules.
Manual runs on other branches publish only a SHA tag. Tags refer to the selected
commit, which need not be on main; restrict tag creation to release maintainers.

Publish jobs share one concurrency group. Each refreshes main and tag refs
before choosing mutable aliases, preventing an older queued main build from
replacing a newer main image. GitHub concurrency can replace pending jobs, so
rerun a canceled release if its version image is needed. A tag created before a
failed release may suppress latest promotion for an older release; rerun the
newer release after fixing its failure.

Images embed editor, Telepathy, and Calico versions and record the source commit
in OCI labels. Deployment uses the digest printed in the publish summary; SHA
and version tags remain mutable registry references. Base image tags are also
mutable, so rebuilding a commit can produce a different digest.

## Local builds and exams

```sh
make image                         # IMAGE:dev, default GHCR repository
make publish TAG=v1.2.3             # builds and tags locally; does not push
make publish IMAGE=ghcr.io/acme/peacha-editor TAG=v1.2.3
```

Local publish creates only the requested tag; CI owns automatic `latest`
promotion. Both Docker targets initialize pinned submodules and run the build's
validation gates. They exclude private exams by default, even if a developer
previously synced them. Public CI always sets `INCLUDE_EXAMS=false`.

For an intentionally private exam image, run `make exams-sync`, verify the
content and revision of `third_party/exams`, then use
`make publish INCLUDE_EXAMS=true IMAGE=YOUR_PRIVATE_IMAGE TAG=YOUR_TAG`.
This fails if no exam directories are present or no valid exams load.
The solution test skips absent exams for public builds; set `REQUIRE_EXAMS=true`
when running Go tests to require private exam coverage. Keep that registry private:
answer keys are embedded in the executable. `make test` no longer fetches or
changes private exam content. Non-Docker Go builds embed the current local
`server/exams` directory, so clean or sync that directory deliberately.

Publishing uses GITHUB_TOKEN with package write permission. If the Telepathy
submodule becomes private, configure checkout authentication for that repository
in both jobs. Package visibility and repository branch/tag protections must be
configured on GitHub; the workflow does not change them.

See [Kubernetes deployment](../deploy/k8s/README.md) for initial configuration,
digest-pinned deployment, verification, and rollback. This workflow publishes
container images; it does not create GitHub Release pages or binary downloads.
