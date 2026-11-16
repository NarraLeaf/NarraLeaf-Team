/**
 * The "⋯" at the end of a row: every action a row has beyond its main one,
 * with the dangerous ones last, apart and in red. An action that cannot be
 * taken stays in the list, greyed, with the reason, so nobody hunts for it.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Icon, type IconName } from "../Icon";
import { t } from "../i18n";
import { useAnchoredStyle, useDismiss, type Align } from "./overlay";

export interface MenuAction {
  readonly label: string;
  readonly icon?: IconName;
  readonly danger?: boolean;
  /** Why it cannot be taken; the item is greyed when set. */
  readonly disabledReason?: string | undefined;
  readonly description?: string;
  readonly run: () => void;
}

export function ActionMenu({
  actions,
  label = t("moreActions"),
  align = "end",
  trigger,
}: {
  actions: readonly (MenuAction | false | undefined)[];
  label?: string;
  align?: Align;
  /** The button's face; the "⋯" when not given. */
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const button = useRef<HTMLButtonElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss([button, layer], open, close, button);
  const style = useAnchoredStyle(button, layer, open, align, 200);
  // The keyboard follows the menu as it opens, so arrows work at once.
  useEffect(() => {
    if (open) layer.current?.focus();
  }, [open]);

  const items = actions.filter((action): action is MenuAction => action !== false && action !== undefined);
  // The safe ones first, then the dangerous ones after a rule.
  const ordered = [...items.filter((item) => item.danger !== true), ...items.filter((item) => item.danger === true)];
  const firstDanger = ordered.findIndex((item) => item.danger === true);
  if (ordered.length === 0) return null;

  const run = (item: MenuAction | undefined) => {
    if (item === undefined || item.disabledReason !== undefined) return;
    setOpen(false);
    button.current?.focus();
    item.run();
  };
  const move = (by: number) => {
    setActive((at) => {
      let next = at;
      for (let step = 0; step < ordered.length; step += 1) {
        next = (next + by + ordered.length) % ordered.length;
        if (ordered[next]?.disabledReason === undefined) break;
      }
      return next;
    });
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className={trigger === undefined ? "btn btn-invisible btn-icon" : "btn btn-sm"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => {
          setActive(-1);
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActive(0);
          }
        }}
      >
        {trigger ?? <Icon name="more" />}
      </button>
      {open
        ? createPortal(
            <div
              ref={layer}
              className="overlay action-menu"
              style={style}
              role="menu"
              aria-label={label}
              tabIndex={-1}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  move(1);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  move(-1);
                } else if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  run(ordered[active]);
                } else if (event.key === "Tab") {
                  close();
                }
              }}
            >
              {ordered.map((item, index) => (
                <div key={`${item.label}-${index}`}>
                  {index === firstDanger && index > 0 ? <div className="menu-rule" role="separator" /> : null}
                  <button
                    type="button"
                    role="menuitem"
                    ref={(element) => {
                      if (index === active) element?.focus();
                    }}
                    className={`menu-item${item.danger === true ? " danger" : ""}${index === active ? " active" : ""}`}
                    aria-disabled={item.disabledReason !== undefined}
                    title={item.disabledReason}
                    onPointerEnter={() => setActive(index)}
                    onClick={() => run(item)}
                  >
                    {item.icon === undefined ? <span className="menu-icon-space" /> : <Icon name={item.icon} size={14} />}
                    <span className="menu-item-text">
                      <span>{item.label}</span>
                      {item.disabledReason !== undefined ? (
                        <span className="small menu-item-why">{item.disabledReason}</span>
                      ) : item.description === undefined ? null : (
                        <span className="small muted">{item.description}</span>
                      )}
                    </span>
                  </button>
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
