import type {
  DelegationAccess,
  DelegationProfile,
  DelegationWorkspaceMode,
  ServerProvider,
} from "@t3tools/contracts";
import { useState, type ReactNode } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { normalizeProfile, profileDraftError } from "./delegationProfiles.logic";

/** Select items need string values; this one stands for "unset" (null). */
const UNSET = "__unset__";

const ACCESS_LABELS: Record<DelegationAccess, string> = {
  "read-only": "Read-only",
  write: "Write",
};

const WORKSPACE_LABELS: Record<DelegationWorkspaceMode | typeof UNSET, string> = {
  [UNSET]: "Agent decides",
  current: "Shared checkout",
  worktree: "Own worktree",
};

const TIMEOUT_OPTIONS = [5, 10, 15, 30, 60, 120];

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5 text-sm">
      <span>{label}</span>
      {children}
    </label>
  );
}

function OptionSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<readonly [value: string, label: string]>;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <Select value={value} onValueChange={(next) => next !== null && onChange(next)}>
        <SelectTrigger size="sm" aria-label={label}>
          <SelectValue>{options.find(([option]) => option === value)?.[1] ?? value}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {options.map(([option, optionLabel]) => (
            <SelectItem hideIndicator key={option} value={option}>
              {optionLabel}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </Field>
  );
}

export function DelegationProfileEditor({
  profile,
  profiles,
  providers,
  onSave,
  onClose,
}: {
  profile: DelegationProfile;
  /** The current list, to keep names unique. */
  profiles: ReadonlyArray<DelegationProfile>;
  providers: ReadonlyArray<ServerProvider>;
  onSave: (profile: DelegationProfile) => void;
  onClose: () => void;
}) {
  const isNew = profile.name === "";
  const [draft, setDraft] = useState(profile);
  const error = profileDraftError(draft, profiles, isNew ? null : profile.name);
  const update = (patch: Partial<DelegationProfile>) => setDraft({ ...draft, ...patch });

  // Keep a hand-written provider or model selectable even if this environment lacks it.
  const providerOptions: Array<readonly [string, string]> = providers.map((provider) => [
    provider.instanceId,
    provider.displayName ?? provider.instanceId,
  ]);
  if (draft.provider && !providerOptions.some(([value]) => value === draft.provider)) {
    providerOptions.push([draft.provider, draft.provider]);
  }
  const selectedProvider = providers.find(
    (provider) => provider.instanceId === draft.provider || provider.driver === draft.provider,
  );
  const modelOptions: Array<readonly [string, string]> = [
    [UNSET, "Provider default"],
    ...(selectedProvider?.models ?? [])
      .filter((model) => model.isLegacy !== true)
      .map((model) => [model.slug, model.name] as const),
  ];
  if (draft.model !== null && !modelOptions.some(([value]) => value === draft.model)) {
    modelOptions.push([draft.model, draft.model]);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup
        render={
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (error === null) onSave(normalizeProfile(draft));
            }}
          />
        }
      >
        <DialogHeader>
          <DialogTitle>{isNew ? "Add worker profile" : `Edit ${profile.name}`}</DialogTitle>
          <DialogDescription>
            Agents pick a profile by its description. Everything set here is fixed for that worker.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <Field label="Name">
              <Input
                autoFocus
                value={draft.name}
                placeholder="reviewer"
                onChange={(event) => update({ name: event.target.value.toLowerCase() })}
              />
            </Field>
            <Field label="When to use it">
              <Textarea
                value={draft.description}
                placeholder="Independent code review for correctness, regressions, and missing cases."
                onChange={(event) => update({ description: event.target.value })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <OptionSelect
                label="Provider"
                value={draft.provider || UNSET}
                options={[[UNSET, "Choose a provider"], ...providerOptions]}
                onChange={(value) =>
                  update({ provider: value === UNSET ? "" : value, model: null })
                }
              />
              <OptionSelect
                label="Model"
                value={draft.model ?? UNSET}
                options={modelOptions}
                onChange={(value) => update({ model: value === UNSET ? null : value })}
              />
              <OptionSelect
                label="Access"
                value={draft.access}
                options={Object.entries(ACCESS_LABELS)}
                onChange={(value) => {
                  const access = value as DelegationAccess;
                  update({
                    access,
                    ...(access === "write" && draft.workspace === "current"
                      ? { workspace: "worktree" as const }
                      : {}),
                  });
                }}
              />
              <OptionSelect
                label="Workspace"
                value={draft.workspace ?? UNSET}
                options={Object.entries(WORKSPACE_LABELS).filter(
                  ([value]) => !(draft.access === "write" && value === "current"),
                )}
                onChange={(value) =>
                  update({ workspace: value === UNSET ? null : (value as DelegationWorkspaceMode) })
                }
              />
              <OptionSelect
                label="Timeout"
                value={draft.timeoutMinutes === null ? UNSET : String(draft.timeoutMinutes)}
                options={[
                  [UNSET, "Delegation default"],
                  ...TIMEOUT_OPTIONS.map((minutes) => [String(minutes), `${minutes} min`] as const),
                ]}
                onChange={(value) =>
                  update({ timeoutMinutes: value === UNSET ? null : Number(value) })
                }
              />
            </div>
            <Field label="Standing instructions">
              <Textarea
                value={draft.instructions}
                placeholder="Report findings by severity with file paths and line numbers."
                onChange={(event) => update({ instructions: event.target.value })}
              />
            </Field>
            {error !== null && draft !== profile ? (
              <p className="text-sm text-muted-foreground" role="status">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={error !== null}>
            Save profile
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
