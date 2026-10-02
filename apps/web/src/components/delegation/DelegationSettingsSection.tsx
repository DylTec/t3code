import {
  DEFAULT_SERVER_SETTINGS,
  type DelegationProfile,
  type DelegationSettings,
} from "@t3tools/contracts";
import { MoreVertical, PlusIcon } from "lucide-react";
import { useState } from "react";

import { ScopedSwitch } from "../settings/ScopedSwitch";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import { SettingResetButton, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { searchableSetting } from "../settings/settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "../settings/useScopedSettings";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { DelegationProfileEditor } from "./DelegationProfileEditor";
import {
  EMPTY_PROFILE,
  moveProfile,
  profileSummary,
  upsertProfile,
} from "./delegationProfiles.logic";

const DEFAULTS = DEFAULT_SERVER_SETTINGS.delegation;

type LimitKey = "maxDepth" | "maxConcurrentPerThread" | "defaultTimeoutMinutes";

const LIMITS: ReadonlyArray<{
  readonly key: LimitKey;
  readonly search: Parameters<typeof searchableSetting>[0];
  readonly description: string;
  readonly options: ReadonlyArray<number>;
  readonly format: (value: number) => string;
}> = [
  {
    key: "maxConcurrentPerThread",
    search: "delegation-concurrency",
    description: "How many delegates one thread may run at the same time.",
    options: [1, 2, 3, 4, 6, 8],
    format: (value) => String(value),
  },
  {
    key: "maxDepth",
    search: "delegation-depth",
    description: "How many levels deep delegates may delegate again. 1 means delegates cannot.",
    options: [1, 2, 3],
    format: (value) => String(value),
  },
  {
    key: "defaultTimeoutMinutes",
    search: "delegation-timeout",
    description: "A delegate still working after this long is stopped.",
    options: [5, 10, 15, 30, 60, 120],
    format: (value) => `${value} min`,
  },
];

/** Server-side switch and limits for agents delegating work to other providers. */
function ProfileRow({
  profile,
  first,
  last,
  disabled,
  onEdit,
  onMove,
  onRemove,
}: {
  profile: DelegationProfile;
  first: boolean;
  last: boolean;
  disabled: boolean;
  onEdit: () => void;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-2 border-t border-border/50 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{profile.name}</p>
        <p className="truncate text-xs text-muted-foreground">{profile.description}</p>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {profileSummary(profile)}
        </p>
      </div>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost-muted"
              disabled={disabled}
              aria-label={`${profile.name} options`}
            />
          }
        >
          <MoreVertical />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={onEdit}>Edit</MenuItem>
          {first ? null : <MenuItem onClick={() => onMove(-1)}>Move up</MenuItem>}
          {last ? null : <MenuItem onClick={() => onMove(1)}>Move down</MenuItem>}
          <MenuItem variant="destructive" onClick={onRemove}>
            Remove
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

/** Named workers agents choose between, like subagents in an orchestrator's config. */
function DelegationProfilesRows({
  delegation,
  disabled,
  update,
}: {
  delegation: DelegationSettings;
  disabled: boolean;
  update: (patch: Partial<DelegationSettings>) => void;
}) {
  const { environment } = useSettingsScope();
  const providers = environment?.serverConfig?.providers ?? [];
  const [editing, setEditing] = useState<DelegationProfile | null>(null);
  const profiles = delegation.profiles;
  const setProfiles = (next: ReadonlyArray<DelegationProfile>) => update({ profiles: next });

  return (
    <>
      <SettingsRow
        {...searchableSetting("delegation-profiles")}
        serverScoped
        settingKeys={["delegation"]}
        description="Named workers with a provider, model, access and standing instructions. Agents read each description and pick the one that fits, as with OpenCode subagents."
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => setEditing(EMPTY_PROFILE)}
          >
            <PlusIcon className="size-3.5" /> Add profile
          </Button>
        }
      >
        <div className="pt-3 pb-2">
          {profiles.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              No profiles. Agents name a provider for each delegation.
            </p>
          ) : (
            profiles.map((profile, index) => (
              <ProfileRow
                key={profile.name}
                profile={profile}
                first={index === 0}
                last={index === profiles.length - 1}
                disabled={disabled}
                onEdit={() => setEditing(profile)}
                onMove={(offset) => setProfiles(moveProfile(profiles, profile.name, offset))}
                onRemove={() =>
                  setProfiles(profiles.filter((candidate) => candidate.name !== profile.name))
                }
              />
            ))
          )}
        </div>
      </SettingsRow>
      <SettingsRow
        {...searchableSetting("delegation-require-profile")}
        serverScoped
        settingKeys={["delegation"]}
        description="Refuse delegations that name a provider directly instead of a profile."
        control={
          <Switch
            checked={delegation.requireProfile}
            disabled={disabled || (profiles.length === 0 && !delegation.requireProfile)}
            aria-label="Only delegate to profiles"
            onCheckedChange={(checked) => update({ requireProfile: Boolean(checked) })}
          />
        }
      />
      {editing ? (
        <DelegationProfileEditor
          key={editing.name}
          profile={editing}
          profiles={profiles}
          providers={providers}
          onClose={() => setEditing(null)}
          onSave={(profile) => {
            setProfiles(
              upsertProfile(profiles, editing.name === "" ? null : editing.name, profile),
            );
            setEditing(null);
          }}
        />
      ) : null}
    </>
  );
}

export function DelegationSettingsSection() {
  const { scope } = useSettingsScope();
  const delegation = useScopedSettings((settings) => settings.delegation);
  const updateSettings = useUpdateScopedSettings();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const update = (patch: Partial<DelegationSettings>) => updateSettings({ delegation: patch });

  return (
    <SettingsSection id="delegation" title="Delegation">
      <SettingsRow
        {...searchableSetting("delegation")}
        serverScoped
        settingKeys={["delegation"]}
        description="Let agents hand tasks to another provider through T3 Code. Each delegate runs in its own thread."
        control={
          <ScopedSwitch
            settingKeys={["delegation"]}
            checked={delegation.enabled}
            disabled={projectScope}
            aria-label="Delegation"
            onCheckedChange={(checked) => update({ enabled: Boolean(checked) })}
          />
        }
      />
      {LIMITS.map((limit) => {
        const value = delegation[limit.key];
        const title = searchableSetting(limit.search).title;
        return (
          <SettingsRow
            key={limit.key}
            {...searchableSetting(limit.search)}
            serverScoped
            settingKeys={["delegation"]}
            description={limit.description}
            resetAction={
              !projectScope && value !== DEFAULTS[limit.key] ? (
                <SettingResetButton
                  label={title.toLowerCase()}
                  onClick={() => update({ [limit.key]: DEFAULTS[limit.key] })}
                />
              ) : null
            }
            control={
              <Select
                disabled={projectScope || !delegation.enabled}
                value={String(value)}
                onValueChange={(next) => {
                  const parsed = limit.options.find((option) => String(option) === next);
                  if (parsed !== undefined) update({ [limit.key]: parsed });
                }}
              >
                <SelectTrigger size="sm" className="w-full sm:w-40" aria-label={title}>
                  <SelectValue>{limit.format(value)}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {limit.options.map((option) => (
                    <SelectItem hideIndicator key={option} value={String(option)}>
                      {limit.format(option)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        );
      })}
      <DelegationProfilesRows
        delegation={delegation}
        disabled={projectScope || !delegation.enabled}
        update={update}
      />
    </SettingsSection>
  );
}
