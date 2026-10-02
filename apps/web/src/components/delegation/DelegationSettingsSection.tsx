import { DEFAULT_SERVER_SETTINGS, type DelegationSettings } from "@t3tools/contracts";

import { ScopedSwitch } from "../settings/ScopedSwitch";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import { SettingResetButton, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { searchableSetting } from "../settings/settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "../settings/useScopedSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

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
    </SettingsSection>
  );
}
