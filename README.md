# agent-bridge-cli

Let multiple Claude Code instances communicate without polluting each other's context.

When you're working across multiple codebases — a frontend, a backend, a database layer — each Claude Code session builds deep context about its part of the system. **agent-bridge** lets those sessions talk to each other, so you can ask your frontend session about the backend's API without switching contexts or copy-pasting.

## How it works

A lightweight local broker runs on your machine. Claude Code sessions register with it. When one session needs information from another, the broker either answers from a cached knowledge summary (cheap) or forks the target session to get the answer (more expensive, but only when needed). Summaries get smarter over time as forks fill in knowledge gaps.

```
Frontend Session                    Backend Session
     |                                    |
     |  "What does /users expect?"        |
     |──────────> Broker ─────────────────>|
     |            │                        |
     |            ├─ Check summary (free)  |
     |            ├─ Fork if needed ($)    |
     |            └─ Enrich summary        |
     |<───────────┘                        |
     |  "POST { email, password }"         |
```

## Quick start

```bash
# 1. Install
npm install -g agent-bridge-cli

# 2. Inside Claude Code, connect to a group
/bridge connect myproject

# 3. Ask another session a question
/bridge ask backend "What does the /users endpoint expect?"
```

The broker starts automatically when you first run `/bridge connect`. If it doesn't start automatically, you can start it manually:

```bash
agent-bridge &
```

## Installation

### npm
```bash
npm install -g agent-bridge-cli
```

### bun
```bash
bun add -g agent-bridge-cli
```

### From source
```bash
git clone https://github.com/siddhanthpranavrao/agent-bridge-cli.git
cd agent-bridge-cli
bun install
bun run dev    # start the broker
```

The installer automatically adds the `/bridge` skill to `~/.claude/skills/bridge/` so it's available in all your Claude Code sessions.

## CLI Commands

Run these in your terminal to manage the broker:

```bash
agent-bridge              # Start the broker
agent-bridge stop         # Stop the broker
agent-bridge status       # Show broker status (sessions, groups, forks)
agent-bridge help         # Show help
```

## /bridge Commands

Run these inside Claude Code to interact with the bridge:

### `/bridge connect [group] [--name <name>]`

Connect the current Claude Code session to the broker.

```
/bridge connect myproject              # join "myproject" group
/bridge connect myproject --name api   # join with custom name
/bridge connect                        # join "default" group
```

Sessions are identified by name (auto-derived from directory, e.g. `/projects/hermes-svc` becomes `hermes-svc`). Names are sanitized to lowercase alphanumeric + hyphens. Duplicate names in the same group get auto-suffixed (`hermes-svc-2`).

### `/bridge ask [target] "question"`

Ask another session a question.

```
/bridge ask backend "What does the /users endpoint expect?"
/bridge ask "How does authentication work?"    # auto-routes to best session
```

**Targeted ask:** Specify which session to query. Supports exact name, session ID, or fuzzy matching (`bakend` finds `backend`).

**Auto-routed ask:** Omit the target and the broker ranks all sessions by keyword relevance and picks the best one.

The answer flow is tiered:
1. Try the session's knowledge summary (fast, no fork cost)
2. If summary can't answer, fork the session (uses Claude Agent SDK)
3. Enrich the summary with new knowledge from the fork (future queries are cheaper)

If neither summary nor fork can answer, you get an honest "unable to answer" — never a hallucinated response.

### `/bridge sessions`

List all connected sessions in your group.

```
/bridge sessions
```

### `/bridge status`

Show detailed broker info: uptime, connected sessions per group, active forks, summary count.

```
/bridge status
```

### `/bridge disconnect`

Remove the current session from the broker.

```
/bridge disconnect
```

### `/bridge shutdown`

Stop the broker. Cleans up all files.

```
/bridge shutdown
```

### Typo correction

Mistype a command and the broker suggests the closest match:

```
/bridge asc backend "question"
# Unknown command "asc". Did you mean "ask"?
# Available commands: connect, disconnect, ask, sessions, status, shutdown
```

## Architecture

```
~/.agent-bridge/
├── broker.pid          # Broker process ID
├── broker.port         # Port the broker is listening on
├── groups/
│   └── myproject/
│       └── sessions.json   # Registered sessions
└── summaries/
    └── <sessionId>.json    # Knowledge summaries
```

### Components

| Component | Description |
|-----------|-------------|
| **Broker Server** | HTTP server on localhost. Routes requests between sessions. |
| **Session Manager** | Tracks registered sessions by group. Fuzzy name matching. PID health checks. |
| **Summary Engine** | Generates knowledge dumps from session context. Keyword-based querying. Background enrichment. |
| **Fork Manager** | Forks Claude Code sessions via Agent SDK. Caches forks for 15 min (TTL). |
| **Storage** | File I/O scoped to `~/.agent-bridge/`. Path traversal protection. |
| **CLI Parser** | Subcommand validation with Levenshtein-based typo correction. |

### Broker lifecycle

- **Starts** when the first session connects (or manually via `agent-bridge &`)
- **Runs** as a local HTTP server on a random available port
- **Auto-shuts down** 30 minutes after the last session disconnects
- **Crash recovery:** On restart, detects stale PID files, reloads valid sessions, cleans up dead ones and orphaned summaries

## API Reference

The broker exposes these HTTP endpoints on `http://127.0.0.1:<port>`:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Quick health check (pid, port, uptime, status) |
| GET | `/status` | Detailed status (groups, sessions, forks, summaries) |
| POST | `/sessions/register` | Register a session |
| POST | `/sessions/deregister` | Remove a session |
| GET | `/sessions?group=<name>` | List sessions in a group |
| GET | `/sessions/groups` | List all groups |
| GET | `/sessions/resolve?q=<query>&group=<name>` | Fuzzy-find a session |
| POST | `/ask` | Ask a question (targeted or auto-routed) |
| POST | `/shutdown` | Stop the broker |

All endpoints accept/return JSON. Request validation uses Zod schemas. Error responses include descriptive messages.

## Configuration

All values have sensible defaults and are configurable:

| Setting | Default | Description |
|---------|---------|-------------|
| `port` | `0` (random) | Broker HTTP port |
| `host` | `127.0.0.1` | Broker bind address |
| `idleTimeoutMs` | 30 min | Auto-shutdown after last session disconnects |
| `shutdownGracePeriodMs` | 5 sec | Grace period for in-flight requests on shutdown |
| `timeoutMs` | 5 min | Max time for a fork to answer |
| `forkTtlMs` | 15 min | How long to cache a fork for reuse |
| `maxEntries` | 100 | Max knowledge entries per session summary |
| `maxEntrySizeChars` | 2000 | Max characters per summary entry |

### Data storage

All data is stored in `~/.agent-bridge/`. The broker never reads or writes outside this directory (enforced by path traversal protection).

## Project structure

```
src/
├── index.ts              # Entry point — starts broker, crash recovery
├── constants.ts          # All default values and paths
├── broker/
│   ├── server.ts         # HTTP server, routing, idle timeout
│   ├── types.ts          # BrokerConfig, BrokerStatus
│   └── recovery.ts       # Crash detection and cleanup
├── sessions/
│   ├── manager.ts        # Session registry, groups, fuzzy matching
│   ├── types.ts          # Session schemas (Zod)
│   └── routes.ts         # /sessions/* HTTP handlers
├── fork/
│   ├── manager.ts        # Fork execution, TTL cache
│   ├── types.ts          # Fork schemas and config
│   └── routes.ts         # /ask HTTP handler, tiered flow
├── summary/
│   ├── engine.ts         # Summary generation, querying, enrichment
│   ├── types.ts          # Summary schemas, injectable functions
│   └── llm.ts            # Default LLM functions (Agent SDK)
├── storage/
│   ├── storage.ts        # File I/O with path scoping
│   └── types.ts          # StorageOptions
├── cli/
│   └── commands.ts       # Subcommand parser, typo correction
└── utils/
    └── fuzzy.ts          # Levenshtein distance, fuzzy matching

skill/
└── SKILL.md              # Claude Code /bridge skill

tests/                    # Mirrors src/ structure
├── broker/
├── sessions/
├── fork/
├── summary/
├── cli/
└── utils/
```

## Testing

```bash
bun test
```

235 tests across 11 files covering:

- Broker lifecycle (start, stop, health, idle timeout, crash recovery)
- Session management (registration, groups, fuzzy resolution, name sanitization)
- Fork execution (mock forking, TTL cache, timeout handling)
- Summary engine (generation, keyword matching, enrichment, tiered flow)
- Auto-routing (session ranking, broadcasting, fallback)
- CLI parsing (subcommand validation, typo correction)
- Storage (path scoping, traversal protection)

All LLM calls are dependency-injected, so tests run without Claude Code or API access.

## Tech stack

- **TypeScript** (strict mode)
- **Bun** for development and testing
- **Node.js** compatible build output (via `bun build --target=node`)
- **Zod** for schema validation
- **Claude Agent SDK** for session forking
- Zero external runtime dependencies beyond Zod and the Agent SDK

## Uninstall

```bash
# Stop the broker first
agent-bridge stop

# Uninstall the package
npm uninstall -g agent-bridge-cli

# Clean up data and skill (may need manual removal)
rm -rf ~/.agent-bridge
rm -rf ~/.claude/skills/bridge
```

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b my-feature`
3. Make your changes
4. Run tests: `bun test`
5. Commit: `git commit -m "feat: description"`
6. Push: `git push origin my-feature`
7. Open a pull request

Please ensure all tests pass before submitting.

## License

MIT
