import {
  type Delegation,
  DelegationError,
  DelegationId,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import { type DelegateRequest, DelegationService } from "../../../delegation/DelegationService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DelegationToolkitHandlersLive, toDelegationToolResult } from "./handlers.ts";
import { DelegationToolkit, MAX_RESULT_CHARS } from "./tools.ts";

const PARENT = ThreadId.make("parent-thread");

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: PARENT,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  capabilities: new Set(["pull-requests"]),
  issuedAt: 1,
};

const makeDelegation = (overrides: Partial<Delegation> = {}): Delegation => ({
  id: DelegationId.make("del_1"),
  parentThreadId: PARENT,
  parentTurnId: null,
  childThreadId: ThreadId.make("child-thread"),
  requestedProvider: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  model: "gpt-6-astra",
  role: "reviewer",
  profile: null,
  task: "Review the diff.",
  access: "read-only",
  workspaceMode: "current",
  executionMode: "blocking",
  depth: 1,
  status: "starting",
  createdAt: "2026-10-01T00:00:00.000Z",
  startedAt: null,
  completedAt: null,
  deadlineAt: "2026-10-01T00:15:00.000Z",
  result: null,
  failure: null,
  ...overrides,
});

const makeHarness = Effect.fn("makeDelegationToolkitHarness")(function* (
  stored: Delegation = makeDelegation(),
) {
  const requests = yield* Ref.make<ReadonlyArray<DelegateRequest>>([]);
  const completed = makeDelegation({ ...stored, status: "completed", result: "Two bugs." });
  const service = Layer.mock(DelegationService)({
    delegate: (request) =>
      Ref.update(requests, (all) => [...all, request]).pipe(
        Effect.andThen(
          request.provider === "unknown"
            ? Effect.fail(new DelegationError({ code: "provider_not_found", detail: "nope" }))
            : Effect.succeed(stored),
        ),
      ),
    awaitSettled: () => Effect.succeed(completed),
    get: () => Effect.succeed(stored),
    cancel: () => Effect.succeed({ ...stored, status: "cancelled" as const }),
    threadSnapshot: () => Effect.succeed({ threadId: PARENT, parent: null, children: [stored] }),
    streamThread: () => Stream.empty,
    listTargets: Effect.succeed({
      enabled: true,
      requireProfile: false,
      profiles: [
        {
          name: "reviewer",
          description: "Independent code review.",
          provider: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          model: null,
          access: "read-only" as const,
          workspace: null,
          instructions: "Report findings by severity.",
          timeoutMinutes: null,
          available: true,
          unavailableReason: null,
        },
      ],
      roles: [],
      providers: [],
    }),
  });
  const toolkit = yield* DelegationToolkit.pipe(
    Effect.provide(DelegationToolkitHandlersLive.pipe(Layer.provide(service))),
  );
  const call = <Name extends keyof typeof DelegationToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof DelegationToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    );
  return { requests, call };
});

describe("delegation toolkit handlers", () => {
  it.effect("delegates on behalf of the calling thread and waits for the result", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("delegate_agent", {
        provider: "codex",
        task: "Review the diff.",
        role: "reviewer",
      });
      expect(result).toMatchObject({ status: "completed", result: "Two bugs.", note: null });
      expect(yield* Ref.get(harness.requests)).toMatchObject([
        { parentThreadId: PARENT, provider: "codex", executionMode: "blocking" },
      ]);
    }),
  );

  it.effect("returns at once in background mode with a hint to collect the result", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("delegate_agent", {
        provider: "codex",
        task: "Review the diff.",
        mode: "background",
      });
      expect(result.status).toBe("starting");
      expect(result.note).toContain("wait_for_delegation");
    }),
  );

  it.effect("fans one task out to several delegates and keeps going past a refusal", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const { results } = yield* harness.call("delegate_many", {
        task: "Review the diff.",
        delegates: [
          { provider: "codex", role: "correctness", focus: "Error handling." },
          { provider: "unknown", role: "tests" },
        ],
      });
      expect(results).toMatchObject([
        {
          provider: "codex",
          role: "correctness",
          delegation: { status: "completed" },
          error: null,
        },
        { provider: "unknown", delegation: null, error: { code: "provider_not_found" } },
      ]);
      const requests = yield* Ref.get(harness.requests);
      expect(requests.map((request) => request.executionMode)).toEqual([
        "background",
        "background",
      ]);
      expect(requests[0]?.task).toBe("Review the diff.\n\nFocus: Error handling.");
    }),
  );

  it.effect("offers profiles by name and description without their standing instructions", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const targets = yield* harness.call("list_delegation_targets", {});
      expect(targets.profiles).toEqual([
        expect.objectContaining({ name: "reviewer", description: "Independent code review." }),
      ]);
      expect(targets.profiles[0]).not.toHaveProperty("instructions");

      yield* harness.call("delegate_agent", { profile: "reviewer", task: "Review the diff." });
      expect((yield* Ref.get(harness.requests)).at(-1)).toMatchObject({
        profile: "reviewer",
        provider: undefined,
      });
    }),
  );

  it.effect("only manages delegations the calling thread started", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        makeDelegation({ parentThreadId: ThreadId.make("someone-else") }),
      );
      for (const name of ["get_delegation", "wait_for_delegation", "cancel_delegation"] as const) {
        const error = yield* harness.call(name, { delegationId: "del_1" }).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "DelegationError", code: "not_found" });
      }
    }),
  );

  it.effect("fails cleanly when the server runs without delegation", () =>
    Effect.gen(function* () {
      const toolkit = yield* DelegationToolkit.pipe(Effect.provide(DelegationToolkitHandlersLive));
      const error = yield* toolkit
        .handle("list_delegations", {})
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.flip,
        );
      expect(error).toMatchObject({ _tag: "DelegationError", code: "disabled" });
    }),
  );
});

describe("toDelegationToolResult", () => {
  it("cuts oversized results and says where the rest is", () => {
    const result = toDelegationToolResult(
      makeDelegation({ status: "completed", result: "x".repeat(MAX_RESULT_CHARS + 10) }),
    );
    expect(result.result).toHaveLength(MAX_RESULT_CHARS);
    expect(result.resultTruncated).toBe(true);
    expect(result.note).toContain("delegate's thread");
  });

  it("tells the agent its options after a failure", () => {
    const result = toDelegationToolResult(
      makeDelegation({
        status: "failed",
        failure: { code: "start_failed", message: "codex is not signed in" },
      }),
    );
    expect(result.failure?.code).toBe("start_failed");
    expect(result.note).toContain("another provider");
  });
});
