import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";

const model = (
  slug: string,
  overrides: Partial<ServerProviderModel> = {},
): ServerProviderModel => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: null,
  ...overrides,
});

export const makeProvider = (
  instanceId: string,
  driver: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-01T00:00:00.000Z",
  models: [model(`${driver}-default`, { isDefault: true }), model(`${driver}-other`)],
  slashCommands: [],
  skills: [],
  ...overrides,
});

export const codexProvider = makeProvider("codex", "codex");
export const claudeProvider = makeProvider("claudeAgent", "claudeAgent");
export const openCodeProvider = makeProvider("opencode", "opencode");
