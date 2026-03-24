---
name: bridge
description: Communicate with other Claude Code sessions via the agent-bridge broker. Use when the user wants to ask questions to other sessions, connect to a bridge group, list sessions, or manage the broker.
---

# /bridge — Cross-session communication

You are handling the `/bridge` command for the agent-bridge tool. This tool lets multiple Claude Code instances communicate without polluting each other's context.

## CRITICAL RULES

1. **Always read the broker port fresh** from `~/.agent-bridge/broker.port` before EVERY command. NEVER reuse a port number from earlier in the conversation — the broker may have restarted on a different port.
2. **For PID**, always determine the Claude Code process PID by running: `ps -o ppid= -p $$ | tr -d ' '` — this gets the parent process (Claude Code), not the temporary bash shell.

## Arguments: $ARGUMENTS

Parse the first word as the subcommand. The rest are arguments for that subcommand.

## Available subcommands

- `connect [group] [--name <name>]` — Connect this session to the bridge broker
- `disconnect` — Disconnect this session from the broker
- `ask [target] "question"` — Ask another session a question (target is optional — omit to auto-route)
- `sessions` — List connected sessions in your group
- `status` — Show broker health and detailed info
- `shutdown` — Stop the broker

## How to execute

**Before every command**, read the broker port fresh:

```bash
BRIDGE_PORT=$(cat ~/.agent-bridge/broker.port 2>/dev/null)
```

If the file doesn't exist, the broker is not running — start it with:

```bash
agent-bridge &
sleep 1
BRIDGE_PORT=$(cat ~/.agent-bridge/broker.port)
```

Or if running from source: `bun run /path/to/agent-bridge/src/index.ts &`

Then use `curl` to call the broker's HTTP API at `http://127.0.0.1:$BRIDGE_PORT`.

### connect [group] [--name name]

Register this session with the broker. You need to determine:
- **sessionId**: Generate a UUID for this session (use `uuidgen` or similar)
- **claudeSessionId**: This Claude Code session's ID
- **pid**: The Claude Code process PID — get it with: `ps -o ppid= -p $$ | tr -d ' '`
- **workingDirectory**: The current working directory (`pwd`)
- **group**: From the argument (default: "default")
- **name**: From `--name` flag, or omit to auto-derive from directory name

```bash
BRIDGE_PORT=$(cat ~/.agent-bridge/broker.port)
CLAUDE_PID=$(ps -o ppid= -p $$ | tr -d ' ')
SESSION_ID=$(uuidgen)

curl -s -X POST http://127.0.0.1:$BRIDGE_PORT/sessions/register \
  -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$SESSION_ID\",\"claudeSessionId\":\"<claude-session-id>\",\"pid\":$CLAUDE_PID,\"workingDirectory\":\"$(pwd)\",\"group\":\"<group>\",\"name\":\"<name>\"}"
```

Remember the sessionId for disconnect later.

### disconnect

```bash
BRIDGE_PORT=$(cat ~/.agent-bridge/broker.port)
curl -s -X POST http://127.0.0.1:$BRIDGE_PORT/sessions/deregister \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"<your-session-id>"}'
```

### ask [target] "question"

Always read the port fresh before asking:

If target is provided:
```bash
BRIDGE_PORT=$(cat ~/.agent-bridge/broker.port)
curl -s -X POST http://127.0.0.1:$BRIDGE_PORT/ask \
  -H 'Content-Type: application/json' \
  -d '{"targetSession":"<target>","question":"<question>","group":"<group>"}'
```

If no target (auto-route):
```bash
BRIDGE_PORT=$(cat ~/.agent-bridge/broker.port)
curl -s -X POST http://127.0.0.1:$BRIDGE_PORT/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"<question>","group":"<group>"}'
```

Present the answer to the user. The response includes `answer`, `source`, and `fromFork` (whether it was answered from summary or required a fork).

### sessions

```bash
BRIDGE_PORT=$(cat ~/.agent-bridge/broker.port)
curl -s http://127.0.0.1:$BRIDGE_PORT/sessions?group=<group>
```

Present the sessions as a formatted list showing name, working directory, and status.

### status

```bash
BRIDGE_PORT=$(cat ~/.agent-bridge/broker.port)
curl -s http://127.0.0.1:$BRIDGE_PORT/status
```

Present the status in a readable format: uptime, connected sessions per group, active forks, and summary count.

### shutdown

```bash
BRIDGE_PORT=$(cat ~/.agent-bridge/broker.port)
curl -s -X POST http://127.0.0.1:$BRIDGE_PORT/shutdown
```

## Error handling

If the subcommand is not recognized, suggest the closest match. Available commands are: connect, disconnect, ask, sessions, status, shutdown.

For example, if the user types `/bridge asc`, respond with:
> Unknown command "asc". Did you mean "ask"?
> Available commands: connect, disconnect, ask, sessions, status, shutdown
