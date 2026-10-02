import {
  DEFAULT_DELEGATION_ROLE_SETTINGS,
  DELEGATION_ROLE_DESCRIPTIONS,
  type DelegationAccess,
  type DelegationRole,
  type DelegationRoleSettings,
  type ServerProvider,
} from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon, XIcon } from "lucide-react";
import { useState } from "react";

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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { moveItem } from "./delegationProfiles.logic";

const ADD = "__add__";

/** Edit one standard role's default access and its ordered provider preferences. */
export function DelegationRoleEditor({
  role,
  settings,
  providers,
  onSave,
  onClose,
}: {
  role: DelegationRole;
  settings: DelegationRoleSettings;
  providers: ReadonlyArray<ServerProvider>;
  onSave: (settings: DelegationRoleSettings) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  const preferred = draft.preferredProviders;
  const setPreferred = (next: ReadonlyArray<string>) =>
    setDraft({ ...draft, preferredProviders: next });
  const addable = providers
    .map((provider) => provider.instanceId as string)
    .filter((instanceId) => !preferred.includes(instanceId));
  const labelFor = (name: string) =>
    providers.find((provider) => provider.instanceId === name)?.displayName ?? name;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup
        render={
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onSave(draft);
            }}
          />
        }
      >
        <DialogHeader>
          <DialogTitle>{role}</DialogTitle>
          <DialogDescription>{DELEGATION_ROLE_DESCRIPTIONS[role]}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <label className="block space-y-1.5 text-sm">
              <span>Default access</span>
              <Select
                value={draft.access}
                onValueChange={(value) =>
                  value !== null && setDraft({ ...draft, access: value as DelegationAccess })
                }
              >
                <SelectTrigger size="sm" aria-label="Default access">
                  <SelectValue>{draft.access === "write" ? "Write" : "Read-only"}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="read-only">
                    Read-only
                  </SelectItem>
                  <SelectItem hideIndicator value="write">
                    Write, in its own worktree
                  </SelectItem>
                </SelectPopup>
              </Select>
            </label>
            <div className="space-y-1.5 text-sm">
              <p>Preferred providers</p>
              <p className="text-xs text-muted-foreground">
                Used in order when an agent names no provider. The first one that is signed in runs
                the task.
              </p>
              {preferred.length === 0 ? (
                <p className="py-1 text-muted-foreground">
                  None. Agents must name a provider for this role.
                </p>
              ) : (
                <ol className="space-y-1">
                  {preferred.map((name, index) => (
                    <li key={name} className="flex items-center gap-1">
                      <span className="w-5 shrink-0 text-muted-foreground">{index + 1}.</span>
                      <span className="min-w-0 flex-1 truncate">{labelFor(name)}</span>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost-muted"
                        aria-label={`Move ${name} up`}
                        disabled={index === 0}
                        onClick={() => setPreferred(moveItem(preferred, index, -1))}
                      >
                        <ArrowUpIcon />
                      </Button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost-muted"
                        aria-label={`Move ${name} down`}
                        disabled={index === preferred.length - 1}
                        onClick={() => setPreferred(moveItem(preferred, index, 1))}
                      >
                        <ArrowDownIcon />
                      </Button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost-muted"
                        aria-label={`Remove ${name}`}
                        onClick={() => setPreferred(preferred.filter((entry) => entry !== name))}
                      >
                        <XIcon />
                      </Button>
                    </li>
                  ))}
                </ol>
              )}
              {addable.length > 0 ? (
                <Select
                  value={ADD}
                  onValueChange={(value) =>
                    value !== null && value !== ADD && setPreferred([...preferred, value])
                  }
                >
                  <SelectTrigger size="sm" aria-label="Add a preferred provider">
                    <SelectValue>Add a provider</SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {addable.map((instanceId) => (
                      <SelectItem hideIndicator key={instanceId} value={instanceId}>
                        {labelFor(instanceId)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : null}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setDraft(DEFAULT_DELEGATION_ROLE_SETTINGS[role])}
          >
            Restore defaults
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">Save role</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
