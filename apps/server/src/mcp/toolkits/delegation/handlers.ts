import {
  type Delegation,
  DelegationError,
  DelegationId,
  isDelegationTerminal,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { DelegationService } from "../../../delegation/DelegationService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  DEFAULT_MAX_WAIT_SECONDS,
  type DelegateManyResult,
  DelegationToolkit,
  type DelegationToolResult,
  MAX_RESULT_CHARS,
} from "./tools.ts";

/** What the tools report for a delegation; exported so the shape is testable without a layer. */
export function toDelegationToolResult(delegation: Delegation): DelegationToolResult {
  const truncated = delegation.result !== null && delegation.result.length > MAX_RESULT_CHARS;
  const note = !isDelegationTerminal(delegation.status)
    ? `The delegate is still ${delegation.status}. Call wait_for_delegation with this delegationId to collect its result, or cancel_delegation to stop it.`
    : delegation.status === "completed" && delegation.result === null
      ? "The delegate finished without a final message. Its thread in T3 Code shows what it did."
      : truncated
        ? `The result was cut at ${MAX_RESULT_CHARS} characters; the full message is in the delegate's thread in T3 Code.`
        : delegation.status !== "completed"
          ? "You can retry, delegate to another provider, or continue without this result."
          : null;
  return {
    delegationId: delegation.id,
    childThreadId: delegation.childThreadId,
    providerInstanceId: delegation.providerInstanceId,
    driver: delegation.driver,
    model: delegation.model,
    role: delegation.role,
    access: delegation.access,
    workspace: delegation.workspaceMode,
    status: delegation.status,
    result:
      delegation.result === null || !truncated
        ? delegation.result
        : delegation.result.slice(0, MAX_RESULT_CHARS),
    resultTruncated: truncated,
    failure: delegation.failure,
    deadlineAt: delegation.deadlineAt,
    note,
  };
}

const unavailable = new DelegationError({
  code: "disabled",
  detail: "This T3 Code server was built without delegation support.",
});

const maxWait = (seconds: number | undefined) =>
  Duration.seconds(seconds ?? DEFAULT_MAX_WAIT_SECONDS);

const make = Effect.gen(function* () {
  // Optional so MCP runtimes assembled without delegation still build.
  const service = yield* Effect.serviceOption(DelegationService);
  const requireService = Effect.fromOption(service).pipe(Effect.mapError(() => unavailable));

  /** Agents manage only the delegations their own thread started. */
  const ownDelegation = Effect.fn("DelegationToolkit.ownDelegation")(function* (rawId: string) {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const delegations = yield* requireService;
    const delegation = yield* delegations.get(DelegationId.make(rawId));
    if (delegation.parentThreadId !== scope.threadId) {
      return yield* new DelegationError({
        code: "not_found",
        detail: `This thread did not start a delegation with id '${rawId}'.`,
      });
    }
    return { delegations, delegation };
  });

  return DelegationToolkit.of({
    delegate_agent: (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const delegations = yield* requireService;
        const executionMode = input.mode ?? "blocking";
        const started = yield* delegations.delegate({
          parentThreadId: scope.threadId,
          provider: input.provider,
          model: input.model,
          task: input.task,
          role: input.role,
          access: input.access,
          workspace: input.workspace,
          executionMode,
          timeoutMinutes: input.timeoutMinutes,
        });
        const current =
          executionMode === "blocking"
            ? yield* delegations.awaitSettled(started.id, maxWait(input.maxWaitSeconds))
            : started;
        return toDelegationToolResult(current);
      }),
    delegate_many: (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const delegations = yield* requireService;
        // Start in order so admission limits apply predictably, then wait together.
        const started = yield* Effect.forEach(input.delegates, (entry) =>
          delegations
            .delegate({
              parentThreadId: scope.threadId,
              provider: entry.provider,
              model: entry.model,
              task:
                entry.focus === undefined ? input.task : `${input.task}\n\nFocus: ${entry.focus}`,
              role: entry.role,
              access: input.access,
              workspace: input.workspace,
              executionMode: "background",
              timeoutMinutes: input.timeoutMinutes,
            })
            .pipe(Effect.result),
        );
        const collect = (
          outcome: Result.Result<Delegation, DelegationError>,
          index: number,
        ): Effect.Effect<DelegateManyResult["results"][number], DelegationError> => {
          const entry = input.delegates[index]!;
          const base = { provider: entry.provider, role: entry.role ?? null };
          if (Result.isFailure(outcome)) {
            const { code, detail } = outcome.failure;
            return Effect.succeed({ ...base, delegation: null, error: { code, detail } });
          }
          return delegations.awaitSettled(outcome.success.id, maxWait(input.maxWaitSeconds)).pipe(
            Effect.map((current) => ({
              ...base,
              delegation: toDelegationToolResult(current),
              error: null,
            })),
          );
        };
        const results = yield* Effect.forEach(started, collect, { concurrency: "unbounded" });
        return { results };
      }),
    wait_for_delegation: (input) =>
      Effect.gen(function* () {
        const { delegations, delegation } = yield* ownDelegation(input.delegationId);
        const current = yield* delegations.awaitSettled(
          delegation.id,
          maxWait(input.maxWaitSeconds),
        );
        return toDelegationToolResult(current);
      }),
    get_delegation: (input) =>
      ownDelegation(input.delegationId).pipe(
        Effect.map(({ delegation }) => toDelegationToolResult(delegation)),
      ),
    list_delegations: () =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const delegations = yield* requireService;
        const snapshot = yield* delegations.threadSnapshot(scope.threadId);
        return {
          delegatedBy:
            snapshot.parent === null
              ? null
              : {
                  delegationId: snapshot.parent.id,
                  parentThreadId: snapshot.parent.parentThreadId,
                  depth: snapshot.parent.depth,
                },
          delegations: snapshot.children.map(toDelegationToolResult),
        };
      }),
    cancel_delegation: (input) =>
      Effect.gen(function* () {
        const { delegations, delegation } = yield* ownDelegation(input.delegationId);
        return toDelegationToolResult(yield* delegations.cancel(delegation.id));
      }),
    list_delegation_targets: () =>
      Effect.gen(function* () {
        const delegations = yield* requireService;
        return {
          enabled: yield* delegations.enabled,
          targets: yield* delegations.listTargets,
        };
      }),
  });
});

export const DelegationToolkitHandlersLive = DelegationToolkit.toLayer(make);
