# Delegation

Delegation lets an agent hand a task to a different provider. For example,
Claude can ask Codex to review its changes, or Codex can ask Claude to look
into a question. Each delegate runs in its own thread, which you can open and
watch like any other. It uses that provider's own sign-in and subscription.

## Turn it on

Delegation is off by default. Turn it on in
**Settings → Integrations → Delegation**. The setting applies to the whole
environment. The same section sets how many delegates a thread may run at once,
how deep delegates may delegate again, and how long a delegate may work before
T3 Code stops it.

## Roles

Agents can ask for a delegate by role instead of naming a provider. T3 Code has
eight standard roles: implementer, reviewer, researcher, debugger, test-author,
security-reviewer, architect and performance-reviewer.

Each role has a default access level and an ordered list of preferred
providers. When an agent gives a role and no provider, the first preferred
provider that is signed in and allowed takes the task. The delegate is also told
how that role should work and report. For example, a reviewer reports findings
by severity and doesn't fix them. Agents can still name a provider or access
level themselves.

By default, implementer, debugger and test-author get write access in their own
worktree. The other roles are read-only. Change a role's access or providers in
**Settings → Integrations → Delegation → Delegation roles**.

## Worker profiles

Profiles are named workers you set up once, like subagents in an OpenCode
orchestrator config. Add them in **Settings → Integrations → Delegation →
Worker profiles**. Each one has:

- a name, such as `reviewer` or `explorer`
- a description of when to use it, which agents read to choose a worker
- the provider and model it runs on
- read-only or write access, and whether it gets its own worktree
- standing instructions added to every task it receives
- an optional timeout

Agents see the profiles, in the order you list them, before they delegate.
Everything a profile sets is fixed: an agent can't give a read-only reviewer
write access or move it to another model. To keep agents on your profiles only,
turn on **Only delegate to profiles**.

## Ask for a delegate

Ask in plain language, for example "have Codex review this diff for bugs" or
"ask Claude and OpenCode for a second opinion on this plan". The agent uses
T3 Code's delegation tools. By default it waits for the delegate's final
message and continues from there. It can also start several delegates in the
background and collect their results later.

A delegate starts with no memory of your conversation. It only knows what the
delegating agent writes into the task.

## Follow along

On the delegating thread, a banner above the message box lists the delegates
still working. Each one links to its thread and has a **Cancel** button. A
delegate's own thread shows which thread delegated it. Delegate threads stay in
the sidebar after they finish, with their full history.

Stopping the delegating thread's turn cancels its delegates too.

## Access

- **Read-only** (the default). The delegate shares the delegating thread's
  checkout, including uncommitted changes. It runs supervised, and T3 Code
  automatically declines everything except reading files. How strictly reads
  and commands are separated depends on the provider (see
  [Permission modes](./permission-modes.md#provider-differences)).
- **Write.** The delegate gets its own Git worktree, branched from the
  delegating checkout's current commit. Uncommitted changes are not included.
  It uses the delegating thread's permission mode. Review and merge its branch
  as you would any worktree thread.

The agent decides which to ask for unless the profile sets it. Say so in your
request if you want to choose.

## Limits

A delegate's provider must be installed, signed in, and enabled in
**Settings → Providers**. A delegation goes to exactly the provider the agent
names. If that provider can't take the task, the agent is told why rather than
being routed to another one.

To limit which providers each provider may delegate to, set
`delegation.allowedTargets` in `settings.json` in the environment's T3 Code
data directory, for example `{ "claudeAgent": ["codex"] }`.

The mobile app shows delegate threads, but delegation banners and settings are
only in the web and desktop apps.
