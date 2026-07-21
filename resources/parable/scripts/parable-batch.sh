#!/usr/bin/env bash
# Run two or more external Parable executors concurrently in one foreground
# Bash tool call. Build's Claude meta-harness uses this because separate Bash
# tool calls may be evaluated serially even when emitted in the same response.
set -uo pipefail

usage() {
  echo "usage: parable-batch.sh <workdir> <executor> <plan.md> [<executor> <plan.md> ...]" >&2
  exit 2
}

[[ $# -ge 5 ]] || usage
workdir=$1
shift
(( $# % 2 == 0 )) || usage
[[ -d "$workdir" ]] || { echo "parable-batch: workdir not found: $workdir" >&2; exit 2; }

script_dir=$(cd "$(dirname "$0")" && pwd)
runner=${PARABLE_RUN_SCRIPT:-"$script_dir/parable-run.sh"}
[[ -f "$runner" ]] || { echo "parable-batch: runner not found: $runner" >&2; exit 2; }

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/parable-batch.XXXXXX")
pids=()
labels=()
outputs=()

cleanup() {
  local pid
  for pid in "${pids[@]:-}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  rm -rf "$tmp_dir"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

batch_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "PARABLE BATCH  start=$batch_started  workdir=$workdir"

index=0
while [[ $# -gt 0 ]]; do
  executor=$1
  plan=$2
  shift 2
  [[ -f "$plan" ]] || { echo "parable-batch: plan not found: $plan" >&2; exit 2; }

  output="$tmp_dir/$index.out"
  labels+=("$executor")
  outputs+=("$output")
  bash "$runner" "$executor" "$plan" "$workdir" >"$output" 2>&1 &
  pids+=("$!")
  echo "STARTED executor=$executor pid=${pids[$index]} plan=$plan"
  index=$((index + 1))
done

status=0
for index in "${!pids[@]}"; do
  exit_code=0
  wait "${pids[$index]}" || exit_code=$?
  echo "RESULT executor=${labels[$index]} exit=$exit_code"
  cat "${outputs[$index]}"
  if [[ $exit_code -ne 0 ]]; then
    status=$exit_code
  fi
done

batch_finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "PARABLE BATCH  finish=$batch_finished  executors=${#pids[@]}  status=$status"
exit "$status"
