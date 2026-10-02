import type { DelegationProfile } from "@t3tools/contracts";

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const NAME_MAX_LENGTH = 40;

export const EMPTY_PROFILE: DelegationProfile = {
  name: "",
  description: "",
  provider: "",
  model: null,
  access: "read-only",
  workspace: null,
  instructions: "",
  timeoutMinutes: null,
};

/** The first problem with a draft, worded for the form, or null when it can be saved. */
export function profileDraftError(
  draft: DelegationProfile,
  profiles: ReadonlyArray<DelegationProfile>,
  originalName: string | null,
): string | null {
  const name = draft.name.trim();
  if (name.length === 0) return "Name the profile.";
  if (name.length > NAME_MAX_LENGTH || !NAME_PATTERN.test(name)) {
    return "Use lowercase letters, digits, - and _ for the name.";
  }
  if (name !== originalName && profiles.some((profile) => profile.name === name)) {
    return `A profile named ${name} already exists.`;
  }
  if (draft.description.trim().length === 0) return "Describe when agents should use it.";
  if (draft.provider.trim().length === 0) return "Choose a provider.";
  if (draft.access === "write" && draft.workspace === "current") {
    return "Write access needs its own worktree.";
  }
  return null;
}

/** Trim a valid draft into the stored shape. */
export function normalizeProfile(draft: DelegationProfile): DelegationProfile {
  return {
    ...draft,
    name: draft.name.trim(),
    description: draft.description.trim(),
    provider: draft.provider.trim(),
    instructions: draft.instructions.trim(),
  };
}

/** Replace the profile named `originalName` in place, or append a new one. */
export function upsertProfile(
  profiles: ReadonlyArray<DelegationProfile>,
  originalName: string | null,
  profile: DelegationProfile,
): ReadonlyArray<DelegationProfile> {
  const index = originalName === null ? -1 : profiles.findIndex((p) => p.name === originalName);
  return index === -1
    ? [...profiles, profile]
    : profiles.map((existing, position) => (position === index ? profile : existing));
}

/** Move a profile one place up or down; agents see profiles in this order. */
export function moveProfile(
  profiles: ReadonlyArray<DelegationProfile>,
  name: string,
  offset: -1 | 1,
): ReadonlyArray<DelegationProfile> {
  return moveItem(
    profiles,
    profiles.findIndex((profile) => profile.name === name),
    offset,
  );
}

/** "codex · gpt-6 · read-only" style summary for a profile row. */
export function profileSummary(profile: DelegationProfile): string {
  return [
    profile.provider,
    profile.model ?? "default model",
    profile.access,
    ...(profile.workspace === "worktree" ? ["own worktree"] : []),
  ].join(" · ");
}

/** Move the item at `index` one place up or down; out-of-range moves return the list unchanged. */
export function moveItem<T>(
  items: ReadonlyArray<T>,
  index: number,
  offset: -1 | 1,
): ReadonlyArray<T> {
  const to = index + offset;
  if (index < 0 || index >= items.length || to < 0 || to >= items.length) return items;
  const next = [...items];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}
