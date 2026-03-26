#!/bin/bash
# bootstrap-vm.sh — One-time VM setup. Run on the VM after provisioning.
set -euo pipefail

echo "=== Bootstrapping ac-autofix-vm ==="

# ── System packages ──────────────────────────────────────────

echo "--- Installing system packages ---"
sudo apt-get update -qq
sudo apt-get install -y -qq \
  build-essential curl git jq sqlite3 \
  python3 python3-pip python3-venv \
  docker.io docker-compose-v2 \
  unzip

# Add user to docker group
sudo usermod -aG docker "$USER"

# ── Node.js 22 via fnm ──────────────────────────────────────

echo "--- Installing Node.js 22 ---"
curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell
export PATH="$HOME/.local/share/fnm:$PATH"
eval "$(fnm env)"
fnm install 22
fnm default 22

# Add fnm to bashrc
if ! grep -q "fnm env" ~/.bashrc; then
  cat >> ~/.bashrc <<'BASHRC'
export PATH="$HOME/.local/share/fnm:$PATH"
eval "$(fnm env)"
BASHRC
fi

# ── Bun ──────────────────────────────────────────────────────

echo "--- Installing Bun ---"
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"

# ── Codex CLI ────────────────────────────────────────────────

echo "--- Installing Codex CLI ---"
npm install -g @openai/codex

# ── GitHub CLI ───────────────────────────────────────────────

echo "--- Installing GitHub CLI ---"
(type -p wget >/dev/null || (sudo apt update && sudo apt-get install wget -y)) \
  && sudo mkdir -p -m 755 /etc/apt/keyrings \
  && out=$(mktemp) && wget -nv -O"$out" https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  && cat "$out" | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
  && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli-stable.list > /dev/null \
  && sudo apt update -qq \
  && sudo apt install gh -y -qq

# ── Azure CLI ────────────────────────────────────────────────

echo "--- Installing Azure CLI ---"
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash

# ── Clone repo ───────────────────────────────────────────────

echo "--- Cloning altimate-code ---"
if [ ! -d ~/altimate-code ]; then
  gh repo clone AltimateAI/altimate-code ~/altimate-code
fi

cd ~/altimate-code
bun install

# ── Git identity ─────────────────────────────────────────────

echo "--- Configuring git ---"
git config --global user.name "altimate-autofix-bot"
git config --global user.email "autofix@altimateai.com"

# ── Slack tools ──────────────────────────────────────────────

echo "--- Setting up Slack tools ---"
if [ ! -d ~/slack-tools ]; then
  mkdir -p ~/slack-tools
  echo "NOTE: You need to copy slack-tools (send_reply.py, get_channel.py) to ~/slack-tools/"
  echo "And create a venv: cd ~/slack-tools && python3 -m venv .venv && .venv/bin/pip install slack-sdk"
fi

# ── Directories ──────────────────────────────────────────────

mkdir -p ~/autofix-logs
mkdir -p ~/altimate-code/data/autofix

# ── Environment file template ────────────────────────────────

if [ ! -f ~/.env ]; then
  cat > ~/.env <<'ENV'
# Fill in these values:
OPENAI_API_KEY=
GITHUB_TOKEN=
# OPENROUTER_API_KEY=
# SLACK_CHANNEL_ID=
ENV
  echo "IMPORTANT: Edit ~/.env and fill in API keys"
fi

# ── Systemd service ──────────────────────────────────────────

echo "--- Installing systemd service ---"
sudo cp ~/altimate-code/script/autofix/ac-autofix.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable ac-autofix

# ── Crontab ──────────────────────────────────────────────────

echo "--- Installing crontab ---"
crontab ~/altimate-code/script/autofix/crontab

# ── Codex config ─────────────────────────────────────────────

echo "--- Configuring Codex CLI ---"
mkdir -p ~/.codex
cat > ~/.codex/config.toml <<'TOML'
model = "gpt-5.4"
model_reasoning_effort = "xhigh"
personality = "pragmatic"

[projects."/home/kulvir/altimate-code"]
trust_level = "trusted"
TOML

echo ""
echo "=== Bootstrap complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit ~/.env with your API keys"
echo "  2. Run: gh auth login"
echo "  3. Run: az login"
echo "  4. Copy slack-tools to ~/slack-tools/ and set SLACK_CHANNEL_ID in ~/.env"
echo "  5. Start daemon: sudo systemctl start ac-autofix"
echo "  6. Check status: sudo systemctl status ac-autofix"
echo "  7. View logs: tail -f ~/autofix-logs/daemon.log"
