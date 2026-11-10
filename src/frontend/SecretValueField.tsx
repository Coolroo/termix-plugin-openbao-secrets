import { useState, type CSSProperties } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Textarea } from "@termix-ssh/plugin-sdk/ui";

/**
 * The value field of Add secret and Replace value: a plain controlled
 * textarea, so every keyboard (phone keyboards compose whole words), paste
 * and autofill sets the value. The value shows while it is typed; Hide draws
 * it as dots and never changes it. Once saved, a value is never sent to the
 * browser again.
 */
export function SecretValueField({
  id,
  value,
  onChange,
  rows = 4,
  disabled,
  ariaLabel,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const { t } = useTranslation();
  const [hidden, setHidden] = useState(false);

  return (
    <div className="flex flex-col gap-1">
      <Textarea
        id={id}
        value={value}
        rows={rows}
        disabled={disabled}
        aria-label={ariaLabel}
        data-secret-value="true"
        data-hidden={hidden ? "true" : "false"}
        className="font-mono text-xs"
        style={
          hidden ? ({ WebkitTextSecurity: "disc" } as CSSProperties) : undefined
        }
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-1p-ignore="true"
        data-lpignore="true"
        data-form-type="other"
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <button
        type="button"
        className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        aria-pressed={hidden}
        aria-controls={id}
        disabled={disabled}
        onClick={() => setHidden((now) => !now)}
      >
        {hidden ? t("form.show") : t("form.hide")}
      </button>
    </div>
  );
}
