import { useEffect, useRef } from "react";
import { Textarea } from "@termix-ssh/plugin-sdk/ui";
import { applyMaskedEdit, maskOf } from "./mask";

/**
 * A multi-line field whose text is never shown: every character is drawn
 * as a dot and the line breaks are kept. The DOM only ever holds the dots
 * (see mask.ts), so the value cannot be read off the screen, copied, spell
 * checked or saved by a password manager. There is no "show" toggle.
 *
 * Undo and redo are turned off: the browser's own history would hold the
 * characters it saw for a moment before they were masked.
 */
export function MaskedTextarea({
  id,
  value,
  onChange,
  rows = 4,
  placeholder,
  disabled,
  ariaLabel,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const shown = maskOf(value);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const refuseHistory = (event: Event) => {
      const type = (event as InputEvent).inputType;
      if (type === "historyUndo" || type === "historyRedo") {
        event.preventDefault();
      }
    };
    element.addEventListener("beforeinput", refuseHistory);
    return () => element.removeEventListener("beforeinput", refuseHistory);
  }, []);

  function take(element: HTMLTextAreaElement) {
    const next = element.value;
    const caret = element.selectionEnd ?? next.length;
    const updated = applyMaskedEdit(value, shown, next, caret);
    const masked = maskOf(updated);
    // The real characters must not stay in the DOM, even for an edit that
    // changed nothing and so makes no new render. Setting the text moves
    // the caret to the end in most browsers: put it back.
    element.value = masked;
    const after = masked.length - (next.length - caret);
    element.setSelectionRange(after, after);
    if (updated !== value) onChange(updated);
  }

  return (
    <Textarea
      ref={ref}
      id={id}
      value={shown}
      rows={rows}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      data-masked="true"
      className="font-mono text-xs"
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      data-1p-ignore="true"
      data-lpignore="true"
      data-form-type="other"
      onChange={(event) => {
        if (!composing.current) take(event.currentTarget);
      }}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={(event) => {
        composing.current = false;
        take(event.currentTarget);
      }}
      onKeyDown={(event) => {
        const key = event.key.toLowerCase();
        if ((event.ctrlKey || event.metaKey) && (key === "z" || key === "y")) {
          event.preventDefault();
        }
      }}
      onDragStart={(event) => event.preventDefault()}
    />
  );
}
