#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== First-time npm publish for @pedi/chika-types and @pedi/chika-sdk ==="
echo ""

# Check npm login
if ! npm whoami &>/dev/null; then
  echo "Not logged in to npm. Logging in..."
  npm login
fi

echo "Logged in as: $(npm whoami)"
echo ""

# Read current version from types
VERSION=$(node -p "require('$ROOT/packages/types/package.json').version")
echo "Publishing version: $VERSION"
echo ""

# Build
echo "=== Installing dependencies ==="
cd "$ROOT" && bun install

echo ""
echo "=== Building packages ==="
bun run build

# Publish types
echo ""
echo "=== Publishing @pedi/chika-types@$VERSION ==="
cd "$ROOT/packages/types" && npm publish --access public

# Publish SDK (swap workspace:* for real version, then restore)
echo ""
echo "=== Publishing @pedi/chika-sdk@$VERSION ==="
cd "$ROOT/packages/sdk"
npm pkg set "dependencies.@pedi/chika-types=^$VERSION"
npm publish --access public
npm pkg set "dependencies.@pedi/chika-types=workspace:*"

echo ""
echo "=== Done! ==="
echo "Both packages published successfully."
echo ""
echo "Next steps:"
echo "  1. Go to npmjs.com → @pedi/chika-types → Settings → Trusted Publisher"
echo "     Set: org=Pedi-Solutions-Inc, repo=chika, workflow=release.yml"
echo "  2. Repeat for @pedi/chika-sdk"
echo "  3. Future releases are automated via GitHub Actions"
