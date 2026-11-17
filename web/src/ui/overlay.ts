/**
 * What every floating layer needs: a place beside the control that opened it,
 * kept on screen, and a way to close it - a click elsewhere or Escape - that
 * hands the keyboard back to that control.
 */
import { useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

export type Align = "start" | "end";

/**
 * Fixed coordinates for a layer under `anchor` (or over it when there is no
 * room below), lined up with its start or end edge, and redone on scroll and
 * resize so the layer follows the control.
 */
export function useAnchoredStyle(
  anchor: RefObject<HTMLElement | null>,
  layer: RefObject<HTMLElement | null>,
  open: boolean,
  align: Align = "start",
  minWidth?: number,
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ position: "fixed", visibility: "hidden", top: 0, left: 0 });
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const box = anchor.current?.getBoundingClientRect();
      const own = layer.current?.getBoundingClientRect();
      if (box === undefined) return;
      const width = Math.max(own?.width ?? 0, minWidth ?? 0);
      const height = own?.height ?? 0;
      const gap = 4;
      const below = window.innerHeight - box.bottom - gap;
      const top = below >= height || box.top < height ? box.bottom + gap : box.top - gap - height;
      let left = align === "start" ? box.left : box.right - width;
      left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
      setStyle({
        position: "fixed",
        top: Math.max(8, top),
        left,
        ...(minWidth === undefined ? {} : { minWidth }),
        maxHeight: Math.max(160, window.innerHeight - 16 - Math.max(8, top)),
      });
    };
    place();
    // A second pass once the layer has drawn and its own size is known.
    const frame = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor, layer, align, minWidth]);
  return style;
}

/** Close on a press outside every element given, or on Escape; focus goes back to `restore`. */
export function useDismiss(
  inside: readonly RefObject<HTMLElement | null>[],
  open: boolean,
  close: () => void,
  restore?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return undefined;
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (inside.some((ref) => ref.current?.contains(target) === true)) return;
      close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
      restore?.current?.focus();
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key, true);
    };
    // The refs are stable; what changes is whether the layer is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, close]);
}

/** Keep Tab inside `root` while it is open, as a dialog should. */
export function trapTab(event: React.KeyboardEvent, root: HTMLElement | null): void {
  if (event.key !== "Tab" || root === null) return;
  const focusable = [...root.querySelectorAll<HTMLElement>("button, [href], input, textarea, select, [tabindex]:not([tabindex='-1'])")].filter(
    (element) => !element.hasAttribute("disabled") && element.offsetParent !== null,
  );
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
