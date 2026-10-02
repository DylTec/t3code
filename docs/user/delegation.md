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

The agent decides which to ask for. Say so in your request if you want to
choose.

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
