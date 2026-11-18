/**
 * The one shape every "new …" takes: a button by a section's title opens this,
 * the fields sit in a dialog rather than in the page, and the dialog closes
 * itself once the server took what was sent. While it is sending the button
 * says so; when the server refuses, the reason shows above the buttons and
 * nothing typed is lost.
 */
import { useId, useState, type FormEvent, type ReactNode } from "react";

import { t } from "../i18n";
import { Flash } from "./controls";
import { Dialog } from "./Dialog";

export function FormDialog({
  title,
  lead,
  submitLabel,
  onSubmit,
  onClose,
  children,
  ready = true,
  width = 480,
  danger = false,
}: {
  title: string;
  /** A sentence under the title saying what this makes. */
  lead?: ReactNode;
  submitLabel: string;
  /** Resolve to keep going; resolve `false` to keep the dialog open; throw to show why it failed. */
  onSubmit: () => Promise<unknown> | unknown;
  onClose: () => void;
  children: ReactNode;
  /** Whether everything needed has been filled in. */
  ready?: boolean;
  width?: number;
  danger?: boolean;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // A form inside a portal still bubbles to the page's own form in React's tree.
    event.stopPropagation();
    if (busy || !ready) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await onSubmit();
      setBusy(false);
      if (result !== false) onClose();
    } catch (caught) {
      setBusy(false);
      setFailure(caught);
    }
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={width}
      danger={danger}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className={danger ? "btn btn-danger" : "btn btn-primary"} type="submit" form={id} disabled={busy || !ready}>
            {busy ? t("sending") : submitLabel}
          </button>
        </>
      }
    >
      <form id={id} className="dialog-form" onSubmit={(event) => void submit(event)}>
        {lead === undefined ? null : <p className="dialog-text">{lead}</p>}
        {children}
        {failure === undefined ? null : <Flash error={failure} />}
      </form>
    </Dialog>
  );
}
