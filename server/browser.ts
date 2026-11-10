import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { normalizeUrl, VIEWPORT, type BrowserAction } from "../shared/browser";

interface Session {
  context: BrowserContext;
  page: Page;
}

/** Each workspace gets its own cookies and page; Chromium is shared by the plugin process. */
export class RemoteBrowser {
  private browser: Browser | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private stopped = false;

  async control(input: BrowserAction): Promise<{ url: string; title: string; image: string }> {
    if (this.stopped) throw new Error("Remote browser is stopping");
    const previous = this.queues.get(input.workspaceId) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.perform(input));
    this.queues.set(input.workspaceId, pending);
    try {
      return await pending;
    } finally {
      if (this.queues.get(input.workspaceId) === pending) this.queues.delete(input.workspaceId);
    }
  }

  private async perform(input: BrowserAction) {
    const session = await this.session(input.workspaceId);
    const page = session.page;
    switch (input.action) {
      case "navigate":
        await page.goto(normalizeUrl(input.url), {
          waitUntil: "domcontentloaded",
          timeout: 20_000,
        });
        break;
      case "click":
        await page.mouse.click(clamp(input.x, VIEWPORT.width), clamp(input.y, VIEWPORT.height));
        break;
      case "type":
        await page.keyboard.insertText(input.text);
        break;
      case "key":
        await page.keyboard.press(input.key);
        break;
      case "scroll":
        await page.mouse.wheel(input.x, input.y);
        break;
      case "back":
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 20_000 });
        break;
      case "forward":
        await page.goForward({ waitUntil: "domcontentloaded", timeout: 20_000 });
        break;
      case "reload":
        await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
        break;
      case "snapshot":
        break;
    }
    // Let immediate DOM updates paint before capture; the client also polls for later changes.
    await page.waitForTimeout(80);
    const image = (await page.screenshot({ type: "jpeg", quality: 68, timeout: 20_000 })).toString(
      "base64",
    );
    return { url: page.url(), title: await page.title(), image };
  }

  private async session(workspaceId: string): Promise<Session> {
    const existing = this.sessions.get(workspaceId);
    if (existing) return existing;
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        ...(process.env.PASEO_BROWSER_EXECUTABLE
          ? { executablePath: process.env.PASEO_BROWSER_EXECUTABLE }
          : { channel: "chrome" }),
      });
    }
    const context = await this.browser.newContext({ viewport: VIEWPORT });
    await context.route("**/*", (route) => {
      const protocol = new URL(route.request().url()).protocol;
      if (["http:", "https:", "data:", "blob:"].includes(protocol)) void route.continue();
      else void route.abort();
    });
    const page = await context.newPage();
    const session = { context, page };
    page.on("popup", (popup) => {
      session.page = popup;
    });
    this.sessions.set(workspaceId, session);
    return session;
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    await this.queues.get(workspaceId)?.catch(() => {});
    const session = this.sessions.get(workspaceId);
    this.sessions.delete(workspaceId);
    await session?.context.close();
  }

  async close(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled(this.queues.values());
    await Promise.allSettled([...this.sessions.values()].map((session) => session.context.close()));
    this.sessions.clear();
    await this.browser?.close();
    this.browser = null;
  }
}

function clamp(value: number, limit: number): number {
  if (!Number.isFinite(value)) throw new Error("Pointer coordinate must be finite");
  return Math.max(0, Math.min(limit - 1, value));
}
