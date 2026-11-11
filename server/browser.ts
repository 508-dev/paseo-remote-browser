import { launch, type Browser, type BrowserContext, type Page } from "puppeteer-core";
import { normalizeUrl, VIEWPORT, type BrowserAction } from "../shared/browser";

interface Session {
  context: BrowserContext;
  page: Page | null;
  pages: Set<Page>;
}

/** Each workspace gets its own cookies and page; Chromium is shared by the plugin process. */
export class RemoteBrowser {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private stopped = false;

  constructor(private readonly startBrowser: typeof launch = launch) {}

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
    const page = await this.activePage(session);
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
        await page.keyboard.sendCharacter(input.text);
        break;
      case "key":
        await page.keyboard.press(input.key);
        break;
      case "scroll":
        await page.mouse.wheel({ deltaX: input.x, deltaY: input.y });
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
    await new Promise((resolve) => setTimeout(resolve, 80));
    const capturePage = await this.activePage(session);
    const image = await capturePage.screenshot({ type: "jpeg", quality: 68, encoding: "base64" });
    return { url: capturePage.url(), title: await capturePage.title(), image };
  }

  private launchBrowser(): Promise<Browser> {
    if (this.browser?.connected) return Promise.resolve(this.browser);
    this.launching ??= this.startBrowser({
      headless: true,
      pipe: true,
      protocolTimeout: 20_000,
      defaultViewport: VIEWPORT,
      ...(process.env.PASEO_BROWSER_EXECUTABLE
        ? { executablePath: process.env.PASEO_BROWSER_EXECUTABLE }
        : { channel: "chrome" }),
    })
      .then((browser) => {
        this.browser = browser;
        browser.once("disconnected", () => {
          if (this.browser !== browser) return;
          this.browser = null;
          this.sessions.clear();
        });
        return browser;
      })
      .finally(() => {
        this.launching = null;
      });
    return this.launching;
  }

  private async session(workspaceId: string): Promise<Session> {
    const existing = this.sessions.get(workspaceId);
    if (existing) return existing;
    const browser = await this.launchBrowser();
    const context = await browser.createBrowserContext();
    const session: Session = { context, page: null, pages: new Set() };
    try {
      await this.activePage(session);
      this.sessions.set(workspaceId, session);
      return session;
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
  }

  private async activePage(session: Session): Promise<Page> {
    if (session.page && !session.page.isClosed()) return session.page;
    const page = await session.context.newPage();
    await this.trackPage(session, page);
    return page;
  }

  private async trackPage(session: Session, page: Page): Promise<void> {
    await configurePage(page);
    if (page.isClosed()) return;
    session.pages.add(page);
    session.page = page;
    page.once("close", () => {
      session.pages.delete(page);
      if (session.page === page)
        session.page = [...session.pages].filter((item) => !item.isClosed()).at(-1) ?? null;
    });
    page.on("popup", (popup) => {
      if (popup)
        void this.trackPage(session, popup).catch(() => {
          void popup.close().catch(() => {});
        });
    });
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

async function configurePage(page: Page): Promise<void> {
  page.setDefaultTimeout(20_000);
  page.on("dialog", (dialog) => {
    void dialog.dismiss().catch(() => {});
  });
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const protocol = new URL(request.url()).protocol;
    const pending = ["http:", "https:", "data:", "blob:"].includes(protocol)
      ? request.continue()
      : request.abort();
    // Requests may disappear while their page or browser is closing.
    void pending.catch(() => {});
  });
}

function clamp(value: number, limit: number): number {
  if (!Number.isFinite(value)) throw new Error("Pointer coordinate must be finite");
  return Math.max(0, Math.min(limit - 1, value));
}
