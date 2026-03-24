---
name: bridge
description: Communicate with other Claude Code sessions via the agent-bridge broker. Use when the user wants to ask questions to other sessions, connect to a bridge group, list sessions, or manage the broker.
---

# /bridge — Cross-session communication

You are handling the `/bridge` command for the agent-bridge tool. This tool lets multiple Claude Code instances communicate without polluting each other's context.

## CRITICAL RULES

1. **Always read the broker port fresh** from `~/.agent-bridge/broker.port` before EVERY command. NEVER reuse a port number from earlier in the conversation — the broker may have restarted on a different port.
2. **For PID**, always determine the Claude Code process PID by running: `ps -o ppid= -p $$ | tr -d ' '` — this gets the parent process (Claude Code), not the temporary bash shell.
3. **For Claude Session UUID**, ALWAYS confirm with the user using AskUserQuestion before registering. Never guess or assume.

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

Register this session with the broker. This is a 3-step process:

**Step 1: Auto-detect the Claude Code session UUID.**

Run this to try to find the current session's UUID:

```bash
CLAUDE_PID=$(ps -o ppid= -p $$ | tr -d ' ')

# Method 1: Check if --resume UUID is in process command line args
DETECTED_UUID=$(ps -o args= -p $CLAUDE_PID 2>/dev/null | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)

# Method 2: Check which .jsonl file the Claude Code process has open
if [ -z "$DETECTED_UUID" ]; then
  DETECTED_UUID=$(lsof -p $CLAUDE_PID 2>/dev/null | grep '\.jsonl' | head -1 | awk '{print $NF}' | xargs basename 2>/dev/null | sed 's/.jsonl//')
fi

echo "Detected UUID: $DETECTED_UUID"

# Also list all sessions in this directory for reference
CWD_ENCODED=$(pwd | sed 's|/|-|g')
echo "All sessions in this directory:"
ls -lt ~/.claude/projects/${CWD_ENCODED}/*.jsonl 2>/dev/null | while read line; do
  file=$(echo "$line" | awk '{print $NF}')
  uuid=$(basename "$file" .jsonl)
  mod=$(echo "$line" | awk '{print $6, $7, $8}')
  echo "  $uuid (modified: $mod)"
done
```

**Step 2: ALWAYS confirm with the user using AskUserQuestion.**

You MUST use the AskUserQuestion tool to confirm the session UUID with the user. Do NOT skip this step.

- If a UUID was auto-detected: show it as the first option and ask the user to confirm
- If multiple sessions exist in the directory: show all of them as options with their modification times so the user can pick
- Always include an "Other" option in case the user wants to enter a UUID manually

Example: "Which Claude Code session is this?" with options showing the detected UUID(s).

Do NOT proceed until the user confirms.

**Step 3: Register with the confirmed UUID.**

```bash
BRIDGE_PORT=$(cat ~/.agent-bridge/broker.port)
CLAUDE_PID=$(ps -o ppid= -p $$ | tr -d ' ')
SESSION_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')

curl -s -X POST http://127.0.0.1:$BRIDGE_PORT/sessions/register \
  -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$SESSION_ID\",\"claudeSessionId\":\"<confirmed-uuid>\",\"pid\":$CLAUDE_PID,\"workingDirectory\":\"$(pwd)\",\"group\":\"<group>\",\"name\":\"<name>\"}"
```

Replace `<confirmed-uuid>` with the UUID the user confirmed in Step 2.
Replace `<group>` with the group name from the user's argument (default: "default").
Replace `<name>` with the `--name` value if provided, or omit the name field to auto-derive from directory.

Remember the SESSION_ID value for disconnect later.

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
