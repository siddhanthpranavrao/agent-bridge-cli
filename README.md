# agent-bridge-cli

Let multiple Claude Code instances communicate without polluting each other's context.

When you're working across multiple codebases — a frontend, a backend, a database layer — each Claude Code session builds deep context about its part of the system. **agent-bridge** lets those sessions talk to each other, so you can ask your frontend session about the backend's API without switching contexts or copy-pasting.

## Quick start

```bash
# 1. Install
npm install -g agent-bridge-cli

# 2. In your frontend Claude Code session
/bridge connect myproject --name frontend

# 3. In your backend Claude Code session
/bridge connect myproject --name backend

# 4. From the frontend, ask the backend a question
/bridge ask backend "What does the /users endpoint expect?"

# 5. Ask multiple sessions at once
/bridge ask backend,database "What's the user schema?"

# 6. Or ask all sessions in the group
/bridge ask --all "How does a request flow end to end?"
```

The `--name` flag is optional. If you don't provide it, the name is either:
- **Inferred by Claude Code** from your conversation context (e.g., if you said "focus on the frontend", Claude Code may name the session `frontend` automatically)
- **Auto-derived** from your working directory (e.g., `/projects/acme-api` becomes `acme-api`)

> Want to understand groups and names better? See [Groups, Sessions, and Names](#groups-sessions-and-names) below.

The broker starts automatically when you first run `/bridge connect`. If it doesn't start automatically, you can start it manually with `agent-bridge &`.

## Groups, Sessions, and Names

Before using agent-bridge, you need to understand three concepts:

### Groups

A **group** ties related Claude Code sessions together. Only sessions in the same group can talk to each other. Think of it as your project name.

You choose the group name when you connect: `/bridge connect my-project`

Sessions in different groups are completely isolated — your work project sessions can't see your side project sessions.

### Session names

A **name** is how you refer to a session when asking it questions. It's auto-derived from your working directory:

- Working in `/projects/acme-api` → name becomes `acme-api`
- Working in `/projects/frontend-app` → name becomes `frontend-app`

You can override it: `/bridge connect my-project --name backend`

Then ask it by name: `/bridge ask backend "how does auth work?"`

If two sessions have the same directory name in the same group, the second one gets auto-suffixed: `acme-api`, `acme-api-2`.

### Example: Different repositories

You have a frontend and backend in separate repos:

```
Terminal 1: claude (in /projects/acme-web)
  → /bridge connect acme --name frontend

Terminal 2: claude (in /projects/acme-api)
  → /bridge connect acme --name backend

Terminal 1:
  → /bridge ask backend "What does the /users endpoint expect?"
  ✓ "POST /users expects { email: string, password: string }..."
```

### Example: Same repository, different focus areas

You have one monorepo but two sessions exploring different parts:

```
Terminal 1: claude --resume <session-1> (in /projects/acme-app)
  → /bridge connect acme --name frontend
  (this session has been exploring the React components)

Terminal 2: claude --resume <session-2> (in /projects/acme-app)
  → /bridge connect acme --name api
  (this session has been exploring the Express routes)

Terminal 1:
  → /bridge ask api "How does the auth middleware validate tokens?"
  ✓ "JWT tokens are validated via supabase.auth.getUser()..."
```

### Example: Multiple projects

```
# Project A sessions — can only talk to each other
/bridge connect project-a --name frontend
/bridge connect project-a --name backend

# Project B sessions — completely isolated from Project A
/bridge connect project-b --name app
/bridge connect project-b --name database
```

### Example: Asking multiple sessions at once

You have 3 sessions connected and want to understand a cross-cutting flow:

```
Terminal 1: claude (in /projects/acme-web)
  → /bridge connect acme --name frontend

Terminal 2: claude (in /projects/acme-api)
  → /bridge connect acme --name backend

Terminal 3: claude (in /projects/acme-db)
  → /bridge connect acme --name database

Terminal 1:
  → /bridge ask backend,database "What's the user schema end to end?"
  ✓ From backend: "POST /users expects { email, password }. Validates via Zod..."
  ✓ From database: "users table: id (uuid), email (unique), password_hash, created_at..."

Terminal 2:
  → /bridge ask --all "How does authentication work?"
  ✓ From frontend: "Login form posts to /auth/login, stores JWT in httpOnly cookie..."
  ✓ From database: "auth_tokens table stores refresh tokens with 30-day expiry..."
  (backend excluded itself automatically)
```

### Example: Per-session targeted questions

Each session gets a different question tailored to its expertise:

```
Terminal 1: claude (in /projects/acme-web)
  → /bridge connect acme --name frontend

Terminal 2: claude (in /projects/acme-api)
  → /bridge connect acme --name backend

Terminal 3: claude (in /projects/acme-db)
  → /bridge connect acme --name database

Terminal 1:
  → /bridge ask backend:"What does the /users endpoint expect?" database:"What's the users table schema?"
  ✓ From backend: "POST /users expects { email: string, password: string }..."
  ✓ From database: "users table: id (uuid), email (unique), password_hash, created_at..."
```

Sessions that can answer from their summary do so instantly. Only sessions whose summaries can't answer are forked — and if a session has multiple unanswered questions, they're batched into a single fork to minimize cost.

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

For multi-target queries, all summaries are checked in parallel first (zero cost). Only sessions that can't answer from their summary are forked, minimizing token usage. Summaries persist across disconnect/reconnect cycles and are only regenerated when stale (default: 24 hours).

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
agent-bridge stop --clean # Stop broker and delete all data (~/.agent-bridge/)
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

### `/bridge ask [target(s)] "question"`

Ask one or more sessions a question.

```
/bridge ask backend "What does the /users endpoint expect?"
/bridge ask backend,database "What's the user schema?"
/bridge ask backend and database "How does auth work?"
/bridge ask --all "How does a request flow end to end?"
/bridge ask "How does authentication work?"    # auto-routes to best session
```

**Per-session questions:** Ask different questions to different sessions in one command:
```
/bridge ask backend:"What's the API endpoint?" database:"What's the schema?" lambda:"How does it process?"
```
Or use natural language: "ask backend about the endpoint and database about the schema". The same question can target multiple sessions (`backend,api:"How does auth work?"`), and a session appearing in multiple groups is forked only once with all its questions batched.

**Single target:** Specify which session to query. Supports exact name, session ID, or fuzzy matching (`bakend` finds `backend`).

**Multi-target:** Comma-separated or "and"-separated targets with a shared question. Each target is fuzzy-matched independently. Duplicates are automatically deduplicated. Your own session is excluded.

**Broadcast (`--all`):** Queries every session in the group except yourself. Useful for cross-cutting questions that span multiple codebases.

**Auto-routed:** Omit the target and the broker ranks all sessions by keyword relevance and picks the best one.

The answer flow is optimized with two-phase execution:
1. **Phase 1:** Check all target summaries in parallel (fast, no fork cost)
2. **Phase 2:** Fork only sessions whose summaries couldn't answer (parallel, with concurrency limit)
3. **Phase 3:** Enrich summaries in the background (future queries are cheaper)

For multi-target and broadcast, the response includes per-session answers with source attribution. HTTP status codes indicate success level: **200** (all answered), **207** (some answered, some had issues), **404** (none could answer).

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
- **Summary persistence:** Summaries survive disconnect/reconnect. Stale summaries (older than 24h by default) are regenerated on the next query. Use `agent-bridge stop --clean` for a full reset

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
| POST | `/ask` | Ask a question (targeted, multi-target, broadcast, or auto-routed) |
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
| `maxSummaryAgeMs` | 24 hours | Staleness threshold — summaries older than this are regenerated |
| `maxFanOut` | 5 | Max sessions per multi-target or broadcast query |
| `maxConcurrentForks` | 5 | Max simultaneous fork operations |
| `maxQueries` | 5 | Max query groups per queries-mode request |

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

301 tests across 11 files covering:

- Broker lifecycle (start, stop, health, idle timeout, crash recovery)
- Session management (registration, groups, fuzzy resolution, name sanitization)
- Fork execution (mock forking, TTL cache, timeout handling, batch forking, concurrency control)
- Summary engine (generation, keyword matching, enrichment, tiered flow, staleness checks)
- Auto-routing (session ranking, broadcasting, fallback)
- Multi-target fan-out (resolution, dedup, fuzzy matching per target, error isolation, 207 Multi-Status)
- Broadcast mode (self-exclusion, empty group, maxFanOut enforcement)
- Two-phase execution (summary-only answers, fork gaps only, background enrichment)
- Queries mode (per-session questions, fork batching, per-question enrichment, schema validation)
- CLI parsing (subcommand validation, typo correction)
- Storage (path scoping, traversal protection, deleteAll)

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
# Stop the broker and delete all data
agent-bridge stop --clean

# Uninstall the package
npm uninstall -g agent-bridge-cli

# Clean up the skill (may need manual removal)
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
