import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type DelegationStatus,
  type DelegationSummary,
  type EnvironmentId,
  isDelegationTerminal,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { WorkflowIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useThreadShell } from "~/state/entities";
import { delegationEnvironment, useThreadDelegations } from "~/state/delegation";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { Button } from "../ui/button";

const STATUS_LABELS: Record<DelegationStatus, string> = {
  queued: "Queued",
  starting: "Starting",
  running: "Working",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  timed_out: "Timed out",
};

function roleLabel(delegation: DelegationSummary): string {
  const role = delegation.role ?? "delegate";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function ThreadLink({ threadRef, fallback }: { threadRef: ScopedThreadRef; fallback: string }) {
  const thread = useThreadShell(threadRef);
  return (
    <Link
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(threadRef)}
      className="min-w-0 truncate underline-offset-2 hover:underline"
    >
      {thread?.title ?? fallback}
    </Link>
  );
}

function CancelButton({
  environmentId,
  delegation,
}: {
  environmentId: EnvironmentId;
  delegation: DelegationSummary;
}) {
  const cancel = useAtomCommand(delegationEnvironment.cancel, "Cancel delegate");
  const [pending, setPending] = useState(false);
  const onClick = useCallback(() => {
    setPending(true);
    void cancel({ environmentId, input: { delegationId: delegation.id } }).finally(() =>
      setPending(false),
    );
  }, [cancel, delegation.id, environmentId]);
  return (
    <Button size="xs" variant="ghost" disabled={pending} onClick={onClick}>
      {pending ? "Cancelling..." : "Cancel"}
    </Button>
  );
}

function DelegateRow({
  environmentId,
  delegation,
}: {
  environmentId: EnvironmentId;
  delegation: DelegationSummary;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <ProviderInstanceIcon
        driverKind={delegation.driver}
        displayName={delegation.providerInstanceId}
        iconClassName="size-3.5 shrink-0 opacity-70"
      />
      <ThreadLink
        threadRef={scopeThreadRef(environmentId, delegation.childThreadId)}
        fallback={roleLabel(delegation)}
      />
      <span className="shrink-0 text-muted-foreground">{STATUS_LABELS[delegation.status]}</span>
      <span className="ml-auto shrink-0">
        <CancelButton environmentId={environmentId} delegation={delegation} />
      </span>
    </div>
  );
}

/**
 * Composer banners for delegation: on a delegate's thread, which thread
 * delegated it; on a delegating thread, the delegates still working, each
 * linked to its own thread and cancellable.
 */
export function useDelegationBannerItems(
  threadRef: ScopedThreadRef | null,
): ReadonlyArray<ComposerBannerStackItem> {
  const snapshot = useThreadDelegations(threadRef);
  return useMemo(() => {
    if (threadRef === null || snapshot === null) return [];
    const { environmentId } = threadRef;
    const items: ComposerBannerStackItem[] = [];
    const parent = snapshot.parent;
    if (parent !== null) {
      const active = !isDelegationTerminal(parent.status);
      items.push({
        id: `delegation-parent:${parent.id}`,
        variant: "info",
        compact: true,
        icon: <WorkflowIcon />,
        title: (
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 font-normal text-muted-foreground">Delegated by</span>
            <ThreadLink
              threadRef={scopeThreadRef(environmentId, parent.parentThreadId)}
              fallback="another thread"
            />
          </span>
        ),
        description: `${roleLabel(parent)} · ${parent.access} · ${STATUS_LABELS[parent.status]}`,
        ...(active
          ? { actions: <CancelButton environmentId={environmentId} delegation={parent} /> }
          : {}),
      });
    }
    const working = snapshot.children.filter((child) => !isDelegationTerminal(child.status));
    if (working.length > 0) {
      items.push({
        id: `delegation-children:${snapshot.threadId}`,
        variant: "default",
        priority: "activity",
        icon: <WorkflowIcon />,
        title: `${working.length} ${working.length === 1 ? "delegate" : "delegates"} working`,
        children: (
          <div className="flex flex-col gap-1">
            {working.map((child) => (
              <DelegateRow key={child.id} environmentId={environmentId} delegation={child} />
            ))}
          </div>
        ),
      });
    }
    return items;
  }, [snapshot, threadRef]);
}
