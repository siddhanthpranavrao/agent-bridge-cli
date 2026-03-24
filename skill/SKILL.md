---
name: bridge
description: Communicate with other Claude Code sessions via the agent-bridge broker. Use when the user wants to ask questions to other sessions, connect to a bridge group, list sessions, or manage the broker.
---

# /bridge — Cross-session communication

You are handling the `/bridge` command for the agent-bridge tool. This tool lets multiple Claude Code instances communicate without polluting each other's context.

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

First, read the broker port from `~/.agent-bridge/broker.port`. If the file doesn't exist, the broker is not running — start it with:

```bash
agent-bridge &
```

Or if installed locally: `npx agent-bridge &`

Then use `curl` to call the broker's HTTP API at `http://127.0.0.1:<port>`.

### connect [group] [--name name]

Register this session with the broker. You need to determine:
- **sessionId**: A unique ID for this session (use a UUID or generate one)
- **claudeSessionId**: This Claude Code session's ID (check the session info)
- **pid**: The current process PID
- **workingDirectory**: The current working directory
- **group**: From the argument (default: "default")
- **name**: From `--name` flag or auto-derived from directory name

```bash
curl -s -X POST http://127.0.0.1:<port>/sessions/register \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"<id>","claudeSessionId":"<claude-id>","pid":<pid>,"workingDirectory":"<cwd>","group":"<group>","name":"<name>"}'
```

### disconnect

```bash
curl -s -X POST http://127.0.0.1:<port>/sessions/deregister \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"<your-session-id>"}'
```

### ask [target] "question"

If target is provided:
```bash
curl -s -X POST http://127.0.0.1:<port>/ask \
  -H 'Content-Type: application/json' \
  -d '{"targetSession":"<target>","question":"<question>","group":"<group>"}'
```

If no target (auto-route):
```bash
curl -s -X POST http://127.0.0.1:<port>/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"<question>","group":"<group>"}'
```

Present the answer to the user. The response includes `answer`, `source`, and `fromFork` (whether it was answered from summary or required a fork).

### sessions

```bash
curl -s http://127.0.0.1:<port>/sessions?group=<group>
```

Present the sessions as a formatted list showing name, working directory, and status.

### status

```bash
curl -s http://127.0.0.1:<port>/status
```

Present the status in a readable format: uptime, connected sessions per group, active forks, and summary count.

### shutdown

```bash
curl -s -X POST http://127.0.0.1:<port>/shutdown
```

## Error handling

If the subcommand is not recognized, suggest the closest match. Available commands are: connect, disconnect, ask, sessions, status, shutdown.

For example, if the user types `/bridge asc`, respond with:
> Unknown command "asc". Did you mean "ask"?
> Available commands: connect, disconnect, ask, sessions, status, shutdown
