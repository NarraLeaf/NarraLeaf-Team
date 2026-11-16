/**
 * A choice from a list, the way GitHub picks reviewers and labels: a button
 * that says what is chosen, opening a panel with a filter box, each option with
 * a line of explanation and a tick. One choice closes the panel; several stay
 * open until the panel is left. Arrow keys move, Enter picks, Escape closes.
 *
 * It stands in for every `<select>` and row of checkboxes in the console.
 */
import { useCallback, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Icon, type IconName } from "../Icon";
import { t } from "../i18n";
import { useAnchoredStyle, useDismiss, type Align } from "./overlay";

export interface SelectOption<V extends string> {
  readonly value: V;
  readonly label: string;
  readonly description?: string | undefined;
  readonly icon?: IconName | undefined;
  /** Drawn before the label instead of an icon: a face, a colour. */
  readonly leading?: ReactNode;
  readonly disabled?: boolean | undefined;
}

interface Common<V extends string> {
  readonly options: readonly SelectOption<V>[];
  /** Read out and shown over the list. */
  readonly label: string;
  /** Shown on the button when nothing is chosen. */
  readonly placeholder?: string;
  /** A filter box is shown from this many options on; 0 always, Infinity never. */
  readonly filterFrom?: number;
  readonly align?: Align;
  readonly disabled?: boolean;
  /** Smaller button, for rows of a table. */
  readonly size?: "small" | "medium";
  /** Draw the button oneself; it is given what the button would say. */
  readonly renderButton?: (summary: string) => ReactNode;
  readonly className?: string;
  /** Said under the list, as how the choice is used. */
  readonly footer?: ReactNode;
  /** What the button says when every option is chosen. */
  readonly allLabel?: string;
}

interface Single<V extends string> extends Common<V> {
  readonly multiple?: false;
  readonly value: V | undefined;
  readonly onChange: (value: V) => void;
}

interface Multiple<V extends string> extends Common<V> {
  readonly multiple: true;
  readonly value: readonly V[];
  readonly onChange: (value: readonly V[]) => void;
}

export function SelectPanel<V extends string>(props: Single<V> | Multiple<V>) {
  const { options, label, placeholder, filterFrom = 8, align = "start", disabled, size = "medium", renderButton, className, footer, allLabel } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const chosen = useMemo(() => new Set<string>(props.multiple === true ? props.value : props.value === undefined ? [] : [props.value]), [props.multiple, props.value]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);
  useDismiss([button, layer], open, close, button);
  const style = useAnchoredStyle(button, layer, open, align, Math.max(220, button.current?.offsetWidth ?? 0));

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return options;
    return options.filter((option) => option.label.toLowerCase().includes(q) || (option.description ?? "").toLowerCase().includes(q));
  }, [options, query]);

  const summary = (() => {
    const labels = options.filter((option) => chosen.has(option.value)).map((option) => option.label);
    if (labels.length === 0) return placeholder ?? t("selectNone");
    if (allLabel !== undefined && labels.length === options.length && labels.length > 1) return allLabel;
    if (labels.length <= 2) return labels.join(", ");
    return t("selectMany", { first: labels[0] ?? "", count: String(labels.length - 1) });
  })();

  const pick = (option: SelectOption<V> | undefined) => {
    if (option === undefined || option.disabled === true) return;
    if (props.multiple === true) {
      const next = chosen.has(option.value) ? props.value.filter((value) => value !== option.value) : [...props.value, option.value];
      props.onChange(next);
    } else {
      if (option.value !== props.value) props.onChange(option.value);
      close();
      button.current?.focus();
    }
  };

  const move = (by: number) => {
    if (shown.length === 0) return;
    setActive((at) => {
      let next = at;
      for (let step = 0; step < shown.length; step += 1) {
        next = (next + by + shown.length) % shown.length;
        if (shown[next]?.disabled !== true) break;
      }
      list.current?.children[next]?.scrollIntoView({ block: "nearest" });
      return next;
    });
  };

  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter" || (event.key === " " && (event.target as HTMLElement).tagName !== "INPUT")) {
      event.preventDefault();
      pick(shown[active]);
    } else if (event.key === "Tab") {
      close();
    }
  };

  const withFilter = options.length >= filterFrom;
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`${renderButton === undefined ? `select-button${size === "small" ? " small" : ""}` : "select-button-bare"}${className === undefined ? "" : ` ${className}`}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={renderButton === undefined ? `${label}: ${summary}` : label}
        disabled={disabled}
        onClick={() => {
          if (open) return close();
          const first = shown.findIndex((option) => chosen.has(option.value));
          setActive(first < 0 ? 0 : first);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {renderButton === undefined ? (
          <>
            <span className="select-button-text">{summary}</span>
            <Icon name="caret" size={14} />
          </>
        ) : (
          renderButton(summary)
        )}
      </button>
      {open
        ? createPortal(
            <div ref={layer} className="overlay select-panel" style={style} role="dialog" aria-label={label} onKeyDown={onKey}>
              <div className="select-panel-head">{label}</div>
              {withFilter ? (
                <div className="select-panel-filter">
                  <Icon name="search" size={14} />
                  <input
                    autoFocus
                    value={query}
                    placeholder={t("selectFilter")}
                    aria-label={t("selectFilter")}
                    aria-controls={id}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setActive(0);
                    }}
                  />
                </div>
              ) : null}
              <ul
                ref={list}
                id={id}
                className="select-panel-list"
                role="listbox"
                aria-multiselectable={props.multiple === true}
                tabIndex={withFilter ? -1 : 0}
                autoFocus={!withFilter}
                aria-activedescendant={shown[active] === undefined ? undefined : `${id}-${active}`}
              >
                {shown.length === 0 ? <li className="select-panel-empty muted small">{t("selectNothing")}</li> : null}
                {shown.map((option, index) => {
                  const on = chosen.has(option.value);
                  return (
                    <li
                      key={option.value}
                      id={`${id}-${index}`}
                      role="option"
                      aria-selected={on}
                      aria-disabled={option.disabled === true}
                      className={`select-option${index === active ? " active" : ""}${option.disabled === true ? " disabled" : ""}`}
                      onPointerEnter={() => setActive(index)}
                      onClick={() => pick(option)}
                    >
                      <span className={props.multiple === true ? `select-tick box${on ? " on" : ""}` : `select-tick${on ? " on" : ""}`} aria-hidden="true">
                        {on ? <Icon name="tick" size={12} /> : null}
                      </span>
                      {option.leading ?? (option.icon === undefined ? null : <Icon name={option.icon} size={14} />)}
                      <span className="select-option-text">
                        <span>{option.label}</span>
                        {option.description === undefined ? null : <span className="muted small">{option.description}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {footer === undefined ? null : <div className="select-panel-foot muted small">{footer}</div>}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
