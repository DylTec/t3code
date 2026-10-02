/**
 * Pure delegation decisions: which provider instance and model a request
 * resolves to, whether limits admit it, what the child is told, and how a
 * read-only child's approval requests are answered. No I/O lives here.
 */
import * as Schema from "effect/Schema";
import {
  DELEGATION_ROLE_DESCRIPTIONS,
  DELEGATION_ROLES,
  DEFAULT_MODEL_BY_PROVIDER,
  type DelegationAccess,
  DelegationError,
  type DelegationProfile,
  type DelegationProfileTarget,
  type DelegationRole,
  type DelegationRoleTarget,
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

/** One line per profile, for errors that ask the agent to pick one. */
function profileMenu(profiles: ReadonlyArray<DelegationProfile>): string {
  return profiles.length === 0
    ? "The user has not set up any profiles."
    : `Profiles: ${profiles.map((profile) => `${profile.name} (${profile.description})`).join("; ")}.`;
}

export interface DelegationChoice {
  readonly profile?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly access?: DelegationAccess | undefined;
  readonly workspace?: DelegationWorkspaceMode | undefined;
  readonly role?: string | undefined;
  readonly timeoutMinutes?: number | undefined;
}

const ROLE_ALIASES: Readonly<Record<string, DelegationRole>> = {
  review: "reviewer",
  "code-reviewer": "reviewer",
  research: "researcher",
  debug: "debugger",
  tester: "test-author",
  "test-writer": "test-author",
  security: "security-reviewer",
  performance: "performance-reviewer",
  "perf-reviewer": "performance-reviewer",
};

/** The standard role a free-text role names, if any: `Security Reviewer` → `security-reviewer`. */
export function standardRoleOf(role: string | null): DelegationRole | null {
  if (role === null) return null;
  const slug = role
    .trim()
    .toLowerCase()
    .replaceAll(/[\s_]+/g, "-");
  return DELEGATION_ROLES.find((standard) => standard === slug) ?? ROLE_ALIASES[slug] ?? null;
}

export interface ResolvedChoice {
  readonly profile: DelegationProfile | null;
  /** Providers to try in order; the first that can take work runs the task. */
  readonly providers: ReadonlyArray<string>;
  readonly model: string | undefined;
  readonly access: DelegationAccess | undefined;
  readonly workspace: DelegationWorkspaceMode | undefined;
  /** The label shown in T3; a standard role's canonical name when one matched. */
  readonly role: string | null;
  readonly standardRole: DelegationRole | null;
  readonly timeoutMinutes: number | undefined;
}

/**
 * Work out who runs a request and with what defaults. Precedence, highest
 * first: the request, the named profile, the standard role, global defaults.
 * Every field a profile sets is fixed: a request that names a different value
 * is refused rather than silently overridden, so an agent cannot widen a
 * read-only worker's access. A role's defaults are only defaults.
 */
export function resolveChoice(
  request: DelegationChoice,
  settings: DelegationSettings,
): ResolvedChoice | DelegationError {
  const label = request.role?.trim() || null;
  if (request.profile === undefined) {
    if (settings.requireProfile) {
      return new DelegationError({
        code: "profile_required",
        detail: `T3 Code settings only allow delegating to a profile. ${profileMenu(settings.profiles)}`,
      });
    }
    const standardRole = standardRoleOf(label);
    const roleDefaults = standardRole === null ? null : settings.roles[standardRole];
    const providers =
      request.provider !== undefined
        ? [request.provider]
        : (roleDefaults?.preferredProviders ?? []);
    if (providers.length === 0) {
      return new DelegationError({
        code: "invalid_request",
        detail:
          standardRole === null
            ? `Name a profile, a provider, or a standard role (${DELEGATION_ROLES.join(", ")}). ${profileMenu(settings.profiles)}`
            : `The ${standardRole} role has no preferred providers in T3 Code settings. Name a provider.`,
      });
    }
    return {
      profile: null,
      providers,
      model: request.model,
      access: request.access ?? roleDefaults?.access,
      workspace: request.workspace,
      role: standardRole ?? label,
      standardRole,
      timeoutMinutes: request.timeoutMinutes,
    };
  }
  const name = request.profile.trim().toLowerCase();
  const profile = settings.profiles.find((candidate) => candidate.name === name);
  if (profile === undefined) {
    return new DelegationError({
      code: "profile_not_found",
      detail: `No profile named '${request.profile}'. ${profileMenu(settings.profiles)}`,
    });
  }
  const same = (left: string, right: string) =>
    left.trim().toLowerCase() === right.trim().toLowerCase();
  const conflicts = [
    request.provider !== undefined && !same(request.provider, profile.provider) && "provider",
    request.model !== undefined &&
      profile.model !== null &&
      request.model !== profile.model &&
      "model",
    request.access !== undefined && request.access !== profile.access && "access",
    request.workspace !== undefined &&
      profile.workspace !== null &&
      request.workspace !== profile.workspace &&
      "workspace",
  ].filter((field) => field !== false);
  if (conflicts.length > 0) {
    return new DelegationError({
      code: "invalid_request",
      detail: `Profile '${profile.name}' fixes ${conflicts.join(", ")}. Omit ${conflicts.length === 1 ? "it" : "them"}, or choose another profile.`,
    });
  }
  const role = label ?? profile.name;
  const standardRole = standardRoleOf(role);
  return {
    profile,
    providers: [profile.provider],
    model: profile.model ?? request.model,
    access: profile.access,
    workspace: profile.workspace ?? request.workspace,
    role: standardRole ?? role,
    standardRole,
    timeoutMinutes: request.timeoutMinutes ?? profile.timeoutMinutes ?? undefined,
  };
}

/**
 * The first candidate that can take work. With several candidates (a role's
 * preferences), one the user's `allowedTargets` rules out is skipped; a lone
 * candidate is returned so admission can refuse it with its own reason.
 */
export function pickProvider(
  candidates: ReadonlyArray<string>,
  providers: ReadonlyArray<ServerProvider>,
  isAllowed: (provider: ServerProvider) => boolean,
): ServerProvider | DelegationError {
  const resolved = candidates.map((candidate) => resolveTargetProvider(candidate, providers));
  const usable = resolved.filter((result): result is ServerProvider => !isDelegationError(result));
  const first = usable.find(isAllowed) ?? (candidates.length === 1 ? usable[0] : undefined);
  if (first !== undefined) return first;
  if (candidates.length === 1) return resolved[0]!;
  const reasons = candidates.map((candidate, index) => {
    const result = resolved[index]!;
    return `${candidate}: ${isDelegationError(result) ? result.detail : "not allowed by T3 Code settings"}`;
  });
  return new DelegationError({
    code: "provider_unavailable",
    detail: `None of the preferred providers can take work. ${reasons.join("; ")}. Name another provider.`,
  });
}

/** A standard role with the instance its preferences pick right now. */
export function toRoleTarget(
  role: DelegationRole,
  settings: DelegationSettings,
  providers: ReadonlyArray<ServerProvider>,
): DelegationRoleTarget {
  const defaults = settings.roles[role];
  const picked =
    defaults.preferredProviders.length === 0
      ? null
      : pickProvider(defaults.preferredProviders, providers, () => true);
  return {
    name: role,
    description: DELEGATION_ROLE_DESCRIPTIONS[role],
    ...defaults,
    providerInstanceId: picked === null || isDelegationError(picked) ? null : picked.instanceId,
    unavailableReason:
      picked === null
        ? "No preferred providers; name one."
        : isDelegationError(picked)
          ? picked.detail
          : null,
  };
}

/** A profile with the instance it would run on now, or why it cannot run. */
export function toProfileTarget(
  profile: DelegationProfile,
  providers: ReadonlyArray<ServerProvider>,
): DelegationProfileTarget {
  const target = resolveTargetProvider(profile.provider, providers);
  return isDelegationError(target)
    ? { ...profile, providerInstanceId: null, available: false, unavailableReason: target.detail }
    : {
        ...profile,
        providerInstanceId: target.instanceId,
        available: true,
        unavailableReason: null,
      };
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
/** How each standard role should work and report, added to the delegate's prompt. */
const ROLE_GUIDANCE: Record<DelegationRole, string> = {
  implementer:
    "Make the change, keep it scoped to the task, and run the relevant checks. Report what you changed and how you verified it.",
  reviewer:
    "Review; do not fix. Report each finding with its severity, file path and line, and why it matters. If you find nothing, say so plainly.",
  researcher:
    "Cite a source for every claim (a URL or a file path) and keep facts separate from inference.",
  debugger:
    "Reproduce the failure before explaining it. Report the root cause with evidence and the smallest fix. You may edit this worktree to investigate.",
  "test-author":
    "Write tests that would fail without the behavior they cover. Run them and report the actual results.",
  "security-reviewer":
    "Do not change code. Report each vulnerability with its severity, file path and line, how it could be exploited, and a fix.",
  architect:
    "Compare at least two approaches with their trade-offs, then recommend one and say why.",
  "performance-reviewer":
    "Back every finding with a measurement or a concrete cost argument, with file path and line.",
};

export function buildChildPrompt(input: {
  readonly task: string;
  readonly role: string | null;
  readonly standardRole?: DelegationRole | null | undefined;
  readonly access: DelegationAccess;
  readonly workspaceMode: DelegationWorkspaceMode;
  readonly parentThreadTitle: string;
  readonly parentProvider: string | null;
  /** The profile's standing instructions, if any. */
  readonly instructions?: string | undefined;
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
    ...(input.standardRole ? [`How to work: ${ROLE_GUIDANCE[input.standardRole]}`] : []),
    `Access: ${access}`,
    `Workspace: ${workspace}`,
    "",
    ...(input.instructions?.trim()
      ? ["Standing instructions:", input.instructions.trim(), ""]
      : []),
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
