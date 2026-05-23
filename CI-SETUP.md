# CI/CD Setup for hermes-vscode

This document describes the GitHub Actions workflows and required secrets.

## Workflows

### 1. PR Build (`.github/workflows/pr-build.yml`)

- Triggers on every pull request to `main`.
- Runs on `ubuntu-latest`.
- Steps:
  - Checkout
  - Setup Node.js 20 (with npm cache)
  - `npm ci` (clean install)
  - `npm run build` (webpack production)
  - `npm run package` (vsce package → `.vsix`)
  - Upload VSIX as a build artifact (retained 14 days)

**Purpose:** Provide PR reviewers with a downloadable VSIX to manually install and test the extension.

Artifact name: `hermes-vscode-vsix` (download from the PR's "Artifacts" section).

---

### 2. Release (`.github/workflows/release.yml`)

- Triggers on push to `v*` tags.
- Runs on `ubuntu-latest`.
- Permissions: `contents: write`, `packages: write`, `attestations: write`.
- Steps:
  - Same build/packaging steps as PR
  - Extract version from `package.json` → `vX.Y.Z`
  - Upload VSIX as artifact (retained 90 days)
  - Create a GitHub Release with that tag and attach the VSIX

**Important:** To create a release, tag the commit with a `v*` tag matching the version in `package.json` (e.g., `v3.0.0`). The workflow will only run on those tagged commits, ensuring releases are intentional and idempotent.

For example:
```bash
git tag v1.0.0
git push origin v1.0.0
```

Note: Automatic publishing to the VS Code Marketplace is **not** configured. If you want CI to publish to the marketplace, add a step and the `VSCE_TOKEN` secret.

---

## Secrets Configuration

Add these secrets in **GitHub Repo Settings → Secrets and variables → Actions**:

| Secret | Required? | Description |
|--------|-----------|-------------|
| `GITHUB_TOKEN` | No (auto-provided) | Automatically provided by GitHub Actions. Used for creating releases and publishing packages. No manual setup needed. |

No other secrets are required for the current CI configuration.

---

## Manual Publishing to VS Code Marketplace (Optional)

If you want to publish manually:

1. Run locally: `npm run publish` (requires `VSCE_TOKEN` in env)
2. To get a token: https://aka.ms/vscode-vsce
3. Set env var: `VSCE_TOKEN=your_token npm run publish`

Or add a marketplace publish step back into `release.yml` if desired.

---

## Manual Testing from PR Artifacts

1. Open the PR on GitHub.
2. In the "Checks" section, find the "PR Build — VSIX" workflow.
3. Click "Artifacts" → download `hermes-vscode-vsix.zip`.
4. Extract `.vsix` file.
5. In VS Code: Extensions view → `...` → "Install from VSIX..." → select the file.
6. Verify functionality.

---

## Version Bumping

Before creating a release tag, bump the `version` in `package.json`. The release workflow reads that version to create both:
- The GitHub release tag (`v3.0.0`, `v3.1.0`, etc.)
- The attached VSIX filename (`hermes-ai-agent-3.0.0.vsix`)

Follow semantic versioning:
- Patch: bugfixes only (x.y.Z)
- Minor: new features (x.Y.0)
- Major: breaking changes (X.0.0)

---

## Troubleshooting

**Workflow fails at `npm ci`?**
- Check `package-lock.json` is present and up-to-date. If not, run `npm install` locally and commit the updated lockfile.

**VSIX artifact not generated?**
- Ensure `npm run package` completes successfully. The script uses `vsce package --no-dependencies`. The `@vscode/vsce` dependency is in `devDependencies` and will be installed by `npm ci`.

**Release creation fails?**
- Verify the `GITHUB_TOKEN` has `contents: write` permission (default in most repos). The workflow sets `permissions` appropriately.

---

## Notes

- The workflows do not run on forks unless the fork's Actions are enabled.
- Because we use `upload-artifact` on PRs, artifacts are stored for 14 days. GitHub retention limits apply depending on your plan.
- If you later decide to publish to the VS Code Marketplace via CI, add the `VSCE_TOKEN` secret and a publish step analogous to the one previously provided.
