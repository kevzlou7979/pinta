# pinta-companion

Local companion server for [Pinta](https://github.com/kevzlou7979/pinta) —
the visual annotation tool that hands UI changes to a coding agent
(Claude Code, Cursor, Aider, anything MCP-compatible).

## Install / use

No global install needed. From your project root:

```bash
npx pinta-companion .
```

That starts an HTTP + WebSocket server on `http://127.0.0.1:7878` and writes
annotation sessions to `.pinta/sessions/{id}.json` (with the composited PNG
alongside as `{id}.png`).

Pair it with the [Pinta Chrome extension](https://github.com/kevzlou7979/pinta)
(the side panel will say **Connected** when it finds the companion).

## MCP bridge

For Cursor / Cline / Continue / Zed, this package also ships `pinta-mcp` —
an MCP stdio server that proxies to the running companion. Wire it into
your agent's MCP config:

```json
{
  "mcpServers": {
    "pinta": {
      "command": "npx",
      "args": ["-y", "pinta-companion", "pinta-mcp"]
    }
  }
}
```

(Exposed as a separate bin in this same package — `npx pinta-mcp` works too
once installed.)

## CLI flags

```
pinta-companion [--project <path>] [--port 7878] [--verbose]
```

| Flag | Default |
|---|---|
| `--project` (`-p`) | cwd |
| `--port` | 7878 |
| `--verbose` (`-v`) | off |

## License

MIT — see [the repo](https://github.com/kevzlou7979/pinta) for source and
the full design.
