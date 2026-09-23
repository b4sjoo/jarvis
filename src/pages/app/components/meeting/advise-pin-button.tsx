import { LockIcon, LockOpenIcon } from "lucide-react";
import { Button } from "@/components";
import { getShortcutsConfig, formatShortcutKeyForDisplay } from "@/lib/storage/shortcuts.storage";

export function AdvisePinButton({ locked, updated, onClick }: {
  locked: boolean; updated?: boolean; onClick: () => void;
}) {
  const binding = getShortcutsConfig().bindings.meeting_toggle_advise_pin;
  const label = locked ? "Unlock question" : "Lock question";
  const Icon = locked ? LockIcon : LockOpenIcon;
  return <Button size="icon" variant="ghost" className="ml-auto h-7 w-7 shrink-0"
    aria-label={label} aria-pressed={locked}
    title={`${label}${binding?.enabled ? ` (${formatShortcutKeyForDisplay(binding.key)})` : ""}${updated ? ": newer answer ready" : ""}`}
    onClick={onClick}>
    <Icon className="h-3.5 w-3.5" />
    {updated ? <span className="h-1 w-1 rounded-full bg-primary" aria-label="Newer answer ready" /> : null}
  </Button>;
}
