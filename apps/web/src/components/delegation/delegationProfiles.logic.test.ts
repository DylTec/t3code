import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_PROFILE,
  moveProfile,
  profileDraftError,
  upsertProfile,
} from "./delegationProfiles.logic";

const reviewer = {
  ...EMPTY_PROFILE,
  name: "reviewer",
  description: "Independent review.",
  provider: "codex",
};
const tester = { ...reviewer, name: "tester", description: "Runs the tests." };

describe("profileDraftError", () => {
  it("accepts a complete draft and its own unchanged name", () => {
    expect(profileDraftError(reviewer, [reviewer], "reviewer")).toBeNull();
  });

  it("explains what is missing or invalid", () => {
    expect(profileDraftError({ ...reviewer, name: "Code Reviewer" }, [], null)).toContain(
      "lowercase",
    );
    expect(profileDraftError(reviewer, [reviewer], null)).toContain("already exists");
    expect(profileDraftError({ ...reviewer, description: " " }, [], null)).toContain("Describe");
    expect(profileDraftError({ ...reviewer, provider: "" }, [], null)).toContain("provider");
    expect(
      profileDraftError({ ...reviewer, access: "write", workspace: "current" }, [], null),
    ).toContain("worktree");
  });
});

describe("profile list edits", () => {
  it("renames in place and appends new profiles", () => {
    const renamed = { ...reviewer, name: "critic" };
    expect(upsertProfile([reviewer, tester], "reviewer", renamed)).toEqual([renamed, tester]);
    expect(upsertProfile([reviewer], null, tester)).toEqual([reviewer, tester]);
  });

  it("reorders within bounds", () => {
    expect(moveProfile([reviewer, tester], "tester", -1)).toEqual([tester, reviewer]);
    expect(moveProfile([reviewer, tester], "reviewer", -1)).toEqual([reviewer, tester]);
  });
});
