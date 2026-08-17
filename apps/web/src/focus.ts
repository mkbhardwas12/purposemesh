import { useEffect, useRef } from "react";

const FOCUSABLE = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => !element.hidden && !element.closest("[inert]"),
  );
}

function inertOutside(container: HTMLElement): Array<{ element: HTMLElement; wasInert: boolean }> {
  const changed: Array<{ element: HTMLElement; wasInert: boolean }> = [];
  let branch: HTMLElement | null = container;

  while (branch?.parentElement) {
    const parent: HTMLElement = branch.parentElement;
    for (const sibling of [...parent.children]) {
      if (sibling !== branch && sibling instanceof HTMLElement) {
        changed.push({ element: sibling, wasInert: sibling.hasAttribute("inert") });
        sibling.setAttribute("inert", "");
      }
    }
    branch = parent;
    if (parent === document.body) break;
  }

  return changed;
}

export function useModalFocus<T extends HTMLElement>(
  onEscape: () => void,
  escapeDisabled = false,
) {
  const containerRef = useRef<T>(null);
  const escapeRef = useRef(onEscape);
  const escapeDisabledRef = useRef(escapeDisabled);
  escapeRef.current = onEscape;
  escapeDisabledRef.current = escapeDisabled;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const inerted = inertOutside(container);

    const focusInitial = () => {
      const preferred = container.querySelector<HTMLElement>("[data-autofocus]");
      (preferred ?? focusableWithin(container)[0] ?? container).focus();
    };
    queueMicrotask(focusInitial);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !escapeDisabledRef.current) {
        event.preventDefault();
        escapeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableWithin(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      for (const { element, wasInert } of inerted.reverse()) {
        if (!wasInert) element.removeAttribute("inert");
      }
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return containerRef;
}

export function focusableElements(container: HTMLElement): HTMLElement[] {
  return focusableWithin(container);
}
