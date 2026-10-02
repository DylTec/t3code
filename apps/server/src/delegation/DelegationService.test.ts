import {
  CommandId,
  type Delegation,
  type DelegationSettings,
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationSessionStatus,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../config.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  DelegationService,
  type DelegateRequest,
  layer as DelegationLive,
} from "./DelegationService.ts";
import { claudeProvider, codexProvider } from "./testFixtures.ts";

const NOW = "2026-10-01T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("delegation-project");
const PARENT_ID = ThreadId.make("parent-thread");
const PARENT_TURN = TurnId.make("parent-turn");
const CHILD_TURN = TurnId.make("child-turn");
const CLAUDE = ProviderInstanceId.make("claudeAgent");

function makeLayer(delegation: Partial<DelegationSettings> = {}, databasePath?: string) {
  const persistence =
    databasePath === undefined ? SqlitePersistenceMemory : makeSqlitePersistenceLive(databasePath);
  const engine = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
  );
  return DelegationLive.pipe(
    Layer.provideMerge(engine),
    Layer.provide(
      ServerSettingsService.layerTest({ delegation: { enabled: true, ...delegation } }),
    ),
    Layer.provide(
      Layer.mock(ProviderRegistry)({
        getProviders: Effect.succeed([claudeProvider, codexProvider]),
      }),
    ),
    Layer.provide(
      Layer.mock(GitWorkflowService)({
        createWorktree: (input) =>
          Effect.succeed({
            worktree: { path: "/tmp/delegation-worktree", refName: input.newRefName ?? "x" },
          }),
      }),
    ),
    Layer.provideMerge(persistence),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-delegation-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
}

const dispatch = Effect.fn(function* (
  command: Parameters<OrchestrationEngineService["Service"]["dispatch"]>[0],
) {
  const engine = yield* OrchestrationEngineService;
  return yield* engine.dispatch(command);
});

let commandCounter = 0;
const nextCommandId = () => CommandId.make(`test-command-${++commandCounter}`);

const setSession = (
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  activeTurnId: TurnId | null,
  lastError: string | null = null,
) =>
  dispatch({
    type: "thread.session.set",
    commandId: nextCommandId(),
    threadId,
    createdAt: NOW,
    session: {
      threadId,
      status,
      providerName: null,
      runtimeMode: "full-access",
      activeTurnId,
      lastError,
      updatedAt: NOW,
    },
  });

/** A parent Claude thread in the middle of a turn. */
const setupParent = (threadId = PARENT_ID, turnId = PARENT_TURN) =>
  Effect.gen(function* () {
    if (threadId === PARENT_ID) {
      yield* dispatch({
        type: "project.create",
        commandId: nextCommandId(),
        projectId: PROJECT_ID,
        title: "Delegation",
        workspaceRoot: "/tmp/delegation-project",
        createdAt: NOW,
      });
    }
    yield* dispatch({
      type: "thread.create",
      commandId: nextCommandId(),
      threadId,
      projectId: PROJECT_ID,
      title: "Implement OAuth refresh",
      modelSelection: { instanceId: CLAUDE, model: "claude-fable-5-1" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: NOW,
    });
    yield* setSession(threadId, "running", turnId);
  });

/** What a provider's runtime ingestion records for one turn that answers `text`. */
const childAnswers = (childThreadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const messageId = MessageId.make(`answer-${childThreadId}`);
    yield* setSession(childThreadId, "running", CHILD_TURN);
    yield* dispatch({
      type: "thread.message.assistant.delta",
      commandId: nextCommandId(),
      threadId: childThreadId,
      messageId,
      delta: text,
      turnId: CHILD_TURN,
      createdAt: NOW,
    });
    yield* dispatch({
      type: "thread.message.assistant.complete",
      commandId: nextCommandId(),
      threadId: childThreadId,
      messageId,
      turnId: CHILD_TURN,
      createdAt: NOW,
    });
    yield* setSession(childThreadId, "ready", null);
  });

const request = (overrides: Partial<DelegateRequest> = {}): DelegateRequest => ({
  parentThreadId: PARENT_ID,
  provider: "codex",
  task: "Review the current diff for bugs.",
  role: "reviewer",
  executionMode: "blocking",
  ...overrides,
});

/** Resolves with the first matching domain event dispatched after this is forked. */
const nextEvent = <T extends OrchestrationEvent["type"]>(type: T, threadId: ThreadId) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const events = yield* engine.subscribeDomainEvents;
    return yield* events.pipe(
      Stream.filter(
        (event): event is Extract<OrchestrationEvent, { type: T }> =>
          event.type === type && "threadId" in event.payload && event.payload.threadId === threadId,
      ),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
      Effect.forkScoped,
    );
  });

const settled = (delegation: Delegation) =>
  Effect.flatMap(DelegationService, (service) => service.awaitSettled(delegation.id, "1 minute"));

describe("DelegationService", () => {
  it.effect("creates a visible child thread and returns its final answer", () =>
    Effect.gen(function* () {
      yield* setupParent();
      const service = yield* DelegationService;
      const started = yield* service.delegate(request());

      assert.strictEqual(started.status, "starting");
      assert.strictEqual(started.providerInstanceId, "codex");
      assert.strictEqual(started.model, "codex-default");
      assert.strictEqual(started.depth, 1);
      assert.strictEqual(started.parentTurnId, PARENT_TURN);

      const snapshots = yield* ProjectionSnapshotQuery;
      const child = Option.getOrThrow(yield* snapshots.getThreadDetailById(started.childThreadId));
      assert.strictEqual(child.title, "Reviewer: Review the current diff for bugs.");
      assert.strictEqual(child.modelSelection.instanceId, "codex");
      // Read-only delegates run supervised so their write approvals reach T3.
      assert.strictEqual(child.runtimeMode, "approval-required");
      assert.include(child.messages[0]?.text ?? "", "Review the current diff for bugs.");

      yield* childAnswers(started.childThreadId, "Found one bug in token refresh.");
      const done = yield* settled(started);
      assert.strictEqual(done.status, "completed");
      assert.strictEqual(done.result, "Found one bug in token refresh.");
      assert.isNotNull(done.startedAt);

      // The record survives in persistence, linked from both threads.
      const snapshot = yield* service.threadSnapshot(PARENT_ID);
      assert.deepStrictEqual(
        snapshot.children.map((delegation) => delegation.status),
        ["completed"],
      );
      const childView = yield* service.threadSnapshot(started.childThreadId);
      assert.strictEqual(childView.parent?.id, started.id);

      // The live view re-sends on every change, so it leaves the text out.
      const live = yield* Stream.runHead(service.streamThread(PARENT_ID));
      const row = Option.getOrThrow(live).children[0]!;
      assert.strictEqual(row.status, "completed");
      assert.notProperty(row, "result");
      assert.notProperty(row, "task");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("starts a worker profile with its model, access and standing instructions", () =>
    Effect.gen(function* () {
      yield* setupParent();
      const service = yield* DelegationService;
      const started = yield* service.delegate(
        request({ provider: undefined, role: undefined, profile: "reviewer" }),
      );
      assert.strictEqual(started.profile, "reviewer");
      assert.strictEqual(started.role, "reviewer");
      assert.strictEqual(started.providerInstanceId, "codex");
      assert.strictEqual(started.model, "codex-other");
      assert.strictEqual(started.access, "read-only");

      const snapshots = yield* ProjectionSnapshotQuery;
      const child = Option.getOrThrow(yield* snapshots.getThreadDetailById(started.childThreadId));
      assert.include(child.messages[0]?.text ?? "", "Standing instructions:\nCite file and line.");

      // A profile is persisted with the record.
      assert.strictEqual((yield* service.get(started.id)).profile, "reviewer");
      const refused = yield* Effect.flip(
        service.delegate(request({ profile: "reviewer", access: "write" })),
      );
      assert.strictEqual(refused.code, "invalid_request");
    }).pipe(
      Effect.provide(
        makeLayer({
          profiles: [
            {
              name: "reviewer",
              description: "Independent code review.",
              provider: "codex",
              model: "codex-other",
              access: "read-only",
              workspace: null,
              instructions: "Cite file and line.",
              timeoutMinutes: null,
            },
          ],
        }),
      ),
    ),
  );

  it.effect("routes a standard role to its preferred provider with the role's defaults", () =>
    Effect.gen(function* () {
      yield* setupParent();
      const service = yield* DelegationService;
      const review = yield* service.delegate(request({ provider: undefined, role: "Reviewer" }));
      assert.strictEqual(review.role, "reviewer");
      assert.strictEqual(review.providerInstanceId, "codex");
      assert.strictEqual(review.access, "read-only");

      const snapshots = yield* ProjectionSnapshotQuery;
      const child = Option.getOrThrow(yield* snapshots.getThreadDetailById(review.childThreadId));
      assert.include(child.messages[0]?.text ?? "", "How to work: Review; do not fix.");

      // The implementer role defaults to write access in its own worktree.
      const change = yield* service.delegate(
        request({ provider: undefined, role: "implementer", executionMode: "background" }),
      );
      assert.strictEqual(change.access, "write");
      assert.strictEqual(change.workspaceMode, "worktree");
      assert.strictEqual(change.providerInstanceId, "claudeAgent");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("skips a role's preferred provider the parent may not delegate to", () =>
    Effect.gen(function* () {
      yield* setupParent();
      const service = yield* DelegationService;
      const review = yield* service.delegate(request({ provider: undefined, role: "reviewer" }));
      assert.strictEqual(review.providerInstanceId, "claudeAgent");
    }).pipe(
      Effect.provide(
        makeLayer({
          allowedTargets: {
            [ProviderDriverKind.make("claudeAgent")]: [ProviderDriverKind.make("claudeAgent")],
          },
        }),
      ),
    ),
  );

  it.effect("refuses to start while delegation is turned off", () =>
    Effect.gen(function* () {
      yield* setupParent();
      const service = yield* DelegationService;
      const error = yield* Effect.flip(service.delegate(request()));
      assert.strictEqual(error.code, "disabled");
    }).pipe(Effect.provide(makeLayer({ enabled: false }))),
  );

  it.effect("declines a read-only delegate's write approvals and allows reads", () =>
    Effect.gen(function* () {
      yield* setupParent();
      const service = yield* DelegationService;
      const started = yield* service.delegate(request());
      yield* setSession(started.childThreadId, "running", CHILD_TURN);

      const respond = (requestId: string, requestKind: string) =>
        Effect.gen(function* () {
          const response = yield* nextEvent(
            "thread.approval-response-requested",
            started.childThreadId,
          );
          yield* dispatch({
            type: "thread.activity.append",
            commandId: nextCommandId(),
            threadId: started.childThreadId,
            createdAt: NOW,
            activity: {
              id: EventId.make(`activity-${requestId}`),
              tone: "approval",
              kind: "approval.requested",
              summary: "Approval requested",
              payload: { requestId, requestKind, requestType: "file_change" },
              turnId: CHILD_TURN,
              createdAt: NOW,
            },
          });
          return (yield* Fiber.join(response)).payload;
        });

      const write = yield* respond("write-1", "file-change");
      assert.strictEqual(write.requestId, "write-1");
      assert.strictEqual(write.decision, "decline");
      const read = yield* respond("read-1", "file-read");
      assert.strictEqual(read.decision, "accept");
    }).pipe(Effect.scoped, Effect.provide(makeLayer())),
  );

  it.effect("reports a child that fails to start as a failed delegation", () =>
    Effect.gen(function* () {
      yield* setupParent();
      const service = yield* DelegationService;
      const started = yield* service.delegate(request());
      yield* setSession(started.childThreadId, "error", null, "codex is not signed in");
      const done = yield* settled(started);
      assert.strictEqual(done.status, "failed");
      assert.deepStrictEqual(done.failure, {
        code: "start_failed",
        message: "codex is not signed in",
      });
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("cancels a delegate and interrupts its turn", () =>
    Effect.gen(function* () {
      yield* setupParent();
      const service = yield* DelegationService;
      const started = yield* service.delegate(request());
      const interrupt = yield* nextEvent("thread.turn-interrupt-requested", started.childThreadId);

      const cancelled = yield* service.cancel(started.id);
      assert.strictEqual(cancelled.status, "cancelled");
      yield* Fiber.join(interrupt);
      // Settled delegations ignore the late events their interrupt produces.
      yield* setSession(started.childThreadId, "interrupted", null);
      assert.strictEqual((yield* service.get(started.id)).status, "cancelled");
    }).pipe(Effect.scoped, Effect.provide(makeLayer())),
  );

  it.effect("cancels active children when the parent's turn is interrupted", () =>
    Effect.gen(function* () {
      yield* setupParent();
      const service = yield* DelegationService;
      const started = yield* service.delegate(request({ executionMode: "background" }));
      yield* dispatch({
        type: "thread.turn.interrupt",
        commandId: nextCommandId(),
        threadId: PARENT_ID,
        createdAt: NOW,
      });
      const done = yield* settled(started);
      assert.strictEqual(done.status, "cancelled");
      assert.strictEqual(done.failure?.code, "parent_cancelled");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("enforces the depth limit through delegate chains", () =>
    Effect.gen(function* () {
      yield* setupParent();
      const service = yield* DelegationService;
      const first = yield* service.delegate(request({ executionMode: "background" }));
      yield* setSession(first.childThreadId, "running", CHILD_TURN);
      const second = yield* service.delegate(
        request({ parentThreadId: first.childThreadId, executionMode: "background" }),
      );
      assert.strictEqual(second.depth, 2);
      const error = yield* Effect.flip(
        service.delegate(request({ parentThreadId: second.childThreadId })),
      );
      assert.strictEqual(error.code, "depth_exceeded");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("limits concurrent delegates per parent thread", () =>
    Effect.gen(function* () {
      yield* setupParent();
      const service = yield* DelegationService;
      yield* service.delegate(request({ executionMode: "background" }));
      const error = yield* Effect.flip(service.delegate(request({ executionMode: "background" })));
      assert.strictEqual(error.code, "concurrency_exceeded");
    }).pipe(Effect.provide(makeLayer({ maxConcurrentPerThread: 1 }))),
  );

  it.effect("gives write delegates their own worktree", () =>
    Effect.gen(function* () {
      yield* setupParent();
      const service = yield* DelegationService;
      const started = yield* service.delegate(
        request({ access: "write", executionMode: "background" }),
      );
      assert.strictEqual(started.workspaceMode, "worktree");
      const snapshots = yield* ProjectionSnapshotQuery;
      const child = Option.getOrThrow(yield* snapshots.getThreadShellById(started.childThreadId));
      assert.strictEqual(child.worktreePath, "/tmp/delegation-worktree");
      assert.match(child.branch ?? "", /^t3code\/[0-9a-f]{8}$/);
      assert.strictEqual(child.runtimeMode, "full-access");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("times out a delegate that runs past its deadline", () =>
    Effect.gen(function* () {
      yield* setupParent();
      const service = yield* DelegationService;
      const started = yield* service.delegate(request({ timeoutMinutes: 5 }));
      yield* setSession(started.childThreadId, "running", CHILD_TURN);
      yield* TestClock.adjust("6 minutes");
      const done = yield* settled(started);
      assert.strictEqual(done.status, "timed_out");
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("DelegationService recovery", () => {
  it.effect("fails delegations a previous server left without a running child", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const databasePath = path.join(yield* fileSystem.makeTempDirectoryScoped(), "state.sqlite");

      // Each provide builds a fresh server over the same database and tears it down after.
      const started = yield* Effect.gen(function* () {
        yield* setupParent();
        const service = yield* DelegationService;
        return yield* service.delegate(request({ executionMode: "background" }));
      }).pipe(Effect.provide(makeLayer({}, databasePath)));

      const recovered = yield* Effect.flatMap(DelegationService, (service) =>
        service.awaitSettled(started.id, "1 minute"),
      ).pipe(Effect.provide(makeLayer({}, databasePath)));
      assert.strictEqual(recovered.status, "failed");
      assert.strictEqual(recovered.failure?.code, "orphaned");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
