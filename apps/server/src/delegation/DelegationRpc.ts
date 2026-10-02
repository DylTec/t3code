import {
  DELEGATION_WS_METHODS,
  type DelegationByIdInput,
  type DelegationCreateInput,
  DelegationError,
  type DelegationThreadInput,
  type EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { DelegationService } from "./DelegationService.ts";

/** The connection's authorize-and-instrument wrappers from `ws.ts`. */
export interface DelegationRpcObservers {
  readonly observeRpcEffect: <A, E, R>(
    method: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;
  readonly observeRpcStream: <A, E, R>(
    method: string,
    stream: Stream.Stream<A, E, R>,
  ) => Stream.Stream<A, E | EnvironmentAuthorizationError, R>;
}

/**
 * WebSocket handlers for `DelegationRpcGroup`, spread into the connection's
 * `WsRpcGroup` handlers. Clients start delegations in the background; only an
 * agent's MCP call blocks on the result.
 *
 * The service is optional so runtimes assembled without delegation, such as
 * upstream's server tests, still build; their delegation RPCs fail cleanly.
 */
export const makeDelegationRpcHandlers = Effect.fn("makeDelegationRpcHandlers")(function* ({
  observeRpcEffect,
  observeRpcStream,
}: DelegationRpcObservers) {
  const service = yield* Effect.serviceOption(DelegationService);
  const unavailable = new DelegationError({
    code: "disabled",
    detail: "This T3 Code server was built without delegation support.",
  });
  const withService = <A>(
    use: (delegations: DelegationService["Service"]) => Effect.Effect<A, DelegationError>,
  ) => Option.match(service, { onNone: () => Effect.fail(unavailable), onSome: use });
  return {
    [DELEGATION_WS_METHODS.create]: (input: DelegationCreateInput) =>
      observeRpcEffect(
        DELEGATION_WS_METHODS.create,
        withService((delegations) =>
          delegations.delegate({ ...input, executionMode: "background" }),
        ),
      ),
    [DELEGATION_WS_METHODS.get]: (input: DelegationByIdInput) =>
      observeRpcEffect(
        DELEGATION_WS_METHODS.get,
        withService((delegations) => delegations.get(input.delegationId)),
      ),
    [DELEGATION_WS_METHODS.cancel]: (input: DelegationByIdInput) =>
      observeRpcEffect(
        DELEGATION_WS_METHODS.cancel,
        withService((delegations) => delegations.cancel(input.delegationId)),
      ),
    [DELEGATION_WS_METHODS.listTargets]: (_input: DelegationThreadInput) =>
      observeRpcEffect(
        DELEGATION_WS_METHODS.listTargets,
        withService((delegations) => delegations.listTargets),
      ),
    [DELEGATION_WS_METHODS.subscribeThread]: (input: DelegationThreadInput) =>
      observeRpcStream(
        DELEGATION_WS_METHODS.subscribeThread,
        Option.match(service, {
          onNone: () => Stream.fail(unavailable),
          onSome: (delegations) => delegations.streamThread(input.threadId),
        }),
      ),
  };
});
