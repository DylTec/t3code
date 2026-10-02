/**
 * Cross-agent delegation: one thread's agent hands a task to another provider
 * instance, which runs it in a child thread. The child is an ordinary thread;
 * these contracts only describe the parent ↔ child link and its lifecycle.
 *
 * Fork-owned module. See docs/fork-maintenance.md.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const DelegationId = TrimmedNonEmptyString.pipe(Schema.brand("DelegationId"));
export type DelegationId = typeof DelegationId.Type;

export const DelegationStatus = Schema.Literals([
  "queued",
  "starting",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);
export type DelegationStatus = typeof DelegationStatus.Type;

export const isDelegationTerminal = (status: DelegationStatus): boolean =>
  status === "completed" || status === "failed" || status === "cancelled" || status === "timed_out";

/**
 * What the child may do to the workspace. Read-only children run supervised
 * and the server declines their write approvals, so enforcement is as strong
 * as the provider's own permission model.
 */
export const DelegationAccess = Schema.Literals(["read-only", "write"]);
export type DelegationAccess = typeof DelegationAccess.Type;

/**
 * `current` shares the parent's checkout. `worktree` gives the child its own
 * Git worktree branched from the parent's current HEAD, which is required for
 * write access so two agents never edit one checkout concurrently.
 */
export const DelegationWorkspaceMode = Schema.Literals(["current", "worktree"]);
export type DelegationWorkspaceMode = typeof DelegationWorkspaceMode.Type;

export const DelegationExecutionMode = Schema.Literals(["blocking", "background"]);
export type DelegationExecutionMode = typeof DelegationExecutionMode.Type;

export const DelegationFailure = Schema.Struct({
  code: TrimmedNonEmptyString,
  message: Schema.String,
});
export type DelegationFailure = typeof DelegationFailure.Type;

export const Delegation = Schema.Struct({
  id: DelegationId,
  parentThreadId: ThreadId,
  /** The parent turn that asked; null when a user started it outside a turn. */
  parentTurnId: Schema.NullOr(TurnId),
  childThreadId: ThreadId,
  /** The provider exactly as requested, before instance resolution. */
  requestedProvider: TrimmedNonEmptyString,
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  model: TrimmedNonEmptyString,
  role: Schema.NullOr(TrimmedNonEmptyString),
  /** The worker profile the delegate was started from, if any. */
  profile: Schema.NullOr(TrimmedNonEmptyString),
  task: Schema.String,
  access: DelegationAccess,
  workspaceMode: DelegationWorkspaceMode,
  executionMode: DelegationExecutionMode,
  /** 1 for a child of a user-started thread, 2 for its child, and so on. */
  depth: NonNegativeInt,
  status: DelegationStatus,
  createdAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  /** When T3 Code interrupts the child if it is still working. */
  deadlineAt: IsoDateTime,
  /** The child's final assistant message. */
  result: Schema.NullOr(Schema.String),
  failure: Schema.NullOr(DelegationFailure),
});
export type Delegation = typeof Delegation.Type;

/**
 * A delegation without its task and result text. Live lists re-send every
 * entry on each change, so they carry only what a row shows; the text lives in
 * the child thread and in `delegation.get`.
 */
export const DelegationSummary = Delegation.mapFields(Struct.omit(["task", "result"]));
export type DelegationSummary = typeof DelegationSummary.Type;

export const toDelegationSummary = ({
  task: _task,
  result: _result,
  ...summary
}: Delegation): DelegationSummary => summary;

const DelegationLimit = (fallback: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum })).pipe(
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );

/** Standard roles (design doc Phase 3). Other role names are plain labels without defaults. */
export const DELEGATION_ROLES = [
  "implementer",
  "reviewer",
  "researcher",
  "debugger",
  "test-author",
  "security-reviewer",
  "architect",
  "performance-reviewer",
] as const;
export type DelegationRole = (typeof DELEGATION_ROLES)[number];

/** What each standard role is for; agents read these to choose one. */
export const DELEGATION_ROLE_DESCRIPTIONS: Record<DelegationRole, string> = {
  implementer: "Makes a scoped code change in its own worktree.",
  reviewer: "Reviews changes for correctness, regressions and missing cases.",
  researcher: "Answers a question from documentation, the web and the codebase, citing sources.",
  debugger: "Finds the root cause of a failure, reproducing it in its own worktree.",
  "test-author": "Writes or extends tests in its own worktree.",
  "security-reviewer": "Reviews for vulnerabilities, unsafe input handling and secrets exposure.",
  architect: "Evaluates a design or approach and recommends one, with trade-offs.",
  "performance-reviewer": "Finds performance problems and backs each one with evidence.",
};

/** A standard role's defaults. Requests may override either one. */
export const DelegationRoleSettings = Schema.Struct({
  access: DelegationAccess,
  /** Tried in order when a request names no provider; instance ids or driver kinds. */
  preferredProviders: Schema.Array(TrimmedNonEmptyString),
});
export type DelegationRoleSettings = typeof DelegationRoleSettings.Type;

export const DEFAULT_DELEGATION_ROLE_SETTINGS: Record<DelegationRole, DelegationRoleSettings> = {
  implementer: { access: "write", preferredProviders: ["claudeAgent", "codex"] },
  reviewer: { access: "read-only", preferredProviders: ["codex", "claudeAgent"] },
  researcher: { access: "read-only", preferredProviders: ["opencode", "claudeAgent"] },
  debugger: { access: "write", preferredProviders: ["codex", "claudeAgent"] },
  "test-author": { access: "write", preferredProviders: ["codex", "claudeAgent"] },
  "security-reviewer": { access: "read-only", preferredProviders: ["claudeAgent", "codex"] },
  architect: { access: "read-only", preferredProviders: ["claudeAgent", "codex"] },
  "performance-reviewer": { access: "read-only", preferredProviders: ["codex", "claudeAgent"] },
};

/** Each field defaults on its own, so a hand-edited role may set just one of them. */
const roleField = (role: DelegationRole) => {
  const defaults = DEFAULT_DELEGATION_ROLE_SETTINGS[role];
  return Schema.Struct({
    access: DelegationAccess.pipe(Schema.withDecodingDefault(Effect.succeed(defaults.access))),
    preferredProviders: Schema.Array(TrimmedNonEmptyString).pipe(
      Schema.withDecodingDefault(Effect.succeed(defaults.preferredProviders)),
    ),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({})));
};

const DelegationRolesSettings = Schema.Struct({
  implementer: roleField("implementer"),
  reviewer: roleField("reviewer"),
  researcher: roleField("researcher"),
  debugger: roleField("debugger"),
  "test-author": roleField("test-author"),
  "security-reviewer": roleField("security-reviewer"),
  architect: roleField("architect"),
  "performance-reviewer": roleField("performance-reviewer"),
});

const roleFieldPatch = Schema.optionalKey(
  Schema.Struct({
    access: Schema.optionalKey(DelegationAccess),
    preferredProviders: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  }),
);

const DelegationRolesSettingsPatch = Schema.Struct({
  implementer: roleFieldPatch,
  reviewer: roleFieldPatch,
  researcher: roleFieldPatch,
  debugger: roleFieldPatch,
  "test-author": roleFieldPatch,
  "security-reviewer": roleFieldPatch,
  architect: roleFieldPatch,
  "performance-reviewer": roleFieldPatch,
});

const DelegationProfileName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(40),
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]*$/),
);

/**
 * A named worker the user set up, like an OpenCode subagent: agents pick one
 * by its description, and every field it sets is fixed for that delegate. A
 * null model or workspace leaves that choice to the requesting agent.
 */
export const DelegationProfile = Schema.Struct({
  name: DelegationProfileName,
  /** When to use this worker. Agents choose between profiles by reading it. */
  description: TrimmedNonEmptyString,
  /** A provider instance id, or a driver kind such as `codex` or `claudeAgent`. */
  provider: TrimmedNonEmptyString,
  model: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  access: DelegationAccess.pipe(Schema.withDecodingDefault(Effect.succeed("read-only" as const))),
  workspace: Schema.NullOr(DelegationWorkspaceMode).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Standing instructions added to every task this worker receives. */
  instructions: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  timeoutMinutes: Schema.NullOr(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 240 })),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type DelegationProfile = typeof DelegationProfile.Type;

export const DelegationSettings = Schema.Struct({
  /** Off by default so a fresh install behaves exactly like upstream T3 Code. */
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  maxDepth: DelegationLimit(2, 5),
  maxChildrenPerTurn: DelegationLimit(4, 32),
  maxConcurrentGlobal: DelegationLimit(6, 64),
  maxConcurrentPerThread: DelegationLimit(3, 32),
  defaultTimeoutMinutes: DelegationLimit(15, 240),
  /**
   * Parent driver → driver kinds it may delegate to. A driver without an entry
   * may delegate to every enabled provider instance.
   */
  allowedTargets: Schema.Record(ProviderDriverKind, Schema.Array(ProviderDriverKind)).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /**
   * Named workers, in the order agents see them. An array so a settings patch
   * replaces the whole list; patches merge objects key by key.
   */
  profiles: Schema.Array(DelegationProfile).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Only profiles may be delegated to, never a provider named directly. */
  requireProfile: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Defaults for the standard roles. A patch merges per role and field. */
  roles: DelegationRolesSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type DelegationSettings = typeof DelegationSettings.Type;

export const DelegationSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  maxDepth: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))),
  maxChildrenPerTurn: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
  ),
  maxConcurrentGlobal: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
  ),
  maxConcurrentPerThread: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
  ),
  defaultTimeoutMinutes: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 240 })),
  ),
  allowedTargets: Schema.optionalKey(
    Schema.Record(ProviderDriverKind, Schema.Array(ProviderDriverKind)),
  ),
  profiles: Schema.optionalKey(Schema.Array(DelegationProfile)),
  requireProfile: Schema.optionalKey(Schema.Boolean),
  roles: Schema.optionalKey(DelegationRolesSettingsPatch),
});
export type DelegationSettingsPatch = typeof DelegationSettingsPatch.Type;

const DelegationErrorCode = Schema.Literals([
  "disabled",
  "invalid_request",
  "parent_not_found",
  "not_found",
  "depth_exceeded",
  "children_per_turn_exceeded",
  "concurrency_exceeded",
  "provider_not_found",
  "provider_unavailable",
  "provider_not_allowed",
  "profile_not_found",
  "profile_required",
  "workspace_unavailable",
  "start_failed",
  "persistence_failed",
]);
export type DelegationErrorCode = typeof DelegationErrorCode.Type;

/**
 * A delegation request T3 refused or could not record. Its message is written
 * for the requesting agent: it says what to change, not how T3 failed inside.
 */
export class DelegationError extends Schema.TaggedError<DelegationError>()("DelegationError", {
  code: DelegationErrorCode,
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/** A provider instance a thread may delegate to. */
export const DelegationTarget = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.NullOr(TrimmedNonEmptyString),
  /** True when the instance is enabled, installed and authenticated. */
  available: Schema.Boolean,
  unavailableReason: Schema.NullOr(Schema.String),
  defaultModel: Schema.NullOr(TrimmedNonEmptyString),
  models: Schema.Array(TrimmedNonEmptyString),
});
export type DelegationTarget = typeof DelegationTarget.Type;

/** A worker profile with the provider instance it resolves to right now. */
export const DelegationProfileTarget = Schema.Struct({
  ...DelegationProfile.fields,
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  available: Schema.Boolean,
  unavailableReason: Schema.NullOr(Schema.String),
});
export type DelegationProfileTarget = typeof DelegationProfileTarget.Type;

/** A standard role with the provider instance its preferences resolve to right now. */
export const DelegationRoleTarget = Schema.Struct({
  name: Schema.Literals(DELEGATION_ROLES),
  description: Schema.String,
  ...DelegationRoleSettings.fields,
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  unavailableReason: Schema.NullOr(Schema.String),
});
export type DelegationRoleTarget = typeof DelegationRoleTarget.Type;

/** What a thread may delegate to: the user's profiles, the standard roles, then raw providers. */
export const DelegationTargets = Schema.Struct({
  enabled: Schema.Boolean,
  requireProfile: Schema.Boolean,
  profiles: Schema.Array(DelegationProfileTarget),
  roles: Schema.Array(DelegationRoleTarget),
  providers: Schema.Array(DelegationTarget),
});
export type DelegationTargets = typeof DelegationTargets.Type;

/** Name a `profile`, or a `provider` (with any of the fields a profile would fix). */
export const DelegationCreateInput = Schema.Struct({
  parentThreadId: ThreadId,
  profile: Schema.optional(TrimmedNonEmptyString),
  /** A provider instance id, or a driver kind such as `codex` or `claudeAgent`. */
  provider: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  task: TrimmedNonEmptyString,
  role: Schema.optional(TrimmedNonEmptyString),
  access: Schema.optional(DelegationAccess),
  workspace: Schema.optional(DelegationWorkspaceMode),
  timeoutMinutes: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 240 }))),
});
export type DelegationCreateInput = typeof DelegationCreateInput.Type;

export const DelegationByIdInput = Schema.Struct({ delegationId: DelegationId });
export type DelegationByIdInput = typeof DelegationByIdInput.Type;

export const DelegationThreadInput = Schema.Struct({ threadId: ThreadId });
export type DelegationThreadInput = typeof DelegationThreadInput.Type;

/** Every delegation a thread started or was started by, newest first. */
export const DelegationThreadSnapshot = Schema.Struct({
  threadId: ThreadId,
  /** The delegation that created this thread, if it is a child. */
  parent: Schema.NullOr(DelegationSummary),
  children: Schema.Array(DelegationSummary),
});
export type DelegationThreadSnapshot = typeof DelegationThreadSnapshot.Type;

export const DELEGATION_WS_METHODS = {
  create: "delegation.create",
  get: "delegation.get",
  cancel: "delegation.cancel",
  listTargets: "delegation.listTargets",
  subscribeThread: "delegation.subscribeThread",
} as const;

const DelegationRpcError = Schema.Union([DelegationError, EnvironmentAuthorizationError]);

/** Background only: the call returns once the child thread has its turn queued. */
const WsDelegationCreateRpc = Rpc.make(DELEGATION_WS_METHODS.create, {
  payload: DelegationCreateInput,
  success: Delegation,
  error: DelegationRpcError,
});

const WsDelegationGetRpc = Rpc.make(DELEGATION_WS_METHODS.get, {
  payload: DelegationByIdInput,
  success: Delegation,
  error: DelegationRpcError,
});

const WsDelegationCancelRpc = Rpc.make(DELEGATION_WS_METHODS.cancel, {
  payload: DelegationByIdInput,
  success: Delegation,
  error: DelegationRpcError,
});

const WsDelegationListTargetsRpc = Rpc.make(DELEGATION_WS_METHODS.listTargets, {
  payload: DelegationThreadInput,
  success: DelegationTargets,
  error: DelegationRpcError,
});

const WsDelegationSubscribeThreadRpc = Rpc.make(DELEGATION_WS_METHODS.subscribeThread, {
  payload: DelegationThreadInput,
  success: DelegationThreadSnapshot,
  error: DelegationRpcError,
  stream: true,
});

export const DelegationRpcGroup = RpcGroup.make(
  WsDelegationCreateRpc,
  WsDelegationGetRpc,
  WsDelegationCancelRpc,
  WsDelegationListTargetsRpc,
  WsDelegationSubscribeThreadRpc,
);
