import * as Select from "@radix-ui/react-select";
import { useState } from "react";

interface MetricOption {
  id: string;
  label: string;
}

export function MetricSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: MetricOption[];
  onChange: (value: string) => void;
}) {
  const [pointerInteraction, setPointerInteraction] = useState(false);

  return (
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger
        className={`metric-select-trigger${pointerInteraction ? " pointer-interaction" : ""}`}
        aria-label="Chart metric"
        onPointerDown={() => setPointerInteraction(true)}
        onKeyDown={() => setPointerInteraction(false)}
        onBlur={(event) => {
          if (event.currentTarget.dataset.state === "closed") setPointerInteraction(false);
        }}
      >
        <Select.Value />
        <Select.Icon asChild>
          <span className="metric-select-chevron" aria-hidden="true" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className="metric-select-content"
          position="popper"
          sideOffset={6}
          align="end"
          collisionPadding={12}
          onPointerDown={() => setPointerInteraction(true)}
        >
          <Select.Viewport className="metric-select-viewport">
            {options.map((option) => (
              <Select.Item key={option.id} value={option.id} className="metric-select-item">
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator className="metric-select-indicator" aria-hidden="true">
                  <span />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
