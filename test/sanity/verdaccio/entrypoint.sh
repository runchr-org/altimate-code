#!/bin/bash
# Verdaccio sanity entrypoint: publish to local registry → npm install -g → run sanity tests
# This runs at container startup (not during build) so Verdaccio is available.
set -euo pipefail

REGISTRY_URL="${REGISTRY_URL:-http://verdaccio:4873}"
BUILD_DIR="/home/testuser/build"
MAX_PUBLISH_RETRIES=3

echo "========================================"
echo "  Verdaccio Install Pipeline"
echo "  Registry: $REGISTRY_URL"
echo "========================================"

# ── Wait for Verdaccio ─────────────────────────────────────────
echo ""
echo "--- Waiting for Verdaccio ---"
for i in $(seq 1 60); do
  if curl -sf "$REGISTRY_URL/-/ping" >/dev/null 2>&1; then
    echo "  Verdaccio is ready"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "  FATAL: Verdaccio not reachable after 60s"
    exit 1
  fi
  sleep 1
done

# ── Configure npm to use Verdaccio ─────────────────────────────
REGISTRY_HOST="${REGISTRY_URL#http://}"
REGISTRY_HOST="${REGISTRY_HOST#https://}"
REGISTRY_HOST="${REGISTRY_HOST%/}"
cat > ~/.npmrc <<NPMRCEOF
registry=${REGISTRY_URL}
//${REGISTRY_HOST}/:_authToken=anonymous-sanity-token
always-auth=true
NPMRCEOF
echo "  Registry: $REGISTRY_URL"
echo "  .npmrc configured"
sed 's/\(_authToken=\).*/\1***REDACTED***/' ~/.npmrc

# ── Helper: npm publish with retry (matches publish.ts:130-143) ─
npm_publish_with_retry() {
  local dir="$1"
  local attempt
  for attempt in $(seq 1 "$MAX_PUBLISH_RETRIES"); do
    if (cd "$dir" && npm publish --registry "$REGISTRY_URL" 2>&1); then
      return 0
    fi
    local is_last=$((attempt == MAX_PUBLISH_RETRIES))
    if [ "$is_last" -eq 1 ]; then
      echo "  FATAL: npm publish failed after $MAX_PUBLISH_RETRIES attempts"
      return 1
    fi
    local wait=$((attempt * 5))
    echo "  Publish attempt $attempt failed, retrying in ${wait}s..."
    sleep "$wait"
  done
}

# ── Step 1: Publish platform binary package ────────────────────
echo ""
echo "--- Publishing platform binary ---"
cd "$BUILD_DIR/packages/opencode"
ARCH=$(uname -m | sed 's/x86_64/x64/' | sed 's/aarch64/arm64/')
BIN_PKG_DIR="dist/@altimateai/altimate-code-linux-${ARCH}"

if [ ! -d "$BIN_PKG_DIR" ]; then
  echo "  FATAL: No binary package for architecture: $ARCH ($(uname -m))"
  echo "  Expected: $BIN_PKG_DIR"
  exit 1
fi

# Sanitize version: replace ALL invalid semver chars, not just "/"
RAW_VERSION=$(node -e "console.log(require('./${BIN_PKG_DIR}/package.json').version)")
VERSION=$(printf '%s' "$RAW_VERSION" | sed 's|[^a-zA-Z0-9._-]|-|g')
BIN_NAME="@altimateai/altimate-code-linux-${ARCH}"
BIN_VERSION="$VERSION"
CORE_DEP=$(node -e "console.log(require('./package.json').dependencies['@altimateai/altimate-core'])")

echo "  Version: $VERSION"
echo "  Binary: $BIN_NAME@$BIN_VERSION"
echo "  Core dep: @altimateai/altimate-core@$CORE_DEP"

# Patch version in binary package.json to sanitized version (no shell injection — use env vars)
cd "$BIN_PKG_DIR"
VERSION="$VERSION" node -e "
  const p = require('./package.json');
  p.version = process.env.VERSION;
  require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
"
chmod -R 755 .
npm_publish_with_retry "$(pwd)"

# ── Step 2: Build and publish main altimate-code package ───────
echo ""
echo "--- Building main package ---"
PUBLISH_DIR=$(mktemp -d /tmp/altimate-publish-XXXXXX)

# Copy exactly what publish.ts copies
cd "$BUILD_DIR/packages/opencode"
cp -r bin "$PUBLISH_DIR/bin"
cp script/postinstall.mjs "$PUBLISH_DIR/postinstall.mjs"
cp -r "$BUILD_DIR/.opencode/skills" "$PUBLISH_DIR/skills"

# Bundle dbt-tools (matching publish.ts:57-78)
mkdir -p "$PUBLISH_DIR/dbt-tools/bin" "$PUBLISH_DIR/dbt-tools/dist"
cp "$BUILD_DIR/packages/dbt-tools/bin/altimate-dbt" "$PUBLISH_DIR/dbt-tools/bin/altimate-dbt"
cp "$BUILD_DIR/packages/dbt-tools/dist/index.js" "$PUBLISH_DIR/dbt-tools/dist/"
cp "$BUILD_DIR/packages/dbt-tools/dist/node_python_bridge.py" "$PUBLISH_DIR/dbt-tools/dist/"
echo '{"type":"module"}' > "$PUBLISH_DIR/dbt-tools/package.json"
# Copy altimate_python_packages if present (publish.ts:76-78)
if [ -d "$BUILD_DIR/packages/dbt-tools/dist/altimate_python_packages" ]; then
  cp -r "$BUILD_DIR/packages/dbt-tools/dist/altimate_python_packages" "$PUBLISH_DIR/dbt-tools/dist/"
fi

cp "$BUILD_DIR/LICENSE" "$PUBLISH_DIR/LICENSE"
cp "$BUILD_DIR/CHANGELOG.md" "$PUBLISH_DIR/CHANGELOG.md"
cp "$BUILD_DIR/README.md" "$PUBLISH_DIR/README.md"

# Write package.json matching what publish.ts produces (no shell injection — use env vars)
VERSION="$VERSION" CORE_DEP="$CORE_DEP" BIN_NAME="$BIN_NAME" BIN_VERSION="$BIN_VERSION" \
  PUBLISH_DIR="$PUBLISH_DIR" node -e "
const pkg = {
  name: 'altimate-code',
  version: process.env.VERSION,
  license: 'MIT',
  bin: { altimate: './bin/altimate', 'altimate-code': './bin/altimate-code' },
  scripts: { postinstall: 'bun ./postinstall.mjs || node ./postinstall.mjs' },
  dependencies: { '@altimateai/altimate-core': process.env.CORE_DEP },
  optionalDependencies: { [process.env.BIN_NAME]: process.env.BIN_VERSION },
  peerDependencies: {
    pg: '>=8', 'snowflake-sdk': '>=1', '@google-cloud/bigquery': '>=8',
    '@databricks/sql': '>=1', mysql2: '>=3', mssql: '>=11',
    oracledb: '>=6', duckdb: '>=1'
  },
  peerDependenciesMeta: {
    pg: {optional:true}, 'snowflake-sdk': {optional:true},
    '@google-cloud/bigquery': {optional:true}, '@databricks/sql': {optional:true},
    mysql2: {optional:true}, mssql: {optional:true}, oracledb: {optional:true},
    duckdb: {optional:true}
  }
};
require('fs').writeFileSync(
  require('path').join(process.env.PUBLISH_DIR, 'package.json'),
  JSON.stringify(pkg, null, 2) + '\n'
);
"

echo "--- Publishing main package ---"
chmod -R 755 "$PUBLISH_DIR"
npm_publish_with_retry "$PUBLISH_DIR"
echo "  Published altimate-code@$VERSION to $REGISTRY_URL"

# ── Step 3: Clean install as a real user ───────────────────────
echo ""
echo "--- npm install -g altimate-code ---"
# Wipe build artifacts — user starts fresh
rm -rf "$BUILD_DIR" "$PUBLISH_DIR"
cd /home/testuser

# Install to user-local prefix (testuser can't write /usr/local)
mkdir -p /home/testuser/.npm-global
npm config set prefix /home/testuser/.npm-global
export PATH="/home/testuser/.npm-global/bin:$PATH"
npm install -g "altimate-code@$VERSION" --registry "$REGISTRY_URL" 2>&1
echo ""
echo "  Installed: $(which altimate 2>/dev/null || echo 'NOT FOUND')"
echo "  Version: $(altimate --version 2>/dev/null || echo 'FAILED')"

# ── Step 4: Run sanity tests ──────────────────────────────────
echo ""
echo "========================================"
echo "  Running sanity tests against npm install"
echo "========================================"
exec /home/testuser/sanity/run.sh
