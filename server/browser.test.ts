import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RemoteBrowser } from "./browser";
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
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<title>Ready</title><button style="position:absolute;left:10px;top:10px;width:120px;height:40px" onclick="document.title='Clicked'">Click</button>`,
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
});
