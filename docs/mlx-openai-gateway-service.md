# MLX Gateway LaunchAgent Service

This wraps the local MLX OpenAI-compatible gateway as a macOS `launchctl`
service so the process lifecycle is managed by LaunchAgent instead of the
interactive shell.

The LaunchAgent uses a generated self-contained runner under
`~/.openclaw/data/memory-mem0/mlx-gateway/launchd-runner.zsh` that executes
`python -m mlx_vlm.server` directly. It does not depend on the repo checkout
remaining accessible to background processes.

## Files

- launcher: [scripts/mlx-openai-gateway.zsh](/Users/Break/Documents/github/BreakDimbo/mem0-plugin-for-openclaw/scripts/mlx-openai-gateway.zsh)
- LaunchAgent manager: [scripts/mlx-openai-gateway-service.zsh](/Users/Break/Documents/github/BreakDimbo/mem0-plugin-for-openclaw/scripts/mlx-openai-gateway-service.zsh)

## Install

```bash
scripts/mlx-openai-gateway-service.zsh install
```

That will:

- write `~/Library/LaunchAgents/ai.openclaw.memory-mem0.mlx-gateway.plist`
- write `~/.openclaw/data/memory-mem0/mlx-gateway/launchd-runner.zsh`
- bootstrap it into `launchctl`
- enable `RunAtLoad` + `KeepAlive`
- run the local MLX server with the same tuned defaults used by
  [scripts/mlx-openai-gateway.zsh](/Users/Break/Documents/github/BreakDimbo/mem0-plugin-for-openclaw/scripts/mlx-openai-gateway.zsh)

## Manage

Start:

```bash
scripts/mlx-openai-gateway-service.zsh start
```

Stop:

```bash
scripts/mlx-openai-gateway-service.zsh stop
```

Restart:

```bash
scripts/mlx-openai-gateway-service.zsh restart
```

Status:

```bash
scripts/mlx-openai-gateway-service.zsh status
```

Uninstall:

```bash
scripts/mlx-openai-gateway-service.zsh uninstall
```

## Logs

LaunchAgent logs go to:

- `~/.openclaw/data/memory-mem0/mlx-gateway/launchd.out.log`
- `~/.openclaw/data/memory-mem0/mlx-gateway/launchd.err.log`

The gateway runner itself still writes its own runtime log file under the same
directory when invoked directly.

## Plugin Config

The LaunchAgent service does not change the plugin config shape. Keep using the
same OpenAI-compatible endpoint template:

- `apiBase`: `http://127.0.0.1:11435/v1`
- `apiKey`: `local-mlx`
- `model`: `mlx-community/gemma-4-26b-a4b-it-4bit`

Use [docs/examples/openclaw.mlx-gateway.jsonc](/Users/Break/Documents/github/BreakDimbo/mem0-plugin-for-openclaw/docs/examples/openclaw.mlx-gateway.jsonc) as the config source.
