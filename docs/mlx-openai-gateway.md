# MLX OpenAI-Compatible Gateway for memory-mem0

This setup keeps the plugin code unchanged and adds a local MLX gateway that
matches the plugin's existing OpenAI-compatible LLM integration shape.

## What It Covers

Recommended coverage:

- `classifier`
- `core.llmGate`
- `core.consolidation.llm`

Experimental coverage:

- `mem0.oss.llm`

## Why This Works

The current plugin implementation sends standard OpenAI-compatible
`/chat/completions` requests from these code paths:

- `classifier.ts`
- `core-admission.ts`
- `consolidation/llm-consolidator.ts`

`mlx-vlm` ships a local HTTP server that exposes:

- `/chat/completions`
- `/v1/chat/completions`
- `/responses`
- `/v1/models`

That makes it a drop-in local endpoint for the plugin's text-only LLM usages.

## Important Compatibility Note

The plugin does **not** treat every local endpoint like Ollama.

- `classifier` skips entirely when `apiKey` is empty.
- `core.llmGate` skips when `apiKey` is empty unless the endpoint is exactly
  local Ollama on port `11434`.

Because this MLX gateway runs on a different port by default, set a harmless
placeholder such as `"local-mlx"` for `classifier.apiKey` and
`core.llmGate.apiKey`.

## Recommended Runtime

This repository now includes:

- launcher script: [scripts/mlx-openai-gateway.zsh](/Users/Break/Documents/github/BreakDimbo/mem0-plugin-for-openclaw/scripts/mlx-openai-gateway.zsh)
- config example: [docs/examples/openclaw.mlx-gateway.jsonc](/Users/Break/Documents/github/BreakDimbo/mem0-plugin-for-openclaw/docs/examples/openclaw.mlx-gateway.jsonc)

Default runtime values used by the launcher:

- model: `mlx-community/gemma-4-26b-a4b-it-4bit`
- host: `127.0.0.1`
- port: `11435`
- `--kv-bits 4.0`
- `--kv-quant-scheme turboquant`
- `--prefill-step-size 512`

These defaults came from the local benchmark we ran for this machine.

## Start / Stop

Start the gateway:

```bash
scripts/mlx-openai-gateway.zsh start
```

Check status:

```bash
scripts/mlx-openai-gateway.zsh status
```

Stop the gateway:

```bash
scripts/mlx-openai-gateway.zsh stop
```

Unload the loaded model but keep the process alive:

```bash
scripts/mlx-openai-gateway.zsh unload
```

Tail logs:

```bash
scripts/mlx-openai-gateway.zsh logs
```

## Print Ready-To-Paste Config

Recommended plugin-owned LLM paths:

```bash
scripts/mlx-openai-gateway.zsh print-config
```

Experimental `mem0.oss.llm` snippet:

```bash
scripts/mlx-openai-gateway.zsh print-config-mem0
```

## Experimental mem0 Notes

`mem0.oss.llm` is possible through the same local gateway, but keep the scope
explicitly limited:

- prefer `mem0.enableGraph=false`
- treat graph/tool-heavy paths as unverified
- validate your actual `mem0` write/search flow before relying on it in daily use

Why it is marked experimental:

- `mem0` may rely on structured-output and tool-related behaviors that are more
  demanding than the plugin's own text-only paths
- this repository patches some provider quirks in `backends/free-text/mem0.ts`,
  but does not guarantee that every mem0 graph path behaves identically against
  a local MLX server

## Suggested Rollout

1. Start the local MLX gateway.
2. Apply only the recommended `classifier` + `llmGate` + `consolidation.llm`
   config.
3. Verify recall/capture/consolidation behavior.
4. Only then try the experimental `mem0.oss.llm` override if you still want a
   more local stack.
