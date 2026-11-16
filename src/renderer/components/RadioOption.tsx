import { useId, type JSX } from "react";

interface RadioOptionProps {
  group: string;
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export function RadioOption({
  group,
  label,
  description,
  checked,
  disabled = false,
  onSelect,
}: RadioOptionProps): JSX.Element {
  const inputId = useId();
  const descriptionId = useId();
  return (
    <div className="radio-option">
      <input
        id={inputId}
        type="radio"
        name={group}
        checked={checked}
        disabled={disabled}
        aria-describedby={description === undefined ? undefined : descriptionId}
        onChange={onSelect}
      />
      <label htmlFor={inputId}>{label}</label>
      {description !== undefined && (
        <small id={descriptionId} className="radio-description">
          {description}
        </small>
      )}
    </div>
  );
}
