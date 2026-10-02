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

export const DelegationCreateInput = Schema.Struct({
  parentThreadId: ThreadId,
  /** A provider instance id, or a driver kind such as `codex` or `claudeAgent`. */
  provider: TrimmedNonEmptyString,
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
  success: Schema.Array(DelegationTarget),
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
