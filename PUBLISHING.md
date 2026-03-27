# Publishing Guide

This document covers how to publish `@pedi/chika-types` and `@pedi/chika-sdk` to npm, and how to release new server versions.

## First-Time Setup

### 1. Create an npm account and organization

1. Create an account at [npmjs.com](https://www.npmjs.com/signup)
2. Create the `@pedi` organization at [npmjs.com/org/create](https://www.npmjs.com/org/create)
3. Add any team members who need publish access to the organization

### 2. Generate an npm access token

1. Go to [npmjs.com/settings/tokens](https://www.npmjs.com/settings/~/tokens)
2. Click **Generate New Token** → **Granular Access Token**
3. Configure the token:
   - **Name**: `pedi-chika-github-actions`
   - **Expiration**: Choose based on your security policy (e.g., 90 days, 1 year)
   - **Packages and scopes**: Read and write, scoped to `@pedi`
4. Copy the generated token

### 3. Add the token to GitHub

1. Go to your GitHub repository → **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Name: `NPM_TOKEN`
4. Value: paste the npm token from the previous step

### 4. First publish (manual)

The first publish of each package must be done manually because npm requires the `--access public` flag for initial scoped package creation, and the organization must already exist.

```bash
# Install dependencies and build
bun install
bun run build

# Publish types first (SDK depends on it)
cd packages/types
npm publish --access public

# Update SDK dependency from workspace protocol to real version
cd ../sdk
# Temporarily replace workspace:* with the actual version
npm pkg set "dependencies.@pedi/chika-types=^1.0.0"
npm publish --access public

# Restore workspace protocol
npm pkg set "dependencies.@pedi/chika-types=workspace:*"
```

After the first publish, all subsequent releases are handled by GitHub Actions.

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
- Trigger the **Publish** workflow which builds and publishes both packages to npm

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
| **Release** | `release.yml` | Manual (workflow_dispatch) | Bump SDK + Types versions, tag, create GitHub release |
| **Release Server** | `release-server.yml` | Manual (workflow_dispatch) | Bump server version, tag, create GitHub release |
| **Publish** | `publish.yml` | Auto (on GitHub release `v*`) | Build and publish SDK + Types to npm |

## Troubleshooting

### "Package not found" on first publish

The `@pedi` npm organization must exist before publishing. Create it at [npmjs.com/org/create](https://www.npmjs.com/org/create).

### "You must sign up for private packages"

Scoped packages default to private. The publish workflow uses `--access public`, but if publishing manually, make sure to include the flag:

```bash
npm publish --access public
```

### npm token expired

Generate a new token on npmjs.com and update the `NPM_TOKEN` secret in GitHub repository settings.

### Publish workflow succeeded but packages not on npm

Check that the `NPM_TOKEN` secret is set and hasn't expired. Look at the workflow run logs in the Actions tab for specific error messages.

### Version mismatch between types and SDK

This shouldn't happen with the automated workflow. If it does, use the **custom version** field in the Release workflow to set both packages to the same version.
