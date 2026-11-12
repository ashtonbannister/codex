import { useEffect, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

export interface LayoutState {
  navigation: boolean;
  inspector: boolean;
  navigationWidth: number;
  inspectorWidth: number;
}
const KEY = "nova.workbench.layout.v1";
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

export function useWorkspaceLayout() {
  const [layout, setLayout] = useState<LayoutState>(() => {
    const defaults = {
      navigation: true,
      inspector: window.innerWidth >= 1100,
      navigationWidth: 236,
      inspectorWidth: 356,
    };
    try {
      const saved = JSON.parse(
        localStorage.getItem(KEY) ?? "null",
      ) as Partial<LayoutState> | null;
      if (!saved) return defaults;
      return {
        navigation:
          typeof saved.navigation === "boolean"
            ? saved.navigation
            : defaults.navigation,
        inspector:
          typeof saved.inspector === "boolean"
            ? saved.inspector
            : defaults.inspector,
        navigationWidth: Number.isFinite(saved.navigationWidth)
          ? clamp(saved.navigationWidth!, 190, 360)
          : defaults.navigationWidth,
        inspectorWidth: Number.isFinite(saved.inspectorWidth)
          ? clamp(saved.inspectorWidth!, 300, 560)
          : defaults.inspectorWidth,
      };
    } catch {
      return defaults;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(layout));
    } catch {
      /* Layout remains usable without storage. */
    }
  }, [layout]);
  return [layout, setLayout] as const;
}

export function ResizeHandle({
  label,
  value,
  min,
  max,
  direction = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  direction?: number;
  onChange: (value: number) => void;
}) {
  const begin = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    const element = event.currentTarget;
    const start = event.clientX;
    const original = value;
    element.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) =>
      onChange(clamp(original + (next.clientX - start) * direction, min, max));
    const end = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", end);
      element.removeEventListener("pointercancel", end);
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", end, { once: true });
    element.addEventListener("pointercancel", end, { once: true });
  };
  return (
    <div
      className="resize-handle"
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      onPointerDown={begin}
      onKeyDown={(event) => {
        let next = value;
        if (event.key === "ArrowLeft") next -= 16 * direction;
        else if (event.key === "ArrowRight") next += 16 * direction;
        else if (event.key === "Home") next = min;
        else if (event.key === "End") next = max;
        else return;
        event.preventDefault();
        onChange(clamp(next, min, max));
      }}
    />
  );
}
