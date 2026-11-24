/*
 * Which kind of input she used last, the keyboard or a pointer (mouse, touch, pen), kept on
 * <html> as data-input="keyboard" | "pointer". The focus ring is drawn only after the keyboard
 * (styles/app.css; audit L11, layout rule 13): after a navigation the app still puts the
 * focus on the screen's title, but a mouse user sees no frame around it, while a keyboard
 * user sees where the focus is, as before. A key held alone that only modifies a click
 * (Shift, Control, Alt, Meta) does not count as using the keyboard.
 */

export type InputModality = "keyboard" | "pointer";

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Fn"]);

/** Follows the input on `target` (the window) and tells `set` each change. Returns what stops it. */
export function trackInputModality(target: EventTarget, set: (modality: InputModality) => void): () => void {
  let last: InputModality | null = null;
  const tell = (modality: InputModality) => {
    if (modality === last) return;
    last = modality;
    set(modality);
  };
  const onKey = (event: Event) => {
    if (!MODIFIERS.has((event as Event & { key?: string }).key ?? "")) tell("keyboard");
  };
  const onPointer = () => tell("pointer");
  // Capture: a screen that stops a key or a press from going further still tells this first.
  // Stopped by a signal, which removes both the same way everywhere (Node 24's EventTarget,
  // used by the unit test, kept a capture listener removed with a boolean).
  const stop = new AbortController();
  target.addEventListener("keydown", onKey, { capture: true, signal: stop.signal });
  target.addEventListener("pointerdown", onPointer, { capture: true, signal: stop.signal });
  return () => stop.abort();
}
