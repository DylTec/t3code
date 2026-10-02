/**
 * DelegationService - lets one thread's agent hand a task to another provider
 * instance and get the result back.
 *
 * A delegation is a parent thread, a child thread, and a record linking them.
 * The child is created with the same engine commands a client sends, so the
 * provider command reactor starts its session through `ProviderService` and
 * the child shows up and behaves like any other thread. This service only
 * records the link, enforces limits, and watches the child's domain events to
 * settle the delegation when its turn ends.
 *
 * Fork-owned module. See docs/fork-maintenance.md.
 */
import {
  ApprovalRequestId,
  CommandId,
  type Delegation,
  type DelegationAccess,
  DelegationError,
  type DelegationExecutionMode,
  DelegationId,
  type DelegationTargets,
  type DelegationThreadSnapshot,
  type DelegationWorkspaceMode,
  type DelegationFailure,
  isDelegationTerminal,
  MessageId,
  toDelegationSummary,
  type OrchestrationEvent,
  type OrchestrationSession,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type ProviderDriverKind,
  type RuntimeMode,
  ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { buildTemporaryWorktreeBranchName, isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as DelegationPolicy from "./DelegationPolicy.ts";
import * as DelegationRepository from "./DelegationRepository.ts";

export interface DelegateRequest {
  readonly parentThreadId: ThreadId;
  /** A worker profile from settings; fixes every field it sets. */
  readonly profile?: string | undefined;
  /** A provider instance id or driver kind. Required without a profile. */
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly task: string;
  readonly role?: string | undefined;
  /** Defaults to read-only. */
  readonly access?: DelegationAccess | undefined;
  /** Defaults to `current` for read-only work and `worktree` for writes. */
  readonly workspace?: DelegationWorkspaceMode | undefined;
  readonly executionMode: DelegationExecutionMode;
  readonly timeoutMinutes?: number | undefined;
}

export interface DelegationServiceShape {
  /** Validate, record and start a delegation. Returns once the child's turn is queued. */
  readonly delegate: (request: DelegateRequest) => Effect.Effect<Delegation, DelegationError>;
  /**
   * Wait until the delegation settles or `maxWait` passes, whichever is first,
   * and return its state at that point.
   */
  readonly awaitSettled: (
    id: DelegationId,
    maxWait: Duration.Input,
  ) => Effect.Effect<Delegation, DelegationError>;
  readonly get: (id: DelegationId) => Effect.Effect<Delegation, DelegationError>;
  /** Interrupt the child and settle the delegation as cancelled. Settled ones are returned as is. */
  readonly cancel: (id: DelegationId) => Effect.Effect<Delegation, DelegationError>;
  /** The delegation that started this thread, if any, and every delegation it started. */
  readonly threadSnapshot: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadDelegations, DelegationError>;
  /** The thread's snapshot now and again after every change to one of its delegations. */
  readonly streamThread: (
    threadId: ThreadId,
  ) => Stream.Stream<DelegationThreadSnapshot, DelegationError>;
  /** The user's profiles and the provider instances, with whether each can take work. */
  readonly listTargets: Effect.Effect<DelegationTargets, DelegationError>;
  /** Waits until every domain event received so far has been handled. Tests only. */
  readonly drain: Effect.Effect<void>;
}

export interface ThreadDelegations {
  readonly threadId: ThreadId;
  readonly parent: Delegation | null;
  readonly children: ReadonlyArray<Delegation>;
}

export class DelegationService extends Context.Service<DelegationService, DelegationServiceShape>()(
  "t3/delegation/DelegationService",
) {}

interface Tracked {
  delegation: Delegation;
  readonly done: Deferred.Deferred<Delegation>;
  /** Set once the child's turn starts running; the turn the result is read from. */
  childTurnId: TurnId | null;
}

const persistenceFailed = (cause: unknown) =>
  new DelegationError({
    code: "persistence_failed",
    detail: `T3 Code could not read or record the delegation: ${String(cause)}`,
  });

const notFound = (id: string) =>
  new DelegationError({ code: "not_found", detail: `No delegation with id '${id}'.` });

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providers = yield* ProviderRegistry;
  const settingsService = yield* ServerSettingsService;
  const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
  const repository = yield* DelegationRepository.DelegationRepository;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Scope.Scope;

  const tracked = new Map<DelegationId, Tracked>();
  const byChild = new Map<ThreadId, DelegationId>();
  const lock = yield* Semaphore.make(1);
  const timers = yield* FiberMap.make<DelegationId>();
  const changes = yield* PubSub.unbounded<Delegation>();
  // Opens once delegations left by a previous process are tracked again, so
  // nothing reads a stale persisted state as live or under-counts the limits.
  const recovered = yield* Deferred.make<void>();

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const commandId = (tag: string) =>
    Effect.map(uuid, (id) => CommandId.make(`server:delegation-${tag}:${id}`));

  const readSettings = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.delegation),
    Effect.mapError(persistenceFailed),
  );

  const requireThread = (threadId: ThreadId) =>
    snapshots.getThreadShellById(threadId).pipe(
      Effect.mapError(persistenceFailed),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new DelegationError({
                code: "parent_not_found",
                detail: `Thread '${threadId}' was not found.`,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const isTracked = (t: Tracked) =>
    tracked.get(t.delegation.id) === t && !isDelegationTerminal(t.delegation.status);

  /**
   * Record a transition. Terminal transitions release the delegation's slot,
   * wake anyone awaiting it, and stop its timeout. Callers hold `lock`.
   */
  const commit = (t: Tracked, patch: Partial<Delegation>) =>
    Effect.gen(function* () {
      const next: Delegation = { ...t.delegation, ...patch };
      t.delegation = next;
      yield* repository.upsert(next).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to persist delegation", {
            delegationId: next.id,
            status: next.status,
            cause: Cause.pretty(cause),
          }),
        ),
      );
      if (isDelegationTerminal(next.status)) {
        tracked.delete(next.id);
        byChild.delete(next.childThreadId);
        yield* Deferred.succeed(t.done, next);
        yield* FiberMap.remove(timers, next.id);
        yield* Effect.logInfo("delegation settled", {
          delegationId: next.id,
          parentThreadId: next.parentThreadId,
          childThreadId: next.childThreadId,
          providerInstanceId: next.providerInstanceId,
          status: next.status,
          ...(next.failure ? { failureCode: next.failure.code } : {}),
        });
      }
      yield* PubSub.publish(changes, next);
    });

  const settle = (
    t: Tracked,
    status: "completed" | "failed" | "cancelled" | "timed_out",
    outcome: { readonly result?: string | null; readonly failure?: DelegationFailure | null },
  ) =>
    Effect.gen(function* () {
      if (!isTracked(t)) return;
      yield* commit(t, {
        status,
        completedAt: yield* nowIso,
        result: outcome.result ?? null,
        failure: outcome.failure ?? null,
      });
    });

  /** Read the child's final answer from the projection, which commits before events fan out. */
  const complete = (t: Tracked) =>
    Effect.gen(function* () {
      const detail = yield* snapshots
        .getThreadDetailById(t.delegation.childThreadId, { activityKinds: [] })
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const result = Option.match(detail, {
        onNone: () => null,
        onSome: (thread) => DelegationPolicy.finalAssistantText(thread.messages, t.childTurnId),
      });
      yield* settle(t, "completed", { result });
    });

  const stopChild = (t: Tracked) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      const threadId = t.delegation.childThreadId;
      // Both are best effort: the child may never have started, or may
      // already be idle, and the engine rejects commands for absent state.
      yield* engine
        .dispatch({
          type: "thread.turn.interrupt",
          commandId: yield* commandId("interrupt"),
          threadId,
          ...(t.childTurnId === null ? {} : { turnId: t.childTurnId }),
          createdAt,
        })
        .pipe(Effect.ignore);
      yield* engine
        .dispatch({
          type: "thread.session.stop",
          commandId: yield* commandId("stop"),
          threadId,
          createdAt,
        })
        .pipe(Effect.ignore);
    });

  const cancelTracked = (
    t: Tracked,
    status: "cancelled" | "timed_out",
    failure: DelegationFailure,
  ) =>
    Effect.gen(function* () {
      if (!isTracked(t)) return;
      // Settle first so the interrupt's own session events find nothing to
      // settle and so waiters are released even if the provider never answers.
      yield* settle(t, status, { failure });
      yield* stopChild(t);
    });

  /** Cancellation runs down the tree: a cancelled parent cancels its active children. */
  const cancelChildrenOf = (parentThreadId: ThreadId, message: string) =>
    Effect.forEach(
      [...tracked.values()].filter((t) => t.delegation.parentThreadId === parentThreadId),
      (t) => cancelTracked(t, "cancelled", { code: "parent_cancelled", message }),
      { discard: true },
    );

  const trackedForChild = (threadId: ThreadId) => {
    const id = byChild.get(threadId);
    return id === undefined ? undefined : tracked.get(id);
  };

  const onChildSession = (t: Tracked, session: OrchestrationSession) =>
    Effect.gen(function* () {
      if (session.status === "running" && session.activeTurnId !== null) {
        if (t.childTurnId === null) {
          t.childTurnId = session.activeTurnId;
          yield* commit(t, { status: "running", startedAt: yield* nowIso });
        }
        return;
      }
      switch (session.status) {
        case "ready":
        case "idle":
          // A new child reports "starting" until its turn runs, so a ready
          // session only ends the delegation after the turn was seen.
          if (t.childTurnId !== null) yield* complete(t);
          return;
        case "error":
          return yield* settle(t, "failed", {
            failure: {
              code: t.childTurnId === null ? "start_failed" : "child_failed",
              message: session.lastError ?? "The delegate's provider session failed.",
            },
          });
        case "interrupted":
        case "stopped":
          return yield* settle(t, "cancelled", {
            failure: {
              code: "interrupted",
              message:
                "The delegate's turn was interrupted or its session stopped before it finished.",
            },
          });
      }
    });

  const onChildActivity = (t: Tracked, activity: OrchestrationThreadActivity) =>
    Effect.gen(function* () {
      const payload =
        typeof activity.payload === "object" && activity.payload !== null
          ? (activity.payload as Record<string, unknown>)
          : {};
      if (activity.kind === "approval.requested" && t.delegation.access === "read-only") {
        if (typeof payload.requestId !== "string") return;
        const decision = DelegationPolicy.readOnlyApprovalDecision(
          typeof payload.requestKind === "string" ? payload.requestKind : undefined,
        );
        yield* engine
          .dispatch({
            type: "thread.approval.respond",
            commandId: yield* commandId("approval"),
            threadId: t.delegation.childThreadId,
            requestId: ApprovalRequestId.make(payload.requestId),
            decision,
            createdAt: yield* nowIso,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to answer read-only delegate approval", {
                delegationId: t.delegation.id,
                cause: Cause.pretty(cause),
              }),
            ),
          );
        return;
      }
      if (activity.kind === "provider.turn.start.failed" && t.childTurnId === null) {
        yield* settle(t, "failed", {
          failure: {
            code: "start_failed",
            message:
              typeof payload.detail === "string" ? payload.detail : "The delegate could not start.",
          },
        });
      }
    });

  const processEvent = (event: OrchestrationEvent) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        switch (event.type) {
          case "thread.session-set": {
            const t = trackedForChild(event.payload.threadId);
            if (t) yield* onChildSession(t, event.payload.session);
            return;
          }
          case "thread.activity-appended": {
            const t = trackedForChild(event.payload.threadId);
            if (t) yield* onChildActivity(t, event.payload.activity);
            return;
          }
          case "thread.deleted": {
            const t = trackedForChild(event.payload.threadId);
            if (t) {
              yield* settle(t, "cancelled", {
                failure: { code: "child_deleted", message: "The delegate's thread was deleted." },
              });
            }
            return yield* cancelChildrenOf(
              event.payload.threadId,
              "The delegating thread was deleted.",
            );
          }
          case "thread.turn-interrupt-requested":
            return yield* cancelChildrenOf(
              event.payload.threadId,
              "The delegating agent's turn was interrupted.",
            );
          case "thread.session-stop-requested":
            return yield* cancelChildrenOf(
              event.payload.threadId,
              "The delegating thread's session was stopped.",
            );
        }
      }),
    );

  const worker = yield* makeDrainableWorker((event: OrchestrationEvent) =>
    processEvent(event).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("delegation event handling failed", {
            eventType: event.type,
            cause: Cause.pretty(cause),
          }),
      ),
    ),
  );

  /**
   * Time out from a fresh fiber: settling removes the timer from `timers`,
   * which would otherwise interrupt the fiber doing the settling.
   */
  const scheduleTimeout = (t: Tracked) =>
    Effect.gen(function* () {
      const deadline = DateTime.toEpochMillis(DateTime.makeUnsafe(t.delegation.deadlineAt));
      const remaining = Math.max(0, deadline - DateTime.toEpochMillis(yield* DateTime.now));
      yield* FiberMap.run(
        timers,
        t.delegation.id,
        Effect.sleep(Duration.millis(remaining)).pipe(
          Effect.andThen(
            lock
              .withPermits(1)(
                cancelTracked(t, "timed_out", {
                  code: "timed_out",
                  message: `The delegate did not finish before its deadline (${t.delegation.deadlineAt}).`,
                }),
              )
              .pipe(Effect.forkIn(scope)),
          ),
        ),
      );
    });

  const track = (delegation: Delegation, childTurnId: TurnId | null) =>
    Effect.gen(function* () {
      const t: Tracked = { delegation, done: yield* Deferred.make<Delegation>(), childTurnId };
      tracked.set(delegation.id, t);
      byChild.set(delegation.childThreadId, delegation.id);
      return t;
    });

  const parentDriverOf = (
    parent: OrchestrationThreadShell,
    snapshotsByInstance: ReadonlyMap<string, { readonly driver: ProviderDriverKind }>,
  ): ProviderDriverKind | null =>
    snapshotsByInstance.get(parent.session?.providerInstanceId ?? parent.modelSelection.instanceId)
      ?.driver ?? null;

  const resolveWorkspace = (
    mode: DelegationWorkspaceMode,
    parent: OrchestrationThreadShell,
  ): Effect.Effect<{ branch: string | null; worktreePath: string | null }, DelegationError> =>
    Effect.gen(function* () {
      if (mode === "current") {
        // A temporary branch is renamed on its thread's first turn; a child
        // sharing it would race the parent's rename.
        const branch =
          parent.branch !== null && isTemporaryWorktreeBranch(parent.branch) ? null : parent.branch;
        return { branch, worktreePath: parent.worktreePath };
      }
      const project = yield* snapshots.getProjectShellById(parent.projectId).pipe(
        Effect.mapError(persistenceFailed),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new DelegationError({
                  code: "workspace_unavailable",
                  detail: "The delegating thread's project no longer exists.",
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
      const token = yield* uuid;
      const created = yield* gitWorkflow
        .createWorktree({
          cwd: parent.worktreePath ?? project.workspaceRoot,
          refName: parent.branch ?? "HEAD",
          // Temporary, so the first turn renames it like any new worktree thread.
          newRefName: buildTemporaryWorktreeBranchName(() => token.replaceAll("-", "")),
          path: null,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new DelegationError({
                code: "workspace_unavailable",
                detail: `Could not create a worktree for the delegate: ${cause.message}`,
              }),
          ),
        );
      return { branch: created.worktree.refName, worktreePath: created.worktree.path };
    });

  const delegate: DelegationServiceShape["delegate"] = Effect.fn("DelegationService.delegate")(
    function* (request) {
      yield* Deferred.await(recovered);
      const settings = yield* readSettings;
      const parent = yield* requireThread(request.parentThreadId);
      const parentDelegation = yield* repository
        .getByChildThreadId(parent.id)
        .pipe(Effect.mapError(persistenceFailed));
      const depth = Option.match(parentDelegation, {
        onNone: () => 1,
        onSome: (delegation) => delegation.depth + 1,
      });
      const choice = DelegationPolicy.resolveChoice(request, settings);
      if (DelegationPolicy.isDelegationError(choice)) return yield* Effect.fail(choice);
      const providerSnapshots = yield* providers.getProviders;
      const target = DelegationPolicy.resolveTargetProvider(choice.provider, providerSnapshots);
      if (DelegationPolicy.isDelegationError(target)) return yield* Effect.fail(target);
      const model = DelegationPolicy.resolveModel(target, choice.model);
      if (DelegationPolicy.isDelegationError(model)) return yield* Effect.fail(model);
      const access = choice.access ?? "read-only";
      const workspaceMode = choice.workspace ?? (access === "write" ? "worktree" : "current");
      const parentTurnId = parent.latestTurn?.state === "running" ? parent.latestTurn.turnId : null;
      const role = choice.role;
      const timeoutMinutes = choice.timeoutMinutes ?? settings.defaultTimeoutMinutes;

      // Admission and reservation happen under the lock so concurrent requests
      // cannot both take the last slot. Slow work (worktree, dispatch) does not.
      const t = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const active = [...tracked.values()].map((entry) => entry.delegation);
          const childrenThisTurn =
            parentTurnId === null
              ? 0
              : (yield* repository
                  .listByParentThreadId(parent.id)
                  .pipe(Effect.mapError(persistenceFailed))).filter(
                  (delegation) => delegation.parentTurnId === parentTurnId,
                ).length;
          const refused = DelegationPolicy.checkAdmission({
            settings,
            parentDriver: parentDriverOf(
              parent,
              new Map(providerSnapshots.map((provider) => [provider.instanceId, provider])),
            ),
            targetDriver: target.driver,
            childDepth: depth,
            access,
            workspaceMode,
            activeGlobal: active.length,
            activeForParent: active.filter((entry) => entry.parentThreadId === parent.id).length,
            childrenThisTurn,
          });
          if (refused) return yield* Effect.fail(refused);
          const createdAt = yield* nowIso;
          const deadline = DateTime.add(DateTime.makeUnsafe(createdAt), {
            minutes: timeoutMinutes,
          });
          const delegation: Delegation = {
            id: DelegationId.make(`del_${yield* uuid}`),
            parentThreadId: parent.id,
            parentTurnId,
            childThreadId: ThreadId.make(yield* uuid),
            requestedProvider: choice.provider,
            providerInstanceId: target.instanceId,
            driver: target.driver,
            model,
            role,
            profile: choice.profile?.name ?? null,
            task: request.task,
            access,
            workspaceMode,
            executionMode: request.executionMode,
            depth,
            status: "queued",
            createdAt,
            startedAt: null,
            completedAt: null,
            deadlineAt: DateTime.formatIso(deadline),
            result: null,
            failure: null,
          };
          const entry = yield* track(delegation, null);
          yield* commit(entry, {});
          return entry;
        }),
      );
      yield* Effect.logInfo("delegation created", {
        delegationId: t.delegation.id,
        parentThreadId: t.delegation.parentThreadId,
        childThreadId: t.delegation.childThreadId,
        providerInstanceId: t.delegation.providerInstanceId,
        model: t.delegation.model,
        role: t.delegation.role ?? "",
        profile: t.delegation.profile ?? "",
        access,
        workspaceMode,
        depth,
      });

      const failStart = (error: DelegationError) =>
        lock
          .withPermits(1)(
            settle(t, "failed", { failure: { code: error.code, message: error.detail } }),
          )
          .pipe(Effect.andThen(Effect.fail(error)));

      const workspace = yield* resolveWorkspace(workspaceMode, parent).pipe(
        Effect.catch(failStart),
      );
      // A cancel may have landed while the worktree was being created.
      if (!isTracked(t)) return t.delegation;
      yield* lock.withPermits(1)(commit(t, { status: "starting" }));
      yield* scheduleTimeout(t);

      const runtimeMode: RuntimeMode =
        access === "read-only" ? "approval-required" : parent.runtimeMode;
      const createdAt = yield* nowIso;
      const childThreadId = t.delegation.childThreadId;
      const parentProviderName =
        parent.session?.providerName ??
        parentDriverOf(
          parent,
          new Map(providerSnapshots.map((provider) => [provider.instanceId, provider])),
        );
      yield* Effect.gen(function* () {
        yield* engine.dispatch({
          type: "thread.create",
          commandId: yield* commandId("thread-create"),
          threadId: childThreadId,
          projectId: parent.projectId,
          title: DelegationPolicy.childThreadTitle(role, request.task),
          modelSelection: { instanceId: target.instanceId, model },
          runtimeMode,
          interactionMode: "default",
          branch: workspace.branch,
          worktreePath: workspace.worktreePath,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: yield* commandId("turn-start"),
          threadId: childThreadId,
          message: {
            messageId: MessageId.make(yield* uuid),
            role: "user",
            text: DelegationPolicy.buildChildPrompt({
              task: request.task,
              role,
              access,
              workspaceMode,
              parentThreadTitle: parent.title,
              parentProvider: parentProviderName,
              instructions: choice.profile?.instructions,
            }),
            attachments: [],
          },
          runtimeMode,
          interactionMode: "default",
          createdAt,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          failStart(
            new DelegationError({
              code: "start_failed",
              detail: `T3 Code could not create the delegate's thread: ${Cause.pretty(cause)}`,
            }),
          ),
        ),
      );
      return t.delegation;
    },
  );

  const get: DelegationServiceShape["get"] = (id) => {
    const live = tracked.get(id);
    if (live) return Effect.succeed(live.delegation);
    return repository
      .getById(id)
      .pipe(
        Effect.mapError(persistenceFailed),
        Effect.flatMap(
          Option.match({ onNone: () => Effect.fail(notFound(id)), onSome: Effect.succeed }),
        ),
      );
  };

  const awaitSettled: DelegationServiceShape["awaitSettled"] = (id, maxWait) =>
    Effect.gen(function* () {
      yield* Deferred.await(recovered);
      const live = tracked.get(id);
      if (!live) return yield* get(id);
      return yield* Deferred.await(live.done).pipe(
        Effect.timeoutOption(maxWait),
        Effect.map(Option.getOrElse(() => live.delegation)),
      );
    });

  const cancel: DelegationServiceShape["cancel"] = (id) =>
    Effect.gen(function* () {
      yield* Deferred.await(recovered);
      const live = tracked.get(id);
      if (live) {
        yield* lock.withPermits(1)(
          cancelTracked(live, "cancelled", {
            code: "cancelled",
            message: "The delegation was cancelled.",
          }),
        );
        return live.delegation;
      }
      return yield* get(id);
    });

  const threadSnapshot: DelegationServiceShape["threadSnapshot"] = (threadId) =>
    Effect.all({
      parent: repository.getByChildThreadId(threadId).pipe(Effect.map(Option.getOrNull)),
      children: repository.listByParentThreadId(threadId),
    }).pipe(
      Effect.map(({ parent, children }) => ({
        threadId,
        // Live records carry transitions that may not be persisted yet.
        parent: parent === null ? null : (tracked.get(parent.id)?.delegation ?? parent),
        children: children.map((child) => tracked.get(child.id)?.delegation ?? child),
      })),
      Effect.mapError(persistenceFailed),
    );

  const summarize = (snapshot: ThreadDelegations): DelegationThreadSnapshot => ({
    threadId: snapshot.threadId,
    parent: snapshot.parent === null ? null : toDelegationSummary(snapshot.parent),
    children: snapshot.children.map(toDelegationSummary),
  });

  const streamThread: DelegationServiceShape["streamThread"] = (threadId) =>
    Stream.unwrap(
      PubSub.subscribe(changes).pipe(
        Effect.map((subscription) =>
          Stream.concat(
            Stream.fromEffect(threadSnapshot(threadId)),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter(
                (delegation) =>
                  delegation.parentThreadId === threadId || delegation.childThreadId === threadId,
              ),
              Stream.mapEffect(() => threadSnapshot(threadId)),
            ),
          ).pipe(Stream.map(summarize)),
        ),
      ),
    );

  const listTargets: DelegationServiceShape["listTargets"] = Effect.all({
    settings: readSettings,
    snapshots: providers.getProviders,
  }).pipe(
    Effect.map(({ settings, snapshots }) => ({
      enabled: settings.enabled,
      requireProfile: settings.requireProfile,
      profiles: settings.profiles.map((profile) =>
        DelegationPolicy.toProfileTarget(profile, snapshots),
      ),
      providers: snapshots.map(DelegationPolicy.toDelegationTarget),
    })),
  );

  /**
   * Resume watching delegations a previous server process left running. A
   * child whose turn already finished settles from its thread; one that is
   * still working is watched again; anything else lost its provider process
   * with the old server and fails.
   */
  const recover = Effect.gen(function* () {
    const active = yield* repository.listActive;
    yield* Effect.forEach(
      active,
      (delegation) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const child = yield* snapshots
              .getThreadShellById(delegation.childThreadId)
              .pipe(Effect.orElseSucceed(() => Option.none()));
            const session = Option.getOrNull(child)?.session ?? null;
            const latestTurn = Option.getOrNull(child)?.latestTurn ?? null;
            const t = yield* track(delegation, latestTurn?.turnId ?? null);
            if (session?.status === "running" || session?.status === "starting") {
              if (session.status === "running" && session.activeTurnId !== null) {
                t.childTurnId = session.activeTurnId;
              }
              return yield* scheduleTimeout(t);
            }
            if (latestTurn?.state === "completed" && delegation.status === "running") {
              return yield* complete(t);
            }
            yield* settle(t, "failed", {
              failure: {
                code: "orphaned",
                message: "T3 Code restarted before the delegate finished.",
              },
            });
          }),
        ),
      { discard: true },
    );
    if (active.length > 0) {
      yield* Effect.logInfo("recovered delegations", { count: active.length });
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("delegation recovery failed", { cause: Cause.pretty(cause) }),
    ),
    Effect.ensuring(Deferred.succeed(recovered, undefined)),
  );

  const start = Effect.gen(function* () {
    // Subscribe before recovering so no event between the two is missed.
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(recover.pipe(Effect.andThen(Stream.runForEach(events, worker.enqueue))));
  });

  yield* start;

  return DelegationService.of({
    delegate,
    awaitSettled,
    get,
    cancel,
    threadSnapshot,
    streamThread,
    listTargets,
    drain: worker.drain,
  });
});

export const layer = Layer.effect(DelegationService, make).pipe(
  Layer.provide(DelegationRepository.layer),
);
