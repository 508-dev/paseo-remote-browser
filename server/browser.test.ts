import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { launch } from "puppeteer-core";
import { RemoteBrowser } from "./browser";
import { BrowserStreams } from "./stream";
import { decodeFrame } from "../shared/browser";
import { normalizeUrl } from "../shared/browser";

describe("browser URL validation", () => {
  it("defaults bare hostnames to HTTP so host localhost ports work", () => {
    expect(normalizeUrl("localhost:3000")).toBe("http://localhost:3000/");
    expect(normalizeUrl("https://example.com")).toBe("https://example.com/");
  });

  it("rejects file and script URLs", () => {
    expect(() => normalizeUrl("file:///etc/passwd")).toThrow(/HTTP and HTTPS/);
    expect(() => normalizeUrl("javascript:alert(1)")).toThrow(/HTTP and HTTPS/);
  });
});

describe.skipIf(process.env.PASEO_BROWSER_INTEGRATION !== "1")("real host browser", () => {
  const browser = new RemoteBrowser();
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    if (request.url === "/popup" || request.url === "/nested") {
      response.end(
        `<title>${request.url === "/popup" ? "Popup" : "Nested"}</title><button style="position:absolute;left:10px;top:10px;width:120px;height:40px" onclick="window.open('/nested')">Nested</button><button style="position:absolute;left:10px;top:80px;width:120px;height:40px" onclick="window.close()">Close</button>`,
      );
      return;
    }
    if (request.url === "/dialog") {
      response.end(
        `<title>Before dialog</title><button style="position:absolute;left:10px;top:10px;width:120px;height:40px" onclick="alert('Hello');document.title='Dismissed'">Alert</button>`,
      );
      return;
    }
    response.end(
      `<title>Ready</title><button style="position:absolute;left:10px;top:10px;width:120px;height:40px" onclick="document.title='Clicked'">Click</button><button style="position:absolute;left:10px;top:80px;width:120px;height:40px" onclick="window.open('/popup')">Open popup</button>`,
    );
  });
  let port = 0;

  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    port = address.port;
  });

  afterAll(async () => {
    await browser.close();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("shares concurrent startup across workspaces and recovers after disconnect", async () => {
    const start = vi.fn(launch);
    const shared = new RemoteBrowser(start);
    try {
      const results = await Promise.all(
        ["first", "second"].map((workspaceId) =>
          shared.control({ action: "navigate", workspaceId, url: `127.0.0.1:${port}` }),
        ),
      );
      expect(results.map((result) => result.title)).toEqual(["Ready", "Ready"]);
      expect(start).toHaveBeenCalledTimes(1);
      const chrome = await start.mock.results[0]!.value;
      await chrome.close();
      expect(
        (
          await shared.control({
            action: "navigate",
            workspaceId: "first",
            url: `127.0.0.1:${port}`,
          })
        ).title,
      ).toBe("Ready");
      expect(start).toHaveBeenCalledTimes(2);
    } finally {
      await shared.close();
    }
  }, 30_000);

  it("tracks nested popups and restores the opener after each closes", async () => {
    const workspaceId = "popups";
    await browser.control({ action: "navigate", workspaceId, url: `127.0.0.1:${port}` });
    await browser.control({ action: "click", workspaceId, x: 40, y: 90 });
    await expect
      .poll(async () => (await browser.control({ action: "snapshot", workspaceId })).title)
      .toBe("Popup");
    await browser.control({ action: "click", workspaceId, x: 40, y: 30 });
    await expect
      .poll(async () => (await browser.control({ action: "snapshot", workspaceId })).title)
      .toBe("Nested");
    expect((await browser.control({ action: "click", workspaceId, x: 40, y: 90 })).title).toBe(
      "Popup",
    );
    expect((await browser.control({ action: "click", workspaceId, x: 40, y: 90 })).title).toBe(
      "Ready",
    );
  }, 30_000);

  it("dismisses unsupported JavaScript dialogs so controls keep working", async () => {
    const workspaceId = "dialogs";
    await browser.control({ action: "navigate", workspaceId, url: `127.0.0.1:${port}/dialog` });
    expect((await browser.control({ action: "click", workspaceId, x: 40, y: 30 })).title).toBe(
      "Dismissed",
    );
  }, 30_000);

  it("navigates on the host, captures a JPEG, and clicks page controls", async () => {
    const first = await browser.control({
      action: "navigate",
      workspaceId: "test",
      url: `127.0.0.1:${port}`,
    });
    expect(first.title).toBe("Ready");
    expect(first.image).toMatch(/^\/9j\//);
    const clicked = await browser.control({ action: "click", workspaceId: "test", x: 40, y: 30 });
    expect(clicked.title).toBe("Clicked");
  }, 30_000);
  it("streams changing pages without polling and bounds frames until the viewer acknowledges", async () => {
    const workspaceId = "streaming";
    const streams = new BrowserStreams();
    const controller = new AbortController();
    const page = await browser.page(workspaceId);
    await page.setContent(
      `<title>Live</title><div style="width:100px;height:100px;background:red;animation:move .5s infinite alternate"></div><style>@keyframes move { to { transform:translateX(200px);background:blue } }</style><input id="field" style="position:absolute;left:10px;top:150px" />`,
    );
    const frames: Uint8Array[] = [];
    let streamId = "";
    let streamedTitle = "";
    const done = streams.watch(browser, workspaceId, {
      signal: controller.signal,
      push: async (event) => {
        if (event instanceof Uint8Array) frames.push(event);
        else {
          streamId = event.streamId;
          streamedTitle = event.title;
        }
      },
    });
    try {
      await expect.poll(() => frames.length).toBe(1);
      expect([...decodeFrame(frames[0]!).jpeg.subarray(0, 2)]).toEqual([255, 216]);
      // Several browser animation frames pass, but the viewer still owns just one outstanding image.
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(frames.length).toBe(1);
      streams.ack(streamId, 999); // A stale/mismatched acknowledgement must not grant credit.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(frames.length).toBe(1);
      streams.ack(streamId, decodeFrame(frames[0]!).sequence);
      await expect.poll(() => frames.length).toBe(2);
      expect(decodeFrame(frames[1]!).sequence).toBe(2);
      streams.ack(streamId, 2);
      await browser.control({ action: "navigate", workspaceId, url: `127.0.0.1:${port}` }, false);
      await expect.poll(() => streamedTitle).toBe("Ready");
      await expect.poll(() => frames.length).toBe(3);
    } finally {
      controller.abort();
      await done;
    }
  }, 15_000);

  it("types and drags directly without taking a screenshot for each input", async () => {
    const workspaceId = "direct-input";
    const page = await browser.page(workspaceId);
    await page.setContent(
      `<input id="field" style="position:absolute;left:10px;top:10px;width:200px;height:40px" /><script>document.addEventListener('mouseup', () => { document.title = 'Released' })</script>`,
    );
    const capture = vi.spyOn(page, "screenshot");
    await browser.control({ action: "click", workspaceId, x: 30, y: 30 }, false);
    await browser.control({ action: "type", workspaceId, text: "Hello 世界" }, false);
    await browser.control({ action: "key", workspaceId, key: "Backspace", phase: "press" }, false);
    expect(
      await page.$eval("#field", (element) => (element as unknown as { value: string }).value),
    ).toBe("Hello 世");
    await browser.control(
      { action: "pointer", workspaceId, phase: "down", x: 30, y: 30, button: "left" },
      false,
    );
    await browser.control(
      { action: "pointer", workspaceId, phase: "move", x: 200, y: 30, button: "left" },
      false,
    );
    await browser.control(
      { action: "pointer", workspaceId, phase: "up", x: 200, y: 30, button: "left" },
      false,
    );
    expect(await page.title()).toBe("Released");
    expect(capture).not.toHaveBeenCalled();
  }, 15_000);
});
