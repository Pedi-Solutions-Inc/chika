# Publishing Guide

This document covers how to publish `@pedi/chika-types` and `@pedi/chika-sdk` to npm, and how to release new server versions.

## First-Time Setup

### 1. Create an npm account and organization

1. Create an account at [npmjs.com](https://www.npmjs.com/signup)
2. Create the `@pedi` organization at [npmjs.com/org/create](https://www.npmjs.com/org/create)
3. Add any team members who need publish access to the organization

### 2. First publish (manual)

The first publish of each package must be done manually to create the packages on npm.

```bash
# Install dependencies and build
bun install
bun run build

# Publish types first (SDK depends on it)
cd packages/types
npm publish --access public

# Update SDK dependency from workspace protocol to real version
cd ../sdk
npm pkg set "dependencies.@pedi/chika-types=^1.0.0"
npm publish --access public

# Restore workspace protocol
npm pkg set "dependencies.@pedi/chika-types=workspace:*"
```

### 3. Configure trusted publishers

After the first publish, set up trusted publishing so GitHub Actions can publish without tokens.

For **each** package (`@pedi/chika-types` and `@pedi/chika-sdk`):

1. Go to [npmjs.com](https://www.npmjs.com) → your package → **Settings** → **Trusted Publisher**
2. Click **GitHub Actions**
3. Fill in:
   - **Organization or user**: your GitHub username or org
   - **Repository**: `pedi-chika`
   - **Workflow filename**: `release.yml`
4. Save

> **Note:** Trusted publishing requires npm CLI 11.5.1+ and Node 22.14.0+. The publish workflow is configured to use Node 22.

### 4. (Recommended) Restrict token access

Once trusted publishing is verified working:

1. Go to each package's **Settings** → **Publishing access**
2. Select **"Require two-factor authentication and disallow tokens"**
3. Save

This ensures packages can only be published via the trusted GitHub Actions workflow, eliminating the risk of leaked tokens.

## Automated Releases

### Releasing SDK + Types

Both `@pedi/chika-types` and `@pedi/chika-sdk` are always released together at the same version.

1. Go to **Actions** → **Release** → **Run workflow**
2. Select the **bump type**:
   - `patch` (1.0.0 → 1.0.1) — bug fixes, doc updates
   - `minor` (1.0.0 → 1.1.0) — new features, non-breaking additions
   - `major` (1.0.0 → 2.0.0) — breaking changes
3. Optionally enter a **custom version** (e.g., `2.0.0-beta.1`) to override the bump type
4. Click **Run workflow**

This will:
- Bump versions in `packages/types/package.json` and `packages/sdk/package.json`
- Add a row to `COMPATIBILITY.md`
- Commit, tag as `v1.1.0`, and push
- Create a GitHub release with auto-generated notes
- Trigger the **Publish** workflow which builds and publishes both packages to npm via OIDC

### Releasing the Server

The server is versioned independently.

1. Go to **Actions** → **Release Server** → **Run workflow**
2. Select the **bump type** (patch / minor / major) or enter a custom version
3. Click **Run workflow**

This will:
- Bump the version in `server/package.json`
- Add a row to `COMPATIBILITY.md`
- Commit, tag as `server-v1.1.0`, and push
- Create a GitHub release (not marked as latest, since package releases are primary)

The server is not published to npm — this workflow only tracks its version and compatibility.

## Versioning Strategy

### SDK + Types (lockstep)

- `@pedi/chika-types` and `@pedi/chika-sdk` always share the same version number
- A single release tag (e.g., `v1.2.0`) publishes both
- Follow [semver](https://semver.org/):
  - **Patch**: bug fixes, typos, internal refactors with no API change
  - **Minor**: new optional fields, new exports, non-breaking additions
  - **Major**: renamed/removed exports, changed type signatures, breaking schema changes

### Server (independent)

- Versioned separately with `server-v*` tags
- Version tracks deployable milestones, not npm releases

### Compatibility

`COMPATIBILITY.md` is automatically updated by both release workflows. It records which server version was current at the time of each SDK release and vice versa, so users can look up compatible version pairings.

## Workflows Overview

| Workflow | File | Trigger | Purpose |
|---|---|---|---|
| **Release** | `release.yml` | Manual (workflow_dispatch) | Bump versions, tag, create GitHub release, build and publish to npm via OIDC |
| **Release Server** | `release-server.yml` | Manual (workflow_dispatch) | Bump server version, tag, create GitHub release |

## How Publishing Authentication Works

The publish workflow uses **npm trusted publishing** (OIDC) instead of long-lived npm tokens. When the workflow runs:

1. GitHub Actions generates a short-lived OIDC token
2. npm verifies the token matches the trusted publisher config (repo + workflow filename)
3. npm exchanges it for a temporary publish token scoped to that single operation
4. The package is published — no secrets stored in GitHub

This is more secure than token-based auth because there are no credentials to leak, rotate, or manage.

## Troubleshooting

### "Package not found" on first publish

The `@pedi` npm organization must exist before publishing. Create it at [npmjs.com/org/create](https://www.npmjs.com/org/create).

### "You must sign up for private packages"

Scoped packages default to private. The publish workflow uses `--access public`, but if publishing manually, make sure to include the flag:

```bash
npm publish --access public
```

### ENEEDAUTH or "Unable to authenticate"

- Verify trusted publisher is configured for **both** packages on npmjs.com
- Check that the workflow filename is exactly `release.yml` (case-sensitive, including extension)
- Ensure the repository name and org/user match exactly
- Confirm the workflow has `id-token: write` permission (it does by default in our config)

### Publish workflow succeeded but packages not on npm

Check the workflow run logs in the Actions tab for specific error messages. If using trusted publishing, ensure the configuration on npmjs.com matches the repository and workflow.

### Version mismatch between types and SDK

This shouldn't happen with the automated workflow. If it does, use the **custom version** field in the Release workflow to set both packages to the same version.
