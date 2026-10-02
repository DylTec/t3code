import {
  DelegationSettings,
  MessageId,
  type OrchestrationMessage,
  ProviderDriverKind,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import * as DelegationPolicy from "./DelegationPolicy.ts";
import { claudeProvider, codexProvider, makeProvider, openCodeProvider } from "./testFixtures.ts";

const decodeSettings = Schema.decodeSync(DelegationSettings);
const enabledSettings = decodeSettings({ enabled: true });
const codexDriver = ProviderDriverKind.make("codex");
const claudeDriver = ProviderDriverKind.make("claudeAgent");

const admission = (overrides: Partial<DelegationPolicy.AdmissionInput> = {}) =>
  DelegationPolicy.checkAdmission({
    settings: enabledSettings,
    parentDriver: claudeDriver,
    targetDriver: codexDriver,
    childDepth: 1,
    access: "read-only",
    workspaceMode: "current",
    activeGlobal: 0,
    activeForParent: 0,
    childrenThisTurn: 0,
    ...overrides,
  });

const message = (
  id: string,
  role: OrchestrationMessage["role"],
  text: string,
  turnId: string | null,
): OrchestrationMessage => ({
  id: MessageId.make(id),
  role,
  text,
  turnId: turnId === null ? null : TurnId.make(turnId),
  streaming: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

describe("resolveTargetProvider", () => {
  const providers = [claudeProvider, codexProvider, openCodeProvider];

  it("resolves a configured instance id", () => {
    const personal = makeProvider("codex-personal", "codex");
    expect(
      DelegationPolicy.resolveTargetProvider("codex-personal", [codexProvider, personal]),
    ).toBe(personal);
  });

  it("prefers a driver's default instance and accepts the claude alias", () => {
    const work = makeProvider("claude-work", "claudeAgent");
    expect(DelegationPolicy.resolveTargetProvider("claude", [work, claudeProvider])).toBe(
      claudeProvider,
    );
  });

  it("falls through to another instance of the driver when the default cannot take work", () => {
    const signedOut = makeProvider("codex", "codex", { auth: { status: "unauthenticated" } });
    const work = makeProvider("codex-work", "codex");
    expect(DelegationPolicy.resolveTargetProvider("codex", [signedOut, work])).toBe(work);
  });

  it("refuses an unavailable instance instead of silently routing elsewhere", () => {
    const disabled = makeProvider("codex", "codex", { enabled: false });
    const result = DelegationPolicy.resolveTargetProvider("codex", [disabled, claudeProvider]);
    expect(DelegationPolicy.isDelegationError(result) && result.code).toBe("provider_unavailable");
  });

  it("names the configured instances when nothing matches", () => {
    const result = DelegationPolicy.resolveTargetProvider("gemini", providers);
    expect(DelegationPolicy.isDelegationError(result) && result.code).toBe("provider_not_found");
    expect(DelegationPolicy.isDelegationError(result) && result.detail).toContain("opencode");
  });
});

describe("resolveChoice", () => {
  const settings = decodeSettings({
    enabled: true,
    profiles: [
      {
        name: "reviewer",
        description: "Independent code review.",
        provider: "codex",
        model: "codex-other",
        instructions: "Report findings by severity.",
        timeoutMinutes: 30,
      },
      { name: "implementer", description: "Scoped changes.", provider: "claude", access: "write" },
    ],
  });

  it("takes provider, model, access and timeout from the profile and names the role after it", () => {
    const choice = DelegationPolicy.resolveChoice({ profile: "Reviewer" }, settings);
    expect(choice).toMatchObject({
      provider: "codex",
      model: "codex-other",
      access: "read-only",
      role: "reviewer",
      timeoutMinutes: 30,
      profile: { instructions: "Report findings by severity." },
    });
  });

  it("leaves fields the profile does not set to the request", () => {
    const choice = DelegationPolicy.resolveChoice(
      { profile: "implementer", model: "claude-big", role: "migrator", timeoutMinutes: 5 },
      settings,
    );
    expect(choice).toMatchObject({
      provider: "claude",
      model: "claude-big",
      access: "write",
      role: "migrator",
      timeoutMinutes: 5,
    });
  });

  it("refuses a request that contradicts the profile instead of overriding it", () => {
    const choice = DelegationPolicy.resolveChoice(
      { profile: "reviewer", access: "write", provider: "claude" },
      settings,
    );
    expect(DelegationPolicy.isDelegationError(choice) && choice.code).toBe("invalid_request");
    expect(DelegationPolicy.isDelegationError(choice) && choice.detail).toContain(
      "fixes provider, access",
    );
    // Restating the profile's own values is fine.
    expect(
      DelegationPolicy.resolveChoice({ profile: "reviewer", provider: "Codex" }, settings),
    ).toMatchObject({ provider: "codex" });
  });

  it("lists the profiles when a name is unknown or a profile is required", () => {
    const unknown = DelegationPolicy.resolveChoice({ profile: "tester" }, settings);
    expect(DelegationPolicy.isDelegationError(unknown) && unknown.code).toBe("profile_not_found");
    expect(DelegationPolicy.isDelegationError(unknown) && unknown.detail).toContain(
      "reviewer (Independent code review.)",
    );
    const required = DelegationPolicy.resolveChoice(
      { provider: "codex" },
      { ...settings, requireProfile: true },
    );
    expect(DelegationPolicy.isDelegationError(required) && required.code).toBe("profile_required");
  });

  it("needs a profile or a provider", () => {
    const choice = DelegationPolicy.resolveChoice({}, settings);
    expect(DelegationPolicy.isDelegationError(choice) && choice.code).toBe("invalid_request");
    expect(DelegationPolicy.resolveChoice({ provider: "codex" }, settings)).toMatchObject({
      provider: "codex",
      profile: null,
      role: null,
    });
  });
});

describe("toProfileTarget", () => {
  it("reports the instance a profile runs on, or why it cannot run", () => {
    const [reviewer] = decodeSettings({
      profiles: [{ name: "reviewer", description: "Review.", provider: "codex" }],
    }).profiles;
    expect(DelegationPolicy.toProfileTarget(reviewer!, [codexProvider])).toMatchObject({
      providerInstanceId: "codex",
      available: true,
    });
    expect(DelegationPolicy.toProfileTarget(reviewer!, [claudeProvider])).toMatchObject({
      providerInstanceId: null,
      available: false,
    });
  });
});

describe("resolveModel", () => {
  it("uses an explicit model, then the provider's default", () => {
    expect(DelegationPolicy.resolveModel(codexProvider, "gpt-x")).toBe("gpt-x");
    expect(DelegationPolicy.resolveModel(codexProvider, undefined)).toBe("codex-default");
  });

  it("skips legacy models when the provider marks no default", () => {
    const provider = makeProvider("opencode", "opencode", {
      models: [
        { slug: "old", name: "old", isCustom: false, isLegacy: true, capabilities: null },
        { slug: "new", name: "new", isCustom: false, capabilities: null },
      ],
    });
    expect(DelegationPolicy.resolveModel(provider, undefined)).toBe("new");
  });
});

describe("checkAdmission", () => {
  it("admits a request within every limit", () => {
    expect(admission()).toBeUndefined();
  });

  it("refuses everything while delegation is off", () => {
    const settings = decodeSettings({});
    expect(admission({ settings })?.code).toBe("disabled");
  });

  it("refuses writes into the shared checkout", () => {
    expect(admission({ access: "write", workspaceMode: "current" })?.code).toBe("invalid_request");
    expect(admission({ access: "write", workspaceMode: "worktree" })).toBeUndefined();
  });

  it("stops delegation beyond the maximum depth", () => {
    expect(admission({ childDepth: 2 })).toBeUndefined();
    expect(admission({ childDepth: 3 })?.code).toBe("depth_exceeded");
  });

  it("enforces the parent driver's allowed targets", () => {
    const settings = decodeSettings({
      enabled: true,
      allowedTargets: { claudeAgent: ["opencode"] },
    });
    expect(admission({ settings })?.code).toBe("provider_not_allowed");
    expect(
      admission({ settings, targetDriver: ProviderDriverKind.make("opencode") }),
    ).toBeUndefined();
    expect(admission({ settings, parentDriver: codexDriver })).toBeUndefined();
  });

  it("enforces per-turn, per-thread and global limits", () => {
    expect(admission({ childrenThisTurn: 4 })?.code).toBe("children_per_turn_exceeded");
    expect(admission({ activeForParent: 3 })?.code).toBe("concurrency_exceeded");
    expect(admission({ activeGlobal: 6 })?.code).toBe("concurrency_exceeded");
  });
});

describe("child thread content", () => {
  it("titles the thread with its role and the task's first line", () => {
    expect(DelegationPolicy.childThreadTitle("reviewer", "Review the diff\nDetails")).toBe(
      "Reviewer: Review the diff",
    );
    expect(DelegationPolicy.childThreadTitle(null, "x".repeat(80))).toBe(
      `Delegate: ${"x".repeat(60)}…`,
    );
  });

  it("states the enforced access and asks for a self-contained answer", () => {
    const prompt = DelegationPolicy.buildChildPrompt({
      task: "Review the current diff.",
      role: "reviewer",
      access: "read-only",
      workspaceMode: "current",
      parentThreadTitle: "Implement OAuth refresh",
      parentProvider: "claudeAgent",
    });
    expect(prompt).toContain('a claudeAgent agent in the T3 Code thread "Implement OAuth refresh"');
    expect(prompt).toContain("Role: reviewer");
    expect(prompt).toContain("Access: Read-only.");
    expect(prompt).toContain("Review the current diff.");
    expect(prompt).toContain("returned verbatim to the delegating agent");
    expect(prompt).not.toContain("Standing instructions");
  });

  it("adds a profile's standing instructions ahead of the task", () => {
    const prompt = DelegationPolicy.buildChildPrompt({
      task: "Review the current diff.",
      role: "reviewer",
      access: "read-only",
      workspaceMode: "current",
      parentThreadTitle: "Implement OAuth refresh",
      parentProvider: null,
      instructions: "Report findings by severity.",
    });
    expect(prompt).toMatch(/Standing instructions:\nReport findings by severity\.\n\nTask:/);
  });
});

describe("readOnlyApprovalDecision", () => {
  it("allows reads and declines everything else", () => {
    expect(DelegationPolicy.readOnlyApprovalDecision("file-read")).toBe("accept");
    expect(DelegationPolicy.readOnlyApprovalDecision("file-change")).toBe("decline");
    expect(DelegationPolicy.readOnlyApprovalDecision("command")).toBe("decline");
    expect(DelegationPolicy.readOnlyApprovalDecision(undefined)).toBe("decline");
  });
});

describe("finalAssistantText", () => {
  it("returns the last non-empty assistant message from the delegated turn", () => {
    const messages = [
      message("u1", "user", "task", null),
      message("a1", "assistant", "Looking at the diff.", "turn-1"),
      message("r1", "reasoning", "thinking", "turn-1"),
      message("a2", "assistant", "  Found two bugs.  ", "turn-1"),
      message("a3", "assistant", "   ", "turn-1"),
      message("a4", "assistant", "A later turn's answer.", "turn-2"),
    ];
    expect(DelegationPolicy.finalAssistantText(messages, TurnId.make("turn-1"))).toBe(
      "Found two bugs.",
    );
  });

  it("falls back to any assistant message when none carries the turn id", () => {
    const messages = [message("a1", "assistant", "Answer.", null)];
    expect(DelegationPolicy.finalAssistantText(messages, TurnId.make("turn-1"))).toBe("Answer.");
    expect(DelegationPolicy.finalAssistantText([], null)).toBeNull();
  });
});
