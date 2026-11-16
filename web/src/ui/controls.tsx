/**
 * The small pieces every page shares: a checkbox and a switch drawn in the
 * console's own colours, an empty state that says what to do next, a time
 * that reads "3 hours ago" with the exact time on hover, a short hash that
 * copies itself, an underlined row of tabs with counts, and an inline notice.
 */
import { useEffect, useState, type ReactNode } from "react";

import { ago } from "./time";
import { Icon, type IconName } from "../Icon";
import { t } from "../i18n";
import { friendlyError, toast } from "./Dialog";

/* -------------------------------------------------------------- checkbox */

export function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled,
  indeterminate,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean | undefined;
  indeterminate?: boolean;
  className?: string;
}) {
  const box = (
    <input
      type="checkbox"
      className="nl-checkbox"
      checked={checked}
      disabled={disabled}
      ref={(element) => {
        if (element !== null) element.indeterminate = indeterminate === true;
      }}
      onChange={(event) => onChange(event.target.checked)}
      {...(label === undefined && typeof description === "string" ? { "aria-label": description } : {})}
    />
  );
  if (label === undefined) return box;
  return (
    <label className={`check-row${disabled === true ? " disabled" : ""}${className === undefined ? "" : ` ${className}`}`}>
      {box}
      <span className="check-row-text">
        <span>{label}</span>
        {description === undefined ? null : <span className="muted small">{description}</span>}
      </span>
    </label>
  );
}

/** An on/off that takes effect at once, unlike a checkbox in a form that waits for "save". */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={checked ? "nl-switch on" : "nl-switch"}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="nl-switch-knob" />
    </button>
  );
}

/* ------------------------------------------------------------ blankslate */

export function Blankslate({
  icon,
  title,
  children,
  action,
  compact = false,
}: {
  icon: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "blankslate compact" : "blankslate"}>
      <span className="blankslate-icon">
        <Icon name={icon} size={compact ? 20 : 24} />
      </span>
      <h3>{title}</h3>
      {children === undefined ? null : <p>{children}</p>}
      {action === undefined ? null : <div className="blankslate-action">{action}</div>}
    </div>
  );
}

/* ----------------------------------------------------------------- times */

/** Redraw every minute, so "just now" becomes "1 minute ago" on its own. */
function useMinute(): void {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
}

export function RelativeTime({ at, className }: { at: number; className?: string }) {
  useMinute();
  const date = new Date(at);
  return (
    <time className={className ?? "muted small nowrap"} dateTime={date.toISOString()} title={date.toLocaleString()}>
      {ago(at)}
    </time>
  );
}

/* ------------------------------------------------------------------ hash */

/** Seven characters of a revision, in the monospace face; a click copies all of it. */
export function Hash({ value, length = 7 }: { value: string; length?: number }) {
  return (
    <button
      type="button"
      className="hash"
      title={t("copyFull", { value })}
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard?.writeText(value).then(
          () => toast(t("copied")),
          () => undefined,
        );
      }}
    >
      {value.slice(0, length)}
    </button>
  );
}

/** Copy a piece of text, with a button beside it. */
export function CopyText({ value, mono = true }: { value: string; mono?: boolean }) {
  return (
    <span className="copy-text">
      <span className={mono ? "mono" : undefined}>{value}</span>
      <button
        type="button"
        className="btn btn-invisible btn-icon btn-sm"
        aria-label={t("copy")}
        title={t("copy")}
        onClick={() => void navigator.clipboard?.writeText(value).then(() => toast(t("copied")), () => undefined)}
      >
        <Icon name="copy" size={14} />
      </button>
    </span>
  );
}

/* ------------------------------------------------------------------ tabs */

export interface NavTab<K extends string> {
  readonly key: K;
  readonly label: string;
  readonly icon?: IconName;
  readonly count?: number | undefined;
}

/** A row of tabs underlined where one is chosen, each with its count, as on a GitHub repository. */
export function UnderlineNav<K extends string>({
  tabs,
  active,
  onSelect,
  label,
}: {
  tabs: readonly NavTab<K>[];
  active: K;
  onSelect: (key: K) => void;
  label: string;
}) {
  return (
    <nav className="underline-nav" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          className={tab.key === active ? "underline-tab active" : "underline-tab"}
          aria-current={tab.key === active ? "page" : undefined}
          onClick={() => onSelect(tab.key)}
        >
          {tab.icon === undefined ? null : <Icon name={tab.icon} size={14} />}
          <span>{tab.label}</span>
          {tab.count === undefined || tab.count === 0 ? null : <span className="counter">{tab.count > 99 ? "99+" : tab.count}</span>}
        </button>
      ))}
    </nav>
  );
}

/* ----------------------------------------------------------------- flash */

/** A notice in the page: an error said plainly, with the raw text folded away. */
export function Flash({ tone = "danger", children, error, action }: { tone?: "danger" | "warning" | "info" | "success"; children?: ReactNode; error?: unknown; action?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const explained = error === undefined ? undefined : friendlyError(error);
  return (
    <div className={`flash flash-${tone}`} role={tone === "danger" ? "alert" : "status"}>
      <Icon name={tone === "success" ? "tick" : tone === "info" ? "info" : "alert"} size={16} />
      <div className="flash-text">
        <span>{children ?? explained?.message}</span>
        {explained === undefined ? null : open ? (
          <code className="flash-detail">{explained.detail}</code>
        ) : (
          <button className="link-quiet small" onClick={() => setOpen(true)}>
            {t("showDetails")}
          </button>
        )}
      </div>
      {action}
    </div>
  );
}

/** The loading state of a part of a page: grey bars where its rows will be. */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label={t("loading")}>
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} className="skeleton-bar" style={{ width: `${90 - ((index * 17) % 40)}%` }} />
      ))}
    </div>
  );
}
