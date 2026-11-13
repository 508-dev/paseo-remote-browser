import { randomUUID } from "node:crypto";
import type { CDPSession, Page } from "puppeteer-core";
import type { PluginSubscriptionContext } from "@getpaseo/plugin/server";
import type { RemoteBrowser } from "./browser";

type Event = Uint8Array | { streamId: string; url: string; title: string };

/** One outstanding frame per viewer; Chrome's pending frame and our latest frame stay bounded. */
export class BrowserStreams {
  private readonly viewers = new Map<
    string,
    { workspaceId: string; controller: AbortController }
  >();
  private readonly acknowledgements = new Map<string, (sequence: number) => void>();

  ack(streamId: string, sequence: number): null {
    this.acknowledgements.get(streamId)?.(sequence);
    return null;
  }

  async watch(
    browser: RemoteBrowser,
    workspaceId: string,
    { push, signal }: Pick<PluginSubscriptionContext<Event>, "push" | "signal">,
  ) {
    if (this.viewers.size >= 32) throw new Error("Too many browser viewers");
    const streamId = randomUUID();
    const controller = new AbortController();
    signal = AbortSignal.any([signal, controller.signal]);
    if (signal.aborted) return;
    this.viewers.set(streamId, { workspaceId, controller });
    let sequence = 0;
    let outstanding = 0;
    let sentAt = 0;
    let latest: Buffer | null = null;
    let cdp: CDPSession | undefined;
    let page: Page | undefined;
    let metadata = "";
    let failure: unknown;
    let sending = false;
    let disposed = false;

    const send = async () => {
      if (disposed || signal.aborted || sending || outstanding || !latest) return;
      const jpeg = latest;
      latest = null;
      const bytes = Buffer.allocUnsafe(4 + jpeg.byteLength);
      bytes.writeUInt32BE(++sequence);
      bytes.set(jpeg, 4);
      outstanding = sequence;
      sentAt = Date.now();
      sending = true;
      try {
        await push(bytes);
      } catch (error) {
        failure = error;
      } finally {
        sending = false;
      }
    };
    this.acknowledgements.set(streamId, (received) => {
      if (received === outstanding) outstanding = 0;
    });
    try {
      while (!signal.aborted) {
        if (failure) throw failure;
        if (outstanding && Date.now() - sentAt > 15_000)
          throw new Error("Browser frame acknowledgement timed out; reopen the panel");
        const active = await browser.page(workspaceId);
        if (active !== page) {
          if (cdp) await cdp.detach().catch(() => {});
          page = active;
          latest = null;
          cdp = await page.createCDPSession();
          const source = cdp;
          source.on("Page.screencastFrame", (frame) => {
            // Acknowledge capture independently of delivery, keeping only the newest complete JPEG.
            if (source === cdp) latest = Buffer.from(frame.data, "base64");
            void source
              .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
              .catch((error) => {
                if (source === cdp && !page?.isClosed() && !signal.aborted) failure = error;
              });
          });
          await source.send("Page.startScreencast", {
            format: "jpeg",
            quality: 65,
            maxWidth: 1024,
            maxHeight: 768,
            everyNthFrame: 1,
          });
        }
        let title: string;
        try {
          title = await page.title();
        } catch (error) {
          // Navigation replaces the document while the stream remains attached to the same target.
          if (
            page.isClosed() ||
            /Execution context was destroyed|Cannot find context|Navigating frame was detached/.test(
              String(error),
            )
          )
            continue;
          throw error;
        }
        const state = { streamId, url: page.url(), title };
        const next = JSON.stringify(state);
        if (next !== metadata) {
          await push(state);
          metadata = next;
        }
        await send();
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, 66);
          signal.addEventListener("abort", done, { once: true });
          if (signal.aborted) done();
        });
      }
    } finally {
      disposed = true;
      this.acknowledgements.delete(streamId);
      this.viewers.delete(streamId);
      if (cdp) await cdp.detach().catch(() => {});
    }
  }
  closeWorkspace(workspaceId: string) {
    for (const viewer of this.viewers.values())
      if (viewer.workspaceId === workspaceId) viewer.controller.abort();
  }
  close() {
    for (const viewer of this.viewers.values()) viewer.controller.abort();
  }
}
