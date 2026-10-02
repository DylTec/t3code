import { createDelegationEnvironmentAtoms } from "@t3tools/client-runtime/state/delegation";
import type { DelegationThreadSnapshot, ScopedThreadRef } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useServerConfigs } from "./entities";
import { useEnvironmentQuery } from "./query";

export const delegationEnvironment = createDelegationEnvironmentAtoms(connectionAtomRuntime);

/**
 * Who delegated this thread and the delegates it started, kept live. Only
 * subscribes where the environment has delegation on; servers without it
 * decode the setting as off, so they are never asked for an RPC they lack.
 */
export function useThreadDelegations(
  threadRef: ScopedThreadRef | null,
): DelegationThreadSnapshot | null {
  const serverConfigs = useServerConfigs();
  const enabled =
    threadRef !== null &&
    serverConfigs.get(threadRef.environmentId)?.settings.delegation.enabled === true;
  const query = useEnvironmentQuery(
    enabled
      ? delegationEnvironment.thread({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
  return enabled ? query.data : null;
}
