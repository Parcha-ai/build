#!/usr/bin/env bash
set -euo pipefail

RAW_MODEL="${LOCAL_MODE_RAW_MODEL:-qwen3-coder:30b}"
PRIMARY_TAG="${LOCAL_MODE_PRIMARY_TAG:-qwen3-coder-64k}"
SMALL_MODEL="${LOCAL_MODE_SMALL_MODEL:-qwen2.5-coder:1.5b}"
OLLAMA_CTX="${LOCAL_MODE_NUM_CTX:-65536}"
SKIP_INSTALL="${LOCAL_MODE_SKIP_INSTALL:-0}"
SKIP_AGENT_WARMUP="${LOCAL_MODE_SKIP_AGENT_WARMUP:-0}"

install_with_brew() {
  local command_name="$1"
  local brew_args="$2"
  local install_hint="$3"
  if command -v "$command_name" >/dev/null 2>&1; then
    return
  fi
  if [[ "$SKIP_INSTALL" == "1" ]]; then
    echo "Missing $command_name. $install_hint" >&2
    exit 1
  fi
  if ! command -v brew >/dev/null 2>&1; then
    echo "Missing $command_name and Homebrew is not installed. $install_hint" >&2
    exit 1
  fi
  echo "Installing $command_name..."
  # shellcheck disable=SC2086
  brew install $brew_args
}

install_with_brew ollama "--cask ollama-app" "Install Ollama first: brew install --cask ollama-app"
install_with_brew opencode "anomalyco/tap/opencode" "Install OpenCode first: brew install anomalyco/tap/opencode"

if [[ "$(uname -s)" == "Darwin" ]]; then
  open -a Ollama >/dev/null 2>&1 || true
fi

echo "Waiting for Ollama..."
for _ in {1..30}; do
  if ollama list >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
ollama list >/dev/null

echo "Pulling $RAW_MODEL..."
ollama pull "$RAW_MODEL"

echo "Pulling $SMALL_MODEL..."
ollama pull "$SMALL_MODEL"

modelfile="$(mktemp "${TMPDIR:-/tmp}/build-qwen3-modelfile.XXXXXX")"
cleanup() {
  rm -f "$modelfile"
}
trap cleanup EXIT

cat > "$modelfile" <<EOF
FROM $RAW_MODEL
PARAMETER num_ctx $OLLAMA_CTX
PARAMETER temperature 0.7
PARAMETER top_p 0.8
PARAMETER top_k 20
PARAMETER repeat_penalty 1.05
EOF

echo "Creating $PRIMARY_TAG with num_ctx=$OLLAMA_CTX..."
ollama create "$PRIMARY_TAG" -f "$modelfile"

echo "Ollama smoke test..."
ollama run "$PRIMARY_TAG" "say ok"

echo "OpenCode smoke test..."
OPENCODE_DISABLE_MODELS_FETCH=true \
OPENCODE_DISABLE_AUTOUPDATE=true \
opencode run "say ok" --model "ollama/$PRIMARY_TAG" --format json --dir "$PWD"

if [[ "$SKIP_AGENT_WARMUP" != "1" ]]; then
  warmup_dir="$(mktemp -d "${TMPDIR:-/tmp}/build-local-mode-warmup.XXXXXX")"
  cleanup_warmup() {
    rm -rf "$warmup_dir"
  }
  trap 'cleanup; cleanup_warmup' EXIT

  cat > "$warmup_dir/warmup.txt" <<'EOF'
LOCAL_MODE_WARMUP=1
EOF

  echo "OpenCode tool warm-up..."
  OPENCODE_DISABLE_MODELS_FETCH=true \
  OPENCODE_DISABLE_AUTOUPDATE=true \
  opencode run "Warm up offline tools in this directory. Read warmup.txt, search for LOCAL_MODE_WARMUP, write a file named warmup-result.txt containing exactly ok, run /bin/cat warmup-result.txt, then answer done." --model "ollama/$PRIMARY_TAG" --format json --dir "$warmup_dir"

  if [[ ! -f "$warmup_dir/warmup-result.txt" ]] || [[ "$(tr -d '\r\n' < "$warmup_dir/warmup-result.txt")" != "ok" ]]; then
    echo "OpenCode warm-up did not create warmup-result.txt with expected content." >&2
    exit 1
  fi
fi

echo
echo "Local Mode setup complete."
echo "In Build, enable Settings > Agents > Local Mode and keep Primary Model set to opencode:ollama/$PRIMARY_TAG."
