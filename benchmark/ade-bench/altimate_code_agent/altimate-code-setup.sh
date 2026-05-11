#!/bin/bash
set -e

echo "Setup Altimate Code (local build)"

node --version
npm --version

LOCAL_TARBALL="/installed-agent/altimate-code-local.tgz"
if [[ -f "$LOCAL_TARBALL" ]]; then
  echo "Installing altimate-code from local tarball: $LOCAL_TARBALL"
  npm install -g --no-audit --no-fund "$LOCAL_TARBALL"
  # Pick the right per-arch binary the build script staged.
  PKG_BIN_DIR="$(npm root -g)/altimate-code/bin"
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64)   SRC="$PKG_BIN_DIR/.altimate-code-x64" ;;
    aarch64|arm64)  SRC="$PKG_BIN_DIR/.altimate-code-arm64" ;;
    *) echo "unsupported arch: $ARCH" >&2; exit 1 ;;
  esac
  if [[ ! -f "$SRC" ]]; then
    echo "missing per-arch binary $SRC" >&2; exit 1
  fi
  cp "$SRC" "$PKG_BIN_DIR/.altimate-code"
  cp "$SRC" "$PKG_BIN_DIR/.altimate"
  chmod 755 "$PKG_BIN_DIR/.altimate-code" "$PKG_BIN_DIR/.altimate"
else
  echo "Local tarball not staged; falling back to latest published"
  npm install -g --no-audit --no-fund @altimateai/altimate-code@latest
fi

altimate-code --version

# Configure Azure AI Foundry provider for Kimi-K2.6 (or any deployment named via
# AZURE_DEPLOYMENT_NAME). The Foundry MaaS endpoint serves an OpenAI-compatible
# route at /openai/v1, with api-key header auth.
CONFIG_DIR="$HOME/.config/altimate-code"
mkdir -p "$CONFIG_DIR"

# Build the providers JSON dynamically — register only providers whose env vars
# are present. Both share the openai-compatible runtime.
PROVIDERS=""

if [[ -n "${AZURE_RESOURCE_NAME:-}" && -n "${AZURE_API_KEY:-}" ]]; then
  DEPLOYMENT="${AZURE_DEPLOYMENT_NAME:-Kimi-K2.6}"
  PROVIDERS+=$(cat <<EOF
    "azure-foundry": {
      "name": "Azure AI Foundry",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://${AZURE_RESOURCE_NAME}.services.ai.azure.com/openai/v1",
        "headers": { "api-key": "${AZURE_API_KEY}" }
      },
      "models": {
        "${DEPLOYMENT}": {
          "name": "${DEPLOYMENT}",
          "tool_call": true,
          "limit": { "context": 200000, "output": 16384 },
          "cost": { "input": 0.60, "output": 2.50, "cache_read": 0.15 }
        }
      }
    }
EOF
)
fi

if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
  OR_MODEL_ID="${OPENROUTER_MODEL_ID:-moonshotai/kimi-k2.6-20260420}"
  [[ -n "$PROVIDERS" ]] && PROVIDERS+=","
  PROVIDERS+=$(cat <<EOF
    "openrouter": {
      "name": "OpenRouter",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://openrouter.ai/api/v1",
        "headers": { "Authorization": "Bearer ${OPENROUTER_API_KEY}" }
      },
      "models": {
        "${OR_MODEL_ID}": {
          "name": "${OR_MODEL_ID}",
          "tool_call": true,
          "limit": { "context": 262144, "output": 16384 },
          "cost": { "input": 0.75, "output": 3.50 }
        }
      }
    }
EOF
)
fi

if [[ -n "$PROVIDERS" ]]; then
  cat > "$CONFIG_DIR/altimate-code.json" <<EOF
{
  "\$schema": "https://altimate.ai/config.json",
  "provider": {
${PROVIDERS}
  }
}
EOF
  echo "Wrote altimate-code config; providers registered:"
  grep -oE '"(azure-foundry|openrouter)":' "$CONFIG_DIR/altimate-code.json" | tr -d '":' | sed 's/^/  - /'
else
  echo "WARN: neither AZURE_API_KEY nor OPENROUTER_API_KEY set; skipping provider config"
fi

echo "Installed Altimate Code"
