# Paseo remote browser

A Paseo plugin that runs headless Chrome on the host and gives every workspace a private browser panel on mobile, web, and desktop. Navigate to `localhost:3000` to inspect a development server **on the host**. Tap the screenshot to click, type into a selected field, scroll, and use Back, Forward, Reload, and keyboard keys. The panel refreshes the screenshot every two seconds, so JavaScript updates appear without reloading.

The browser, cookies, and network requests stay on the host. Paseo's existing encrypted client connection carries screenshots and commands; this plugin opens no inbound port. Each workspace gets its own browser context and cookies. Archiving a workspace closes its context; unloading the plugin closes Chrome.

## Install

Requires Paseo 0.16.0-beta.1 or newer, Node 22+, and Chrome or Chromium installed on the host. If Chrome is not in its standard location, set `PASEO_BROWSER_EXECUTABLE` to its executable path in the daemon environment. The plugin uses `puppeteer-core`, which does not download a browser during installation.

Install directly from Git:

```sh
paseo plugin install git:508-dev/paseo-remote-browser
```

The daemon needs npm on its command path. The manifest installs `puppeteer-core` and the validation dependencies from the committed lockfile with lifecycle scripts disabled. The pinned browser driver includes its protocol dependencies, and preparation does not download a browser binary. Chrome must already be installed on the host.

Enable **Remote browser** in Paseo's plugin settings. The panel appears in each workspace and in Command Center. For a local directory source, run the development install command below before adding the directory.

## Limits

- The viewport is fixed at 1024 × 768 and sent as JPEG screenshots. It is interactive, but it does not stream video, audio, file downloads, or browser DevTools.
- The browser session is kept while the plugin runs. It resets when the daemon or plugin restarts.
- Only HTTP and HTTPS navigation is allowed. `localhost` resolves on the selected host.
- A website can see the host's network identity, as with any browser running there. Use this only with sites you trust.

## Development

```sh
npm ci --include=dev --ignore-scripts --legacy-peer-deps
npm run typecheck
npm run lint
npm run format:check
npm run test
```

Set `PASEO_BROWSER_INTEGRATION=1` to also exercise an installed Chrome against a local HTTP server. The integration test can use `PASEO_BROWSER_EXECUTABLE` to select a browser.
