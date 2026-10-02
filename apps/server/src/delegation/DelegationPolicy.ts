/**
 * Pure delegation decisions: which provider instance and model a request
 * resolves to, whether limits admit it, what the child is told, and how a
 * read-only child's approval requests are answered. No I/O lives here.
 */
import * as Schema from "effect/Schema";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  type DelegationAccess,
  DelegationError,
  type DelegationSettings,
  type DelegationTarget,
  type DelegationWorkspaceMode,
  isProviderAvailable,
  type OrchestrationMessage,
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ServerProvider,
  type TurnId,
} from "@t3tools/contracts";

/** Driver kinds agents commonly call by their product name. */
const DRIVER_ALIASES: Readonly<Record<string, string>> = {
  claude: "claudeAgent",
  "claude-code": "claudeAgent",
  claudecode: "claudeAgent",
};

export function unavailableReason(provider: ServerProvider): string | null {
  if (!isProviderAvailable(provider)) {
    return provider.unavailableReason ?? "The provider driver is not available in this build.";
  }
  if (!provider.enabled) return "The provider instance is disabled in T3 Code settings.";
  if (!provider.installed) return "The provider CLI is not installed.";
  if (provider.status === "error" || provider.status === "disabled") {
    return provider.message ?? `The provider reports status '${provider.status}'.`;
  }
  if (provider.auth.status === "unauthenticated") return "The provider is not signed in.";
  return null;
}

/** The instance T3 Code creates for a driver shares the driver's slug. */
const isDefaultInstance = (provider: ServerProvider): boolean =>
  String(provider.instanceId) === String(provider.driver);

/** Explicit model first, then the provider's own default, then T3's per-driver default. */
function defaultModelFor(provider: ServerProvider): string | null {
  const models = provider.models.filter((model) => model.isLegacy !== true);
  const fallback = DEFAULT_MODEL_BY_PROVIDER[provider.driver];
  return (
    models.find((model) => model.isDefault === true)?.slug ??
    (fallback !== undefined && models.some((model) => model.slug === fallback)
      ? fallback
      : undefined) ??
    models[0]?.slug ??
    fallback ??
    null
  );
}

export function toDelegationTarget(provider: ServerProvider): DelegationTarget {
  return {
    providerInstanceId: provider.instanceId,
    driver: provider.driver,
    displayName: provider.displayName ?? null,
    available: unavailableReason(provider) === null,
    unavailableReason: unavailableReason(provider),
    defaultModel: defaultModelFor(provider),
    models: provider.models.filter((model) => model.isLegacy !== true).map((model) => model.slug),
  };
}

export const isDelegationError = Schema.is(DelegationError);

/**
 * Resolve the provider an agent asked for. A driver kind (or alias such as
 * `claude`) picks that driver's default instance, then its first available
 * instance; any other name must be an exact instance id. Explicit routing only:
 * an unavailable choice fails rather than falling back to another driver.
 */
export function resolveTargetProvider(
  requested: string,
  providers: ReadonlyArray<ServerProvider>,
): ServerProvider | DelegationError {
  const normalized = requested.trim();
  const driver = DRIVER_ALIASES[normalized.toLowerCase()] ?? normalized;
  // A default instance shares its driver's slug, so a driver name is read as
  // "any instance of this driver, default first" rather than one instance.
  const byDriver = providers
    .filter((provider) => provider.driver === driver)
    .toSorted((left, right) => Number(isDefaultInstance(right)) - Number(isDefaultInstance(left)));
  const candidates =
    byDriver.length > 0
      ? byDriver
      : providers.filter((provider) => provider.instanceId === normalized);
  if (candidates.length === 0) {
    const known = providers.map((provider) => provider.instanceId).join(", ");
    return new DelegationError({
      code: "provider_not_found",
      detail: `No provider instance or driver named '${normalized}'. Call list_delegation_targets to see the configured instances${known ? ` (${known})` : ""}.`,
    });
  }
  const available = candidates.find((provider) => unavailableReason(provider) === null);
  if (available) return available;
  const first = candidates[0]!;
  return new DelegationError({
    code: "provider_unavailable",
    detail: `Provider '${first.instanceId}' cannot take work: ${unavailableReason(first)}`,
  });
}

export function resolveModel(
  provider: ServerProvider,
  requestedModel: string | undefined,
): string | DelegationError {
  if (requestedModel !== undefined) return requestedModel;
  return (
    defaultModelFor(provider) ??
    new DelegationError({
      code: "provider_unavailable",
      detail: `Provider '${provider.instanceId}' reports no models. Pass a model explicitly.`,
    })
  );
}

export interface AdmissionInput {
  readonly settings: DelegationSettings;
  readonly parentDriver: ProviderDriverKind | null;
  readonly targetDriver: ProviderDriverKind;
  readonly childDepth: number;
  readonly access: DelegationAccess;
  readonly workspaceMode: DelegationWorkspaceMode;
  readonly activeGlobal: number;
  readonly activeForParent: number;
  readonly childrenThisTurn: number;
}

/** The first limit a request breaks, or undefined when it may start. */
export function checkAdmission(input: AdmissionInput): DelegationError | undefined {
  const { settings } = input;
  if (!settings.enabled) {
    return new DelegationError({
      code: "disabled",
      detail: "Delegation is turned off. The user can enable it in T3 Code Settings → Delegation.",
    });
  }
  if (input.access === "write" && input.workspaceMode === "current") {
    return new DelegationError({
      code: "invalid_request",
      detail:
        "Write access needs its own checkout. Use workspace 'worktree', or access 'read-only' to share this checkout.",
    });
  }
  if (input.childDepth > settings.maxDepth) {
    return new DelegationError({
      code: "depth_exceeded",
      detail: `Delegation depth limit (${settings.maxDepth}) reached: this thread is itself a delegate and may not delegate further.`,
    });
  }
  if (input.parentDriver !== null) {
    const allowed = settings.allowedTargets[input.parentDriver];
    if (allowed !== undefined && !allowed.includes(input.targetDriver)) {
      return new DelegationError({
        code: "provider_not_allowed",
        detail: `T3 Code settings do not allow ${input.parentDriver} threads to delegate to ${input.targetDriver}. Allowed: ${allowed.join(", ") || "none"}.`,
      });
    }
  }
  if (input.childrenThisTurn >= settings.maxChildrenPerTurn) {
    return new DelegationError({
      code: "children_per_turn_exceeded",
      detail: `This turn already started ${input.childrenThisTurn} delegations (limit ${settings.maxChildrenPerTurn}).`,
    });
  }
  if (input.activeForParent >= settings.maxConcurrentPerThread) {
    return new DelegationError({
      code: "concurrency_exceeded",
      detail: `This thread already has ${input.activeForParent} running delegations (limit ${settings.maxConcurrentPerThread}). Wait for one to finish or cancel it.`,
    });
  }
  if (input.activeGlobal >= settings.maxConcurrentGlobal) {
    return new DelegationError({
      code: "concurrency_exceeded",
      detail: `T3 Code is already running ${input.activeGlobal} delegations (limit ${settings.maxConcurrentGlobal}). Wait for one to finish.`,
    });
  }
  return undefined;
}

const TITLE_TASK_CHARS = 60;

export function childThreadTitle(role: string | null, task: string): string {
  const firstLine = task.trim().split("\n", 1)[0]!.trim();
  const summary =
    firstLine.length > TITLE_TASK_CHARS ? `${firstLine.slice(0, TITLE_TASK_CHARS)}…` : firstLine;
  const label = role === null ? "Delegate" : role.charAt(0).toUpperCase() + role.slice(1);
  return `${label}: ${summary}`;
}

/**
 * The child's first message. It states the constraints the server enforces
 * and asks for a self-contained final answer, because that one message is all
 * the parent receives.
 */
export function buildChildPrompt(input: {
  readonly task: string;
  readonly role: string | null;
  readonly access: DelegationAccess;
  readonly workspaceMode: DelegationWorkspaceMode;
  readonly parentThreadTitle: string;
  readonly parentProvider: string | null;
}): string {
  const delegator = input.parentProvider
    ? `a ${input.parentProvider} agent in the T3 Code thread "${input.parentThreadTitle}"`
    : `the T3 Code thread "${input.parentThreadTitle}"`;
  const access =
    input.access === "read-only"
      ? "Read-only. Do not edit files, create commits, or otherwise change the workspace; T3 Code declines write approvals for this thread."
      : "Write. You may edit files in this workspace.";
  const workspace =
    input.workspaceMode === "worktree"
      ? "A dedicated Git worktree branched from the delegating thread's checkout."
      : "The same checkout the delegating agent is working in. It may have uncommitted changes; that is expected.";
  return [
    `You were delegated a task by ${delegator}.`,
    "",
    ...(input.role === null ? [] : [`Role: ${input.role}`]),
    `Access: ${access}`,
    `Workspace: ${workspace}`,
    "",
    "Task:",
    input.task.trim(),
    "",
    "Your final message is returned verbatim to the delegating agent, which cannot see your other messages or tool output. Make it self-contained: state findings, evidence (file paths and line numbers), and any recommended changes.",
  ].join("\n");
}

/**
 * How a read-only child's approval request is answered. Reads are allowed;
 * anything that could change the workspace or reach outside it is declined so
 * the provider continues with that action refused.
 */
export function readOnlyApprovalDecision(
  requestKind: string | undefined,
): ProviderApprovalDecision {
  return requestKind === "file-read" ? "accept" : "decline";
}

/** The child's last non-empty assistant message from the delegated turn. */
export function finalAssistantText(
  messages: ReadonlyArray<OrchestrationMessage>,
  turnId: TurnId | null,
): string | null {
  const assistant = messages.filter(
    (message) => message.role === "assistant" && message.text.trim().length > 0,
  );
  const fromTurn =
    turnId === null ? assistant : assistant.filter((message) => message.turnId === turnId);
  const candidates = fromTurn.length > 0 ? fromTurn : assistant;
  return candidates.at(-1)?.text.trim() ?? null;
}
