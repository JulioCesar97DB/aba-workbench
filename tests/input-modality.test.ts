import assert from "node:assert/strict";
import { test } from "node:test";
import { trackInputModality, type InputModality } from "../src/renderer/src/input-modality.ts";

function key(name: string): Event {
  const event = new Event("keydown");
  Object.defineProperty(event, "key", { value: name });
  return event;
}

test("input modality: a key makes it keyboard, a press makes it pointer, each change told once", () => {
  const target = new EventTarget();
  const told: InputModality[] = [];
  const stop = trackInputModality(target, (modality) => told.push(modality));
  target.dispatchEvent(key("Tab"));
  target.dispatchEvent(key("Enter"));
  target.dispatchEvent(new Event("pointerdown"));
  target.dispatchEvent(new Event("pointerdown"));
  target.dispatchEvent(key("ArrowDown"));
  assert.deepEqual(told, ["keyboard", "pointer", "keyboard"]);
  stop();
  target.dispatchEvent(new Event("pointerdown"));
  assert.deepEqual(told, ["keyboard", "pointer", "keyboard"]);
});

test("input modality: a modifier alone (Shift-click, Cmd-click) is not keyboard use", () => {
  const target = new EventTarget();
  const told: InputModality[] = [];
  trackInputModality(target, (modality) => told.push(modality));
  target.dispatchEvent(new Event("pointerdown"));
  for (const name of ["Shift", "Control", "Alt", "Meta"]) target.dispatchEvent(key(name));
  assert.deepEqual(told, ["pointer"]);
  target.dispatchEvent(key("Escape"));
  assert.deepEqual(told, ["pointer", "keyboard"]);
});
