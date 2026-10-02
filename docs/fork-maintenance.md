# Fork maintenance

This fork adds cross-agent delegation to T3 Code: an agent in one thread can
hand a task to another provider (Claude, Codex, OpenCode, …), which runs it in a
child thread. Everything else should behave exactly like upstream
[`pingdotgg/t3code`](https://github.com/pingdotgg/t3code). The rules below keep
upstream merges cheap.

## Branches

- `main` mirrors upstream. Only upstream merges land here, never fork work.
- `feature/cross-agent-orchestration` (and other `feature/*` branches) carry
  the fork. They merge `main` in after each sync.

## Syncing with upstream

Weekly, or before starting new fork work:

```bash
git fetch upstream
git switch main && git merge --ff-only upstream/main && git push origin main
git switch feature/cross-agent-orchestration && git merge main
```

Conflicts should only come from the files in the ledger below. Re-apply each
edit by its intent, not its old line numbers, and keep the `Fork:` marker
comment. Then run the targeted checks:

```bash
vp i
(cd packages/contracts && npx tsc --noEmit)
(cd packages/client-runtime && npx tsc --noEmit)
(cd apps/server && npx tsc --noEmit)
(cd apps/web && npx tsc --noEmit)
vp test run apps/server/src/delegation apps/server/src/mcp/toolkits/delegation
```

The [Upstream compatibility](../.github/workflows/upstream-compat.yml) workflow
merges `upstream/main` into the feature branch every week and runs the same
checks, so a breaking upstream change shows up before the next manual sync.

## Where the fork lives

Fork-owned code sits in its own modules. Upstream never touches these, so they
never conflict:

- `packages/contracts/src/delegation.ts`: schemas, settings, errors, RPC group
- `packages/client-runtime/src/state/delegation.ts`: client atoms
- `apps/server/src/delegation/`: service, policy, repository, RPC handlers
- `apps/server/src/mcp/toolkits/delegation/`: the agent-facing MCP tools
- `apps/web/src/components/delegation/`, `apps/web/src/state/delegation.ts`: UI
- `docs/fork-maintenance.md`, `docs/user/delegation.md`,
  `.github/workflows/upstream-compat.yml`

## Patch ledger

Every edit to an upstream file. Each one is marked in the source with a
`Fork: cross-agent delegation. See docs/fork-maintenance.md.` comment, except
`package.json`, which cannot hold comments. When you add or remove an upstream
edit, update this table in the same commit.

| Upstream file                                               | Edit                                                                 | Why                                                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `packages/contracts/src/index.ts`                           | `export * from "./delegation.ts"`                                    | Clients and server import contracts from the package root.                                       |
| `packages/contracts/src/settings.ts`                        | `delegation` key on `ServerSettings` and `ServerSettingsPatch`       | The feature flag and limits live in server settings. The decoding default keeps old files valid. |
| `packages/contracts/src/rpc.ts`                             | `WsRpcGroup` ends with `.merge(DelegationRpcGroup)`                  | One WebSocket protocol; the group is defined in the fork module.                                 |
| `apps/server/src/auth/RpcAuthorization.ts`                  | Scopes for the five `delegation.*` methods                           | The scope table must cover every RPC; it is type-checked against `WsRpcGroup`.                   |
| `apps/server/src/ws.ts`                                     | Build `makeDelegationRpcHandlers` and spread it into `WsRpcGroup.of` | Handlers reuse the connection's authorize-and-observe wrappers.                                  |
| `apps/server/src/server.ts`                                 | `Layer.provideMerge(DelegationService.layer)` in `ReactorLayerLive`  | The service is a reactor: it watches domain events and drives child threads.                     |
| `apps/server/src/mcp/McpHttpServer.ts`                      | Register `DelegationToolkit` in the MCP server layer                 | Agents reach delegation through the existing `t3-code` MCP server.                               |
| `apps/server/src/provider/Layers/CodexAdapter.ts`           | `-c mcp_servers.t3-code.tool_timeout_sec=3900`                       | Codex abandons MCP calls after 60 s by default; a blocking delegation may wait up to an hour.    |
| `packages/client-runtime/package.json`                      | `./state/delegation` subpath export                                  | The package exposes state modules only through explicit subpaths.                                |
| `packages/client-runtime/src/rpc/client.ts`                 | Add `delegation.subscribeThread` to `EnvironmentSubscriptionRpcTag`  | Subscription atoms accept only listed stream RPCs.                                               |
| `apps/web/src/components/ChatView.tsx`                      | `useDelegationBannerItems` spread into the composer banner list      | Shows "Delegated by …" on a delegate's thread and running delegates on the delegating thread.    |
| `apps/web/src/components/settings/IntegrationsSettings.tsx` | Render `DelegationSettingsSection`                                   | The on/off switch and limits live in Settings → Integrations → Delegation.                       |
| `apps/web/src/components/settings/settingsSearch.ts`        | Six `delegation*` search items                                       | Settings search only reaches rows registered in its catalog.                                     |
| `docs/README.md`                                            | Link to `user/delegation.md`                                         | User guide index.                                                                                |

## Rules for fork changes

- **Own tables, own migration ledger.** Delegations persist in the
  `delegations` table, migrated by `apps/server/src/delegation/DelegationRepository.ts`
  with its own `fork_delegation_migrations` ledger. Never add a migration to
  upstream's `persistence/Migrations.ts`: upstream numbers migrations
  sequentially, so a fork migration would collide with upstream's next one and
  either be skipped on fork databases or break upstream's on merge.
- **Off by default.** `delegation.enabled` defaults to `false`. With it off the
  server refuses every delegation and clients never subscribe to delegation
  state. Servers without the fork decode the setting as off too, so a fork
  client connected to a stock server stays quiet.
- **Child threads are ordinary threads.** The service creates and drives them
  through orchestration commands (`thread.create`, `thread.turn.start`,
  `thread.approval.respond`, …) and never calls providers directly, so the
  event store, projections and every client already understand them.
- **Prefer a new fork module over a larger upstream edit.** If an upstream
  edit grows past a few lines, move the logic into a fork-owned file and keep
  only the call site upstream.

## Known trade-offs

- **Tool list.** Like upstream's preview and device tools, the delegation tools
  are listed to every agent session and checked when called. With delegation
  off, agents see the tools and get a "turned off" error if they call one.
- **Mobile.** The mobile app shows delegate threads like any other thread but
  has no delegation banners or settings yet. Turn delegation on from web or
  desktop.
- **Read-only enforcement** relies on each provider's approval flow. A
  read-only delegate runs in `approval-required` mode and the server declines
  every approval except file reads. A provider that performs a write without
  asking is outside what T3 Code can stop.
