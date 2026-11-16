/**
 * Dialogs and toasts, asked for from anywhere and drawn by one host the shell
 * mounts once (`<UiHost />`).
 *
 * `confirmAction` is GitHub's two kinds of "are you sure": a plain question
 * for an action that can be undone by hand, and one that wants a name typed
 * before an action that cannot - deleting a project, disabling an account.
 * `toast` says that something worked, or why it did not, and goes away.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Icon } from "../Icon";
import { t } from "../i18n";
import { trapTab } from "./overlay";

/* ----------------------------------------------------------------- store */

interface Ask {
  readonly id: number;
  readonly title: string;
  readonly body?: ReactNode;
  readonly confirmLabel: string;
  readonly danger: boolean;
  readonly typeToConfirm?: string | undefined;
  readonly resolve: (yes: boolean) => void;
}

export type ToastTone = "success" | "danger" | "info";

interface Toast {
  readonly id: number;
  readonly message: string;
  readonly tone: ToastTone;
  readonly detail?: string | undefined;
}

let next = 1;
let asks: readonly Ask[] = [];
let toasts: readonly Toast[] = [];
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/**
 * Ask before doing something. Resolves true when confirmed. With
 * `typeToConfirm`, the button stays off until exactly that text is typed.
 */
export function confirmAction(options: {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  typeToConfirm?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    asks = [
      ...asks,
      {
        id: next++,
        title: options.title,
        ...(options.body === undefined ? {} : { body: options.body }),
        confirmLabel: options.confirmLabel ?? t("confirm"),
        danger: options.danger ?? false,
        typeToConfirm: options.typeToConfirm,
        resolve,
      },
    ];
    emit();
  });
}

const TOAST_MS = 4_000;

/** A short note at the bottom of the screen. An error keeps its raw text folded under "details". */
export function toast(message: string, tone: ToastTone = "success", detail?: string): void {
  const id = next++;
  toasts = [...toasts.slice(-3), { id, message, tone, detail }];
  emit();
  if (detail === undefined) {
    setTimeout(() => {
      toasts = toasts.filter((one) => one.id !== id);
      emit();
    }, TOAST_MS);
  }
}

/** The raw text of anything thrown. */
export function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * What a failed call means to a person, in their language: known server
 * refusals get a sentence, and anything else a general one. The raw text is
 * kept for "details".
 */
export function friendlyError(caught: unknown): { message: string; detail: string } {
  const raw = errorText(caught);
  const lower = raw.toLowerCase();
  const message =
    lower === "not connected" || lower.includes("socket") || lower.includes("network")
      ? t("errOffline")
      : lower.includes("no method called")
        ? t("errOldServer")
        : lower.includes("forbidden") || lower.includes("not allowed") || lower.includes("permission") || lower.includes("may not")
          ? t("errForbidden")
          : lower.includes("not found") || lower.includes("no such") || lower.includes("unknown")
            ? t("errNotFound")
            : lower.includes("timed out") || lower.includes("timeout")
              ? t("errTimeout")
              : t("errGeneric");
  return { message, detail: raw };
}

/** Toast what went wrong with a call. */
export function toastError(caught: unknown): void {
  const { message, detail } = friendlyError(caught);
  toast(message, "danger", detail);
}

/* ------------------------------------------------------------------ host */

export function UiHost() {
  const shownAsks = useSyncExternalStore(subscribe, () => asks);
  const shownToasts = useSyncExternalStore(subscribe, () => toasts);
  const top = shownAsks[0];
  return createPortal(
    <>
      {top === undefined ? null : (
        <ConfirmDialog
          key={top.id}
          ask={top}
          done={(yes) => {
            asks = asks.filter((one) => one.id !== top.id);
            emit();
            top.resolve(yes);
          }}
        />
      )}
      <div className="toasts" role="status" aria-live="polite">
        {shownToasts.map((one) => (
          <ToastView
            key={one.id}
            toast={one}
            dismiss={() => {
              toasts = toasts.filter((other) => other.id !== one.id);
              emit();
            }}
          />
        ))}
      </div>
    </>,
    document.body,
  );
}

function ToastView({ toast: one, dismiss }: { toast: Toast; dismiss: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`toast tone-${one.tone}`}>
      <Icon name={one.tone === "success" ? "tick" : one.tone === "danger" ? "alert" : "info"} size={16} />
      <div className="toast-text">
        <span>{one.message}</span>
        {one.detail === undefined ? null : open ? (
          <code className="toast-detail">{one.detail}</code>
        ) : (
          <button className="link-quiet small" onClick={() => setOpen(true)}>
            {t("showDetails")}
          </button>
        )}
      </div>
      <button className="btn btn-invisible btn-icon btn-sm" aria-label={t("close")} onClick={dismiss}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

/** A dialog frame: a title, a body, and a row of buttons at the bottom right. */
export function Dialog({
  title,
  children,
  footer,
  onClose,
  width = 440,
  danger = false,
}: {
  title: string;
  children?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  width?: number;
  danger?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const first = root.current?.querySelector<HTMLElement>("[autofocus], input, textarea, .dialog-foot button:first-child");
    first?.focus();
    return () => before?.focus();
  }, []);
  return createPortal(
    <div className="dialog-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()} role="presentation">
      <div
        ref={root}
        className={danger ? "dialog dialog-danger" : "dialog"}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
          trapTab(event, root.current);
        }}
      >
        <header className="dialog-head">
          <h2>{title}</h2>
          <button className="btn btn-invisible btn-icon btn-sm" aria-label={t("close")} onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </header>
        {children === undefined ? null : <div className="dialog-body">{children}</div>}
        {footer === undefined ? null : <footer className="dialog-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

function ConfirmDialog({ ask, done }: { ask: Ask; done: (yes: boolean) => void }) {
  const [typed, setTyped] = useState("");
  const ready = ask.typeToConfirm === undefined || typed === ask.typeToConfirm;
  return (
    <Dialog
      title={ask.title}
      danger={ask.danger}
      onClose={() => done(false)}
      footer={
        <>
          <button className="btn" onClick={() => done(false)}>
            {t("cancel")}
          </button>
          <button className={ask.danger ? "btn btn-danger" : "btn btn-primary"} disabled={!ready} onClick={() => done(true)}>
            {ask.confirmLabel}
          </button>
        </>
      }
    >
      {ask.body === undefined ? null : typeof ask.body === "string" ? <p className="dialog-text">{ask.body}</p> : ask.body}
      {ask.typeToConfirm === undefined ? null : (
        <form
          className="type-confirm"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) done(true);
          }}
        >
          <label>
            <span>{t("typeToConfirm", { text: "" })}<strong className="mono">{ask.typeToConfirm}</strong></span>
            <input autoFocus value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false} />
          </label>
        </form>
      )}
    </Dialog>
  );
}
