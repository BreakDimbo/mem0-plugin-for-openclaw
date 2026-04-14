#!/bin/zsh

set -euo pipefail

SCRIPT_DIR=${0:A:h}
REPO_ROOT=${SCRIPT_DIR:h}

SERVICE_LABEL=${SERVICE_LABEL:-ai.openclaw.memory-mem0.mlx-gateway}
LAUNCH_AGENTS_DIR=${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}
PLIST_PATH="$LAUNCH_AGENTS_DIR/$SERVICE_LABEL.plist"
LOG_DIR=${LOG_DIR:-$HOME/.openclaw/data/memory-mem0/mlx-gateway}
STDOUT_PATH="$LOG_DIR/launchd.out.log"
STDERR_PATH="$LOG_DIR/launchd.err.log"
SERVICE_RUNNER_PATH="$LOG_DIR/launchd-runner.zsh"
VENV_PATH=${VENV_PATH:-$HOME/.venvs/mlx-vlm-gemma4}
PYTHON_BIN="$VENV_PATH/bin/python"
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
USER_UID=$(id -u)

usage() {
  cat <<EOF
Usage: ${0:t} <command>

Commands:
  install        Write LaunchAgent plist and bootstrap it
  uninstall      Boot out and remove the LaunchAgent plist
  start          Start the LaunchAgent
  stop           Stop the LaunchAgent
  restart        Restart the LaunchAgent
  status         Show launchctl status and recent logs
  plist          Print plist path

Environment overrides:
  SERVICE_LABEL      Default: $SERVICE_LABEL
  LAUNCH_AGENTS_DIR  Default: $LAUNCH_AGENTS_DIR
  LOG_DIR            Default: $LOG_DIR
  VENV_PATH          Default: $VENV_PATH
  MODEL              Default: $MODEL
  MLX_GATEWAY_PORT   Default: $MLX_GATEWAY_PORT
EOF
}

ensure_paths() {
  mkdir -p "$LAUNCH_AGENTS_DIR" "$LOG_DIR"
  if [[ ! -x "$PYTHON_BIN" ]]; then
    echo "Missing Python executable: $PYTHON_BIN" >&2
    exit 1
  fi
}

write_plist() {
  ensure_paths
  /bin/cat >"$SERVICE_RUNNER_PATH" <<EOF
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
    printf 'cmd+=(--trust-remote-code)\n' >>"$SERVICE_RUNNER_PATH"
  fi
  /bin/cat >>"$SERVICE_RUNNER_PATH" <<'EOF'
exec "$cmd[@]"
EOF
  chmod +x "$SERVICE_RUNNER_PATH"

  : >"$STDOUT_PATH"
  : >"$STDERR_PATH"

  /bin/cat >"$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>$SERVICE_LABEL</string>

    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>3</integer>
    <key>WorkingDirectory</key>
    <string>$LOG_DIR</string>

    <key>ProgramArguments</key>
    <array>
      <string>$SERVICE_RUNNER_PATH</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>$HOME</string>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
      <key>SERVICE_LABEL</key>
      <string>$SERVICE_LABEL</string>
      <key>PYTHONUNBUFFERED</key>
      <string>1</string>
    </dict>

    <key>StandardOutPath</key>
    <string>$STDOUT_PATH</string>
    <key>StandardErrorPath</key>
    <string>$STDERR_PATH</string>
  </dict>
</plist>
EOF
}

bootout_if_loaded() {
  launchctl bootout "gui/$USER_UID/$SERVICE_LABEL" >/dev/null 2>&1 || true
}

install_service() {
  write_plist
  bootout_if_loaded
  launchctl bootstrap "gui/$USER_UID" "$PLIST_PATH"
  launchctl enable "gui/$USER_UID/$SERVICE_LABEL"
  launchctl kickstart -k "gui/$USER_UID/$SERVICE_LABEL"
  echo "Installed LaunchAgent: $PLIST_PATH"
}

uninstall_service() {
  bootout_if_loaded
  rm -f "$PLIST_PATH"
  rm -f "$SERVICE_RUNNER_PATH"
  echo "Removed LaunchAgent: $PLIST_PATH"
}

start_service() {
  if [[ ! -f "$PLIST_PATH" ]]; then
    echo "LaunchAgent plist not found: $PLIST_PATH" >&2
    exit 1
  fi
  launchctl bootstrap "gui/$USER_UID" "$PLIST_PATH" >/dev/null 2>&1 || true
  launchctl enable "gui/$USER_UID/$SERVICE_LABEL"
  launchctl kickstart -k "gui/$USER_UID/$SERVICE_LABEL"
  echo "Started: $SERVICE_LABEL"
}

stop_service() {
  bootout_if_loaded
  echo "Stopped: $SERVICE_LABEL"
}

status_service() {
  echo "Label: $SERVICE_LABEL"
  echo "Plist: $PLIST_PATH"
  echo
  launchctl print "gui/$USER_UID/$SERVICE_LABEL" 2>/dev/null | sed -n '1,80p' || echo "Service not loaded"
  echo
  if [[ -f "$STDOUT_PATH" ]]; then
    echo "Recent stdout:"
    tail -n 20 "$STDOUT_PATH"
    echo
  fi
  if [[ -f "$STDERR_PATH" ]]; then
    echo "Recent stderr:"
    tail -n 20 "$STDERR_PATH"
  fi
}

cmd=${1:-}

case "$cmd" in
  install) install_service ;;
  uninstall) uninstall_service ;;
  start) start_service ;;
  stop) stop_service ;;
  restart) stop_service; start_service ;;
  status) status_service ;;
  plist) echo "$PLIST_PATH" ;;
  ""|-h|--help|help) usage ;;
  *)
    echo "Unknown command: $cmd" >&2
    usage >&2
    exit 1
    ;;
esac
