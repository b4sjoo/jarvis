import { Switch, Label, Header } from "@/components";
import { useApp } from "@/contexts";
import { useState } from "react";

interface AutostartToggleProps {
  className?: string;
}

export const AutostartToggle = ({ className }: AutostartToggleProps) => {
  const { customizable, toggleAutostart, autostartSupported, autostartError } = useApp();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEnabled = autostartSupported === true && customizable.autostart.isEnabled;

  const handleSwitchChange = async (checked: boolean) => {
    setPending(true);
    setError(null);
    try {
      await toggleAutostart(checked);
    } catch (error) {
      setError(String(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <div id="autostart" className={`space-y-2 ${className}`}>
      <Header
        title="Launch on Startup"
        description="Automatically open Jarvis when your system starts"
        isMainTitle
      />
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div>
            <Label className="text-sm font-medium">Open on Start</Label>
            <p className="text-xs text-muted-foreground mt-1">
              {autostartSupported === null
                ? "Startup availability has not been confirmed"
                : !autostartSupported
                ? "Unavailable in development and test builds"
                : isEnabled
                ? "Jarvis will launch automatically on system startup"
                : "Jarvis will not launch automatically"}
            </p>
          </div>
        </div>
        <Switch
          checked={isEnabled}
          disabled={!autostartSupported || pending}
          onCheckedChange={handleSwitchChange}
          aria-label="Toggle autostart"
        />
      </div>
      {(error || autostartError) && <p role="alert" className="text-sm text-destructive">{error || autostartError}</p>}
    </div>
  );
};
