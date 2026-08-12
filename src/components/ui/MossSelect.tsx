import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import "./moss-select.css";

const EMPTY_VALUE = "__moss_empty_value__";

export interface MossSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface MossSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly MossSelectOption[];
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}

const encodeValue = (value: string) => value || EMPTY_VALUE;
const decodeValue = (value: string) => value === EMPTY_VALUE ? "" : value;

export default function MossSelect({
  value,
  onValueChange,
  options,
  ariaLabel,
  disabled = false,
  className,
}: MossSelectProps) {
  return (
    <Select.Root
      value={encodeValue(value)}
      onValueChange={(nextValue) => onValueChange(decodeValue(nextValue))}
      disabled={disabled}
    >
      <Select.Trigger
        aria-label={ariaLabel}
        className={["moss-select-trigger", className].filter(Boolean).join(" ")}
      >
        <Select.Value />
        <Select.Icon className="moss-select-chevron">
          <ChevronDown size={16} strokeWidth={1.8} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className="moss-select-content"
          position="popper"
          sideOffset={5}
          collisionPadding={8}
        >
          <Select.ScrollUpButton className="moss-select-scroll-button">
            <ChevronUp size={15} />
          </Select.ScrollUpButton>
          <Select.Viewport className="moss-select-viewport">
            {options.map((option) => (
              <Select.Item
                key={encodeValue(option.value)}
                value={encodeValue(option.value)}
                disabled={option.disabled}
                className="moss-select-item"
              >
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator className="moss-select-indicator">
                  <Check size={14} strokeWidth={2.2} />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
          <Select.ScrollDownButton className="moss-select-scroll-button">
            <ChevronDown size={15} />
          </Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
