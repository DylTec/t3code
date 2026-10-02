import { DELEGATION_WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createDelegationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Server-pushed delegations for one thread: who delegated it, and the delegates it started. */
    thread: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:delegation:thread",
      tag: DELEGATION_WS_METHODS.subscribeThread,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:delegation:cancel",
      tag: DELEGATION_WS_METHODS.cancel,
    }),
  };
}
