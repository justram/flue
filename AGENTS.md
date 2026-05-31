# Flue

Framework where projects containing agents and workflows are compiled into deployable server artifacts.

## Terminology

```
Agent profile                 — one reusable `defineAgentProfile(...)` value
Created agent                 — one runtime initializer from `createAgent(...)`
Agent module                  — `agents/<name>.ts`; default-exports a created agent
└─ AgentInstance              — URL `<id>`; provided to `createAgent(({ id }))`
   └─ Harness                 — runtime-initialized agent environment; defaults to name `"default"`
      └─ Session              — one `harness.session(name?)`; defaults to `"default"`
         └─ Operation        — one `session.prompt` / `skill` / `task` / `shell` call
            └─ Turn          — one LLM round-trip inside pi-agent-core
Workflow                     — `workflows/<name>.ts`; exports `run(...)`
└─ Workflow run/invocation    — unique `ctx.id === runId`; initializes local created agents via `init(agent)` when needed
```

Runs are workflow-only. Direct HTTP/WebSocket agent prompts and dispatched agent inputs operate within persistent sessions and must not be described as runs. `dispatch(...)` is identified by `dispatchId`; `/runs` and `flue logs` inspect workflow runs only.

Use `harness` as the variable name for the return value of `init()`. Agents have names; agent instances have ids; harnesses and sessions have names; operations have generated ids.

## Project Structure

- `packages/runtime/` — Runtime library (`@flue/runtime`): sessions, agent harnesses, tools, and sandbox plumbing.
- `packages/cli/` — CLI and build/dev tooling (`@flue/cli`): Vite build graph, target integration, discovery, and configuration.
- `examples/hello-world/` — General runtime integration fixture.
- `examples/cloudflare/` — Cloudflare integration fixture.
- `examples/imported-skill/` — Packaged skill and release fixture.

Agent and workflow sources use either `<root>/.flue/` or `<root>/`; when `.flue/` exists, the bare `agents/` and `workflows/` layout is ignored.

## Development

Build runtime before CLI or examples:

```
pnpm run build          # in packages/runtime/
pnpm run build          # in packages/cli/
```

Type-check runtime changes with:

```
pnpm run check:types    # in packages/runtime/
```

When using `task` to delegate to subagents, you MUST include a notice that the subagent must not spawn its own subagents.

Treat `review` task feedback as input, not requirements. The primary agent is responsible for deciding whether to act: require a concrete correctness or durability risk within the user's requested scope, supported by a clear failure scenario or violated invariant and relevant `file:line` evidence. Do not accept a reviewer's severity label, proposed fix, or scope expansion at face value, and do not make changes solely to satisfy repeated reviews.

A single `review` task is enough review for most work. Additional reviews are allowed for complex work, but otherwise just spot-check your post-review fixes without doing an entirely fresh review. When performing additional reviews, remember that fresh subagents do not know prior findings/context outside of what the prompt includes; either restate each concern and the relevant expected behavior when asking for confirmation, or ask for an independent scoped review without implying it can confirm prior concerns.

When writing new plans to disk, write them to `plans/` (gitignored intentionally) with a `YYYY-MM-DD` filename prefix.

Prefer changes that simplify the system over narrow patches that preserve accidental complexity. When fixing a bug or adding a feature, look for shared abstractions or obsolete branches that can be removed as part of the change, especially when this reduces distinct code paths or semantics. Do not expand into speculative redesign; call out meaningful user-facing behavior or migration tradeoffs before simplifying them away.
