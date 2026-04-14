#!/bin/zsh

set -euo pipefail

SCRIPT_NAME=${0:t}

MLX_GATEWAY_HOME=${MLX_GATEWAY_HOME:-$HOME/.openclaw/data/memory-mem0/mlx-gateway}
VENV_PATH=${VENV_PATH:-$HOME/.venvs/mlx-vlm-gemma4}
MODEL=${MODEL:-mlx-community/gemma-4-26b-a4b-it-4bit}
MLX_GATEWAY_BIND_HOST=${MLX_GATEWAY_BIND_HOST:-127.0.0.1}
MLX_GATEWAY_PUBLIC_HOST=${MLX_GATEWAY_PUBLIC_HOST:-127.0.0.1}
MLX_GATEWAY_PORT=${MLX_GATEWAY_PORT:-11435}
PREFILL_STEP_SIZE=${PREFILL_STEP_SIZE:-512}
KV_BITS=${KV_BITS:-4.0}
KV_QUANT_SCHEME=${KV_QUANT_SCHEME:-turboquant}
KV_GROUP_SIZE=${KV_GROUP_SIZE:-64}
QUANTIZED_KV_START=${QUANTIZED_KV_START:-5000}
TRUST_REMOTE_CODE=${TRUST_REMOTE_CODE:-0}

PID_FILE="$MLX_GATEWAY_HOME/mlx-openai-gateway.pid"
LOG_FILE="$MLX_GATEWAY_HOME/mlx-openai-gateway.log"
BASE_URL="http://$MLX_GATEWAY_PUBLIC_HOST:$MLX_GATEWAY_PORT"
API_BASE="$BASE_URL/v1"
PYTHON_BIN="$VENV_PATH/bin/python"

usage() {
  cat <<EOF
Usage: $SCRIPT_NAME <command>

Commands:
  run                    Run the gateway in the foreground
  start                  Start the local MLX OpenAI-compatible gateway
  stop                   Stop the gateway process
  restart                Restart the gateway process
  status                 Show process state and /health response
  unload                 Unload the currently cached model from memory
  logs                   Tail the gateway log
  url                    Print the OpenAI-compatible base URL
  print-config           Print the recommended plugin config snippet
  print-config-mem0      Print the experimental mem0.oss.llm snippet

Environment overrides:
  VENV_PATH              Default: $VENV_PATH
  MODEL                  Default: $MODEL
  MLX_GATEWAY_BIND_HOST  Default: $MLX_GATEWAY_BIND_HOST
  MLX_GATEWAY_PUBLIC_HOST Default: $MLX_GATEWAY_PUBLIC_HOST
  MLX_GATEWAY_PORT       Default: $MLX_GATEWAY_PORT
  PREFILL_STEP_SIZE      Default: $PREFILL_STEP_SIZE
  KV_BITS                Default: $KV_BITS
  KV_QUANT_SCHEME        Default: $KV_QUANT_SCHEME
  KV_GROUP_SIZE          Default: $KV_GROUP_SIZE
  QUANTIZED_KV_START     Default: $QUANTIZED_KV_START
  TRUST_REMOTE_CODE      Default: $TRUST_REMOTE_CODE
  MLX_GATEWAY_HOME       Default: $MLX_GATEWAY_HOME
EOF
}

require_python() {
  if [[ ! -x "$PYTHON_BIN" ]]; then
    echo "Missing Python executable: $PYTHON_BIN" >&2
    echo "Install mlx-vlm into a Python 3.12 venv first, or export VENV_PATH." >&2
    exit 1
  fi
}

ensure_home() {
  mkdir -p "$MLX_GATEWAY_HOME"
}

read_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid=$(<"$PID_FILE")
  [[ -n "$pid" ]] || return 1
  print -r -- "$pid"
}

is_running() {
  local pid
  pid=$(read_pid) || return 1
  kill -0 "$pid" 2>/dev/null
}

wait_for_health() {
  local attempts=${1:-60}
  local i
  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

run_gateway() {
  require_python
  local -a cmd
  cmd=(
    "$PYTHON_BIN" -m mlx_vlm.server
    --model "$MODEL"
    --host "$MLX_GATEWAY_BIND_HOST"
    --port "$MLX_GATEWAY_PORT"
    --prefill-step-size "$PREFILL_STEP_SIZE"
    --kv-bits "$KV_BITS"
    --kv-quant-scheme "$KV_QUANT_SCHEME"
    --kv-group-size "$KV_GROUP_SIZE"
    --quantized-kv-start "$QUANTIZED_KV_START"
  )
  if [[ "$TRUST_REMOTE_CODE" == "1" ]]; then
    cmd+=(--trust-remote-code)
  fi
  exec "$cmd[@]"
}

start_gateway() {
  require_python
  ensure_home

  if is_running; then
    echo "Gateway already running (pid $(read_pid))"
    echo "$API_BASE"
    return 0
  fi

  rm -f "$PID_FILE"

  local launcher_script="$MLX_GATEWAY_HOME/run-gateway.sh"
  cat >"$launcher_script" <<EOF
#!/bin/zsh
set -euo pipefail
cmd=(
  "$PYTHON_BIN" -m mlx_vlm.server
  --model "$MODEL"
  --host "$MLX_GATEWAY_BIND_HOST"
  --port "$MLX_GATEWAY_PORT"
  --prefill-step-size "$PREFILL_STEP_SIZE"
  --kv-bits "$KV_BITS"
  --kv-quant-scheme "$KV_QUANT_SCHEME"
  --kv-group-size "$KV_GROUP_SIZE"
  --quantized-kv-start "$QUANTIZED_KV_START"
)
EOF
  if [[ "$TRUST_REMOTE_CODE" == "1" ]]; then
    printf 'cmd+=(--trust-remote-code)\n' >>"$launcher_script"
  fi
  printf 'exec "$cmd[@]"\n' >>"$launcher_script"
  chmod +x "$launcher_script"

  nohup "$launcher_script" >"$LOG_FILE" 2>&1 < /dev/null &
  local pid=$!
  print -r -- "$pid" >"$PID_FILE"

  if wait_for_health 90; then
    echo "Gateway started: pid=$pid url=$API_BASE"
    return 0
  fi

  echo "Gateway failed to become healthy. Recent log:" >&2
  tail -n 40 "$LOG_FILE" >&2 || true
  rm -f "$PID_FILE"
  exit 1
}

stop_gateway() {
  local pid
  pid=$(read_pid) || {
    echo "Gateway is not running"
    return 0
  }

  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    local i
    for ((i = 1; i <= 20; i++)); do
      if ! kill -0 "$pid" 2>/dev/null; then
        rm -f "$PID_FILE"
        echo "Gateway stopped"
        return 0
      fi
      sleep 1
    done
    kill -9 "$pid" 2>/dev/null || true
  fi

  rm -f "$PID_FILE"
  echo "Gateway stopped"
}

status_gateway() {
  if is_running; then
    echo "running pid=$(read_pid) url=$API_BASE model=$MODEL"
  else
    echo "stopped url=$API_BASE model=$MODEL"
  fi

  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    curl -fsS "$BASE_URL/health"
    echo
  fi
}

unload_gateway() {
  curl -fsS -X POST "$BASE_URL/unload"
  echo
}

print_config() {
  cat <<EOF
// Recommended: route plugin-owned LLM calls to the local MLX gateway.
// Note: classifier + llmGate require a non-empty apiKey in the current plugin
// implementation even for local services, so use a harmless placeholder.
{
  "classifier": {
    "enabled": true,
    "apiBase": "$API_BASE",
    "apiKey": "local-mlx",
    "model": "$MODEL"
  },
  "core": {
    "llmGate": {
      "enabled": true,
      "apiBase": "$API_BASE",
      "apiKey": "local-mlx",
      "model": "$MODEL",
      "maxTokensPerBatch": 4000,
      "timeoutMs": 60000
    },
    "consolidation": {
      "llm": {
        "enabled": true,
        "apiBase": "$API_BASE",
        "apiKey": "local-mlx",
        "model": "$MODEL",
        "timeoutMs": 30000,
        "maxBatchSize": 20
      }
    }
  }
}
EOF
}

print_config_mem0() {
  cat <<EOF
// Experimental: mem0.oss.llm through the same MLX gateway.
// Recommended only with mem0.enableGraph=false.
{
  "mem0": {
    "enableGraph": false,
    "oss": {
      "llm": {
        "provider": "openai",
        "config": {
          "baseURL": "$API_BASE",
          "apiKey": "local-mlx",
          "model": "$MODEL"
        }
      }
    }
  }
}
EOF
}

command=${1:-}

case "$command" in
  run) run_gateway ;;
  start) start_gateway ;;
  stop) stop_gateway ;;
  restart) stop_gateway; start_gateway ;;
  status) status_gateway ;;
  unload) unload_gateway ;;
  logs) ensure_home; tail -f "$LOG_FILE" ;;
  url) echo "$API_BASE" ;;
  print-config) print_config ;;
  print-config-mem0) print_config_mem0 ;;
  ""|-h|--help|help) usage ;;
  *)
    echo "Unknown command: $command" >&2
    usage >&2
    exit 1
    ;;
esac
