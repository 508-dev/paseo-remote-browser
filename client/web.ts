import { Platform } from "react-native";
import { jpegUri, VIEWPORT, type BrowserInput } from "../shared/browser";

interface BrowserEvent {
  clientX: number;
  clientY: number;
  pointerId: number;
  button: number;
  buttons: number;
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
  inputType: string;
  data: string | null;
  clipboardData?: { getData(type: string): string };
  preventDefault(): void;
}
interface Surface {
  contentEditable: string;
  tabIndex: number;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  setPointerCapture(id: number): void;
  focus(): void;
  addEventListener(
    type: string,
    listener: (event: BrowserEvent) => void,
    options?: { passive: boolean },
  ): void;
  removeEventListener(type: string, listener: (event: BrowserEvent) => void): void;
}

/** Browser APIs are isolated here; native uses RN responders and a keyboard input. */
export function bindBrowserSurface(ref: unknown, send: (input: BrowserInput) => void): () => void {
  if (Platform.OS !== "web" || !ref) return () => {};
  const node = ref as Surface;
  node.contentEditable = "true";
  node.tabIndex = 0;
  const held = new Set<string>();
  let composing = false;
  let pasted = false;
  const pointer = (event: BrowserEvent, phase: "move" | "down" | "up") => {
    const rect = node.getBoundingClientRect();
    send({
      action: "pointer",
      phase,
      x: ((event.clientX - rect.left) / rect.width) * VIEWPORT.width,
      y: ((event.clientY - rect.top) / rect.height) * VIEWPORT.height,
      button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left",
    });
  };
  let move: BrowserEvent | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (move) pointer(move, "move");
    move = undefined;
  };
  const listeners: Record<string, (event: BrowserEvent) => void> = {
    pointerdown: (event) => {
      event.preventDefault();
      node.focus();
      node.setPointerCapture(event.pointerId);
      pointer(event, "down");
    },
    pointermove: (event) => {
      move = event;
      timer ??= setTimeout(flush, 33);
    },
    pointerup: (event) => {
      flush();
      pointer(event, "up");
    },
    pointercancel: (event) => {
      flush();
      pointer(event, "up");
    },
    wheel: (event) => {
      event.preventDefault();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? VIEWPORT.height : 1;
      send({ action: "scroll", x: event.deltaX * scale, y: event.deltaY * scale });
    },
    keydown: (event) => {
      if (event.isComposing || composing) return;
      // Local clipboard shortcuts must retain their browser default so the paste event can read text.
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "v")
        return;
      if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) return;
      event.preventDefault();
      held.add(event.key);
      send({ action: "key", key: event.key, phase: "down" });
    },
    keyup: (event) => {
      if (held.delete(event.key)) {
        event.preventDefault();
        send({ action: "key", key: event.key, phase: "up" });
      }
    },
    beforeinput: (event) => {
      if (composing || event.isComposing) return;
      event.preventDefault();
      if (event.inputType === "insertFromPaste" && pasted) {
        pasted = false;
        return;
      }
      if (event.data) send({ action: "type", text: event.data });
    },
    compositionstart: () => {
      composing = true;
    },
    compositionend: (event) => {
      composing = false;
      if (event.data) send({ action: "type", text: event.data });
    },
    paste: (event) => {
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain");
      if (text) {
        pasted = true;
        send({ action: "type", text });
      }
    },
    contextmenu: (event) => event.preventDefault(),
    dragstart: (event) => event.preventDefault(),
    blur: () => {
      for (const key of held) send({ action: "key", key, phase: "up" });
      held.clear();
    },
  };
  for (const [type, listener] of Object.entries(listeners))
    node.addEventListener(type, listener, { passive: false });
  return () => {
    if (timer) clearTimeout(timer);
    listeners.blur!({} as BrowserEvent);
    for (const [type, listener] of Object.entries(listeners))
      node.removeEventListener(type, listener);
  };
}

export function frameSource(bytes: Uint8Array): { uri: string; release(): void } {
  if (Platform.OS !== "web") return { uri: jpegUri(bytes), release() {} };
  const uri = URL.createObjectURL(
    new Blob([Uint8Array.from(bytes).buffer], { type: "image/jpeg" }),
  );
  return { uri, release: () => URL.revokeObjectURL(uri) };
}
