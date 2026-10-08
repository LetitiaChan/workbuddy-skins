---
name: workbuddy-skins
description: >-
  Apply a reversible theme/skin to the WorkBuddy desktop app (Tencent AI office
  agent) via local Chromium DevTools Protocol (CDP) injection. Use when the user
  wants to change WorkBuddy's appearance/theme/skin, references an open-source
  WorkBuddy theming project by GitHub URL, or says phrases like "帮我换 WorkBuddy
  主题/皮肤", "用这个开源项目帮我更换 WorkBuddy 的主题", or "change my WorkBuddy
  theme". Never modifies app.asar, the official install directory, or code signing.
---

# WorkBuddy Skins

Reversible WorkBuddy desktop theming through local CDP injection. The tool
restarts WorkBuddy with `--remote-debugging-port=9223`, discovers its renderer
(`renderer/index.html`), and injects CSS + a 🎨 theme menu into the live UI.
No official files are touched.

## When this skill applies

- The user gives you a GitHub URL for `workbuddy-skins` (or similar) and
  asks you to install / apply / use it to theme WorkBuddy.
- The user wants to change WorkBuddy's look (color theme, background image,
  custom uploaded image) without editing the official app.
- The user reports the theme disappeared after a WorkBuddy restart and wants it
  reapplied, or wants to revert to the native look.

## Prerequisites

- **WorkBuddy desktop installed** (this tool themes the desktop app, not web).
- **Node.js 18+** on PATH (the injector is plain Node, cross-platform).
- macOS **or** Windows. (Linux is not supported by WorkBuddy's desktop build.)
- Restart behavior: the Windows `apply.ps1` / `Start.bat` probe the CDP port
  first and **skip the restart entirely when WorkBuddy is already in debug
  mode** (port 9223 listening) — in-app work is unaffected in that case. The
  macOS `apply.command` always restarts. Warn the user once: when a restart is
  needed, unsaved in-app work is lost — ask them to save first.

## Platform detection (run first)

- macOS: shell `uname` returns `Darwin`, or `$OSTYPE` starts with `darwin`.
- Windows: PowerShell `$IsWindows` is `$true`, or `$env:OS` is `Windows_NT`.
- Choose the matching branch below.

## Workflow — macOS

1. Clone / open the repo, then run the launcher (double-click works, or CLI):

   ```bash
   # default theme (miku-light)
   ./scripts/apply.command

   # or a specific theme via the cross-platform CLI
   node src/cli.mjs apply --theme mice-cat
   ```

   `apply.command` quits WorkBuddy, relaunches it with the CDP port, waits for
   the debugger, and injects the skin.
2. Verify:

   ```bash
   node src/cli.mjs status
   ```

   Expect an injected/active state and the WorkBuddy renderer listed.
3. A 🎨 button appears at the top-right of WorkBuddy. Tell the user they can
   switch themes, upload a custom image, or revert to native from that menu.
  The button is draggable (position persists across restarts as viewport
  fractions, so it keeps its relative spot on maximize/resize; double-click
  resets it to the default top-right spot).

## Workflow — Windows

1. From the repo directory, run in **PowerShell** (not cmd):

   ```powershell
   # default theme (miku-light)
   .\scripts\apply.ps1

   # or a specific theme
   .\scripts\apply.ps1 -Theme mice-cat
   ```

   If you hit an execution-policy error, run once:
   `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, then retry.

   For manual use, the primary Windows entry is double-clicking `Start.bat` at the
   repo root. It wraps `apply.ps1` (probe CDP port 9223 → quit and relaunch
   WorkBuddy in debug mode only if the port is not listening → inject skin;
   an already-debug-mode WorkBuddy is left running and injected in place),
   restores the last 🎨 menu choice when run without arguments, works
   regardless of the system execution policy (`-ExecutionPolicy Bypass` is built
   in), keeps the console window open with the error message on failure, and
   accepts an optional theme id: `Start.bat mice-cat`.
2. If `apply.ps1` cannot locate `WorkBuddy.exe`, run the locator and follow its
   printed hint (often you just need to launch WorkBuddy once so the path is
   registered):

   ```powershell
   .\scripts\find-workbuddy.ps1
   ```

3. Verify:

   ```powershell
   node src/cli.mjs status
   ```

4. Same 🎨 menu appears top-right in WorkBuddy.

## Choosing a theme

- List available themes: `node src/cli.mjs list` (macOS) / same via PowerShell.
- Built-ins (65 total) include `miku-light`, `genshin-dawn`, `genshin-night`,
  `deepspace-dawn`, `deepspace-star`, `naruto-hokage`, `naruto-sasuke`,
  `eva-unit01`, `wuthering-echo`, `wuthering-tide`, `wukong`, `mice-cat`,
  `cutie`, `misty-fir-rain`, `moonlit-night`, `snow-animals`, `preset-aurora`,
  `preset-starry`, `preset-liquid-glass-light`, `preset-liquid-glass-dark`,
  `vangogh-starry`, `gundam`,
  `rick-morty`, `sunset-ridge`, `interstellar`, `moon`, `totoro`,
  `ink-samurai`, `caishen-readable`, `dragonball-nimbus`,
  `dragonball-super-saiyan`, plus 14 photography / vector themes
  (`earth-night`, `mountain-path`, `forest-lantern`, `motorcycle`, `bamboo`,
  `sea-sunset`, `green-ink`, `coastal-arches`, `teal-waves`,
  `lighthouse-dusk`, `galaxy`, `world-map`, `teal-mountains`, `blue-waves`),
  plus four full-page CSS themes: `qq2008` (QQ 2008),
  `tdp-pro` / `tdp-pro-dark` (Tencent Cloud TDP, light / dark), and
  `sky-clock` (Sky Clock · 四时天空 — a time-driven sky: a companion js
  rebuilds the scene SVG hourly, moving the sun/moon along an arc and shifting
  sky/panel colors through real-sky keyframes; declares `dynamicMode` so the
  menu does not pin light/dark and the js owns the mode writes), six scenery
  illustration CSS themes (`aurora`, `dream`, `forest`, `midnight`, `paper`,
  `sakura`), plus ten pure-color CSS themes imported from
  workbuddy-skin-skill: `focus-night`, `warm-paper`, `cyber-lobster`,
  `stage-aurora`, `rose-glam`, `silver-idol`, `sakura-dream`, `mecha-core`,
  `magical-night`, `pixel-campus`. Full-page CSS themes appear under the
  "定制主题" group in the 🎨 menu, scenery CSS themes under "风景主题"
  (theme.json `group: "scenery"`), pure-color CSS themes under "配色主题"
  (theme.json `group: "palette"`), and image/video themes under "图片主题".
- 39 built-in themes also ship a `mascot.webp` (theme.json `mascot` field) that
  replaces the growth-buddy robot above the home/conversation input with theme
  art — a pure CSS swap (`img { content: url() }` + `object-fit: contain`,
  animated GIF/WebP kept) that applies and reverts with the theme switch;
  themes without it keep the native robot.
- If the user names a mood/character (e.g. "dark Genshin"), map it to the
  closest id, or just apply the default and let them pick from the 🎨 menu.
- Running `apply` **without** `--theme` restores the user's last 🎨 menu choice:
  a built-in theme, a custom upload, or "native light / native dark" (menu
  injected, no skin applied, only the light/dark kind pinned).
- Custom image: `node src/cli.mjs create --image "/path/to/hero.webp" --name "My Skin"`
  then `node src/cli.mjs apply --theme my-skin`. The in-app 🎨 menu also supports
  "＋ 自定义皮肤" (images and MP4 video) with automatic color extraction. Up to 10
  custom-upload slots are kept simultaneously (each persisted and deletable).
  Animated images (GIF / animated WebP / animated AVIF) are supported: they bypass
  canvas re-encoding to keep the animation, capped at 3 MB (localStorage quota)
  and 1920 px longest side (rendering performance) in both the menu and CLI paths.
  MP4 (H.264) videos are supported in the menu path: a sampled frame drives color
  extraction, a poster frame backs the CSS layer, the video plays muted/looped as
  a fixed background layer, and the raw file is stored in IndexedDB (capped at
  30 MB) instead of localStorage. AVIF requires the embedded Chromium to be ≥ 85
  (any recent Electron qualifies).

## Apply receipts

Every apply/pause writes a receipt to `state.json` (time, theme, ok/error);
`doctor` shows it along with a Node.js version check (requires 18+).

## Pause / restore to native

```bash
# macOS
./scripts/pause.command

# Windows (PowerShell)
.\scripts\pause.ps1
```

This removes the injected skin and relaunches WorkBuddy normally. The official
install is always left untouched.

## Guardrails

- Never replace, edit, or take ownership of `WorkBuddy.app`, `app.asar`, or the
  Windows install directory. This tool only injects into the live renderer.
- CDP binds to loopback `127.0.0.1` only. Tell the user not to run untrusted
  local software while a skin is active (Chromium CDP has no same-user auth).
- Revision: injection lives for the renderer's lifetime. After a **manual**
  WorkBuddy restart the skin disappears by design — re-run `apply` to bring it
  back. The injected
  menu/style also self-heal: if the frontend framework rebuilds the DOM tree and
  drops them, a MutationObserver re-attaches them automatically.
- Built-in video themes pre-provision their MP4 into the renderer's IndexedDB at
  apply time (chunked). A failed pre-provision (renderer timeout / OOM) degrades
  to a warning and does **not** block the skin injection; the menu falls back
  with a hint when video data is missing.
- Do not import README/preview screenshots or images with baked-in UI as a
  theme background; use clean wallpapers / character art.
- CSS themes may ship a companion `js` that executes inside the renderer
  (`new Function`) for DOM injection (e.g. TDP's hero layer, QQ 2008's sounds and
  pet widget). Only apply themes from a repo the user trusts; the JS returns an
  optional teardown callback that runs on theme switch / native restore / pause.
  A CSS+js theme may also declare `dynamicMode: true` (validated in the schema):
  the menu then skips its light/dark pinning and the companion js owns the mode
  writes (six mode classes + `data-vscode-theme-kind`/`name` + `colorScheme`,
  same shape as the menu's own writer) — used by `sky-clock` to follow the sky.

## Checks (sanity before reporting done)

```bash
npm test                  # unit tests (node:test) — no live WorkBuddy required
node src/cli.mjs doctor   # platform, app path, CDP port, renderer hint
node src/cli.mjs status   # injection state
node --check src/cli.mjs  # syntax
```

`doctor` should report the correct platform, a found WorkBuddy app, and the
renderer hint `renderer/index.html`. `npm test` should report all tests passing.

## Resources

- `src/cli.mjs` — entry point: `list` / `create` / `apply` / `status` / `pause` / `doctor`.
- `src/cdp-client.mjs` — CDP connection + renderer discovery.
- `src/skin-css.mjs` — `--cb-*` variable overrides + background + container transparency.
  Shared blocks: variable-override block and component accents are single-sourced for
  image themes (`buildSkinCss`) and pure-color palette themes (`buildPaletteCss` — solid
  surfaces, no hero; the palette theme's own `skin.css` is a decoration layer with the
  theme's signature gradients, appended after the generated base at apply time).
- `src/skin-menu.mjs` — the 🎨 in-app menu (switch / upload / delete / native) + draggable
  menu button (pointer-capture drag, 5px click/drag threshold, position persisted as
  viewport fractions so maximize/resize keeps the relative spot, viewport clamping,
  double-click reset to default) + self-heal
  re-attach observer + right-side nav buttons (top / prev question / next question /
  bottom, heuristic scroll-box and user-anchor detection, rAF smooth scroll).
- `src/injector.mjs` — idempotent CSS+menu injection and removal (re-inject / pause
  call the menu's `window.__workbuddySkinTeardown` first).
- `src/state-store.mjs` — apply/pause receipt (`state.json`, atomic write, merge semantics).
- `src/renderer-snippets.mjs` — shared in-page JS snippets (IndexedDB open, base64 decode).
- `src/constants.mjs`, `src/theme-schema.mjs`, `src/theme-store.mjs` — config & theme model.
- `scripts/make-theme.mjs` (`npm run make-theme -- <src> --id ID --name NAME`) — turn an
  image / animated image / video into a bundled `themes/<id>/`: 16:9 crop → WebP; video
  auto-transcode to H.264/yuv420p/≤1920/≤30fps/no audio/≤30MB (CRF → two-pass → trim)
  + poster; palette + light/dark surfaces via the menu's algorithm; README row. Needs ffmpeg.
- `scripts/apply.command` / `pause.command` — macOS launchers.
- `Start.bat` (repo root) — Windows double-click entry: forwards to `apply.ps1`
  with an optional theme id, execution-policy-proof (`-ExecutionPolicy Bypass`).
- `scripts/apply.ps1` / `pause.ps1` / `find-workbuddy.ps1` — Windows launchers
  (shared `Find-WorkBuddyExe` / `Find-Node` live in `scripts/common.ps1`).
- `themes/` — 65 built-in theme folders (`theme.json` + `hero.webp`; video themes use
  `hero.mp4` + `poster` image, e.g. `misty-fir-rain`, `snow-animals`; CSS themes use a
  `css` field — optional `js` companion script, `order` sort key, and `group` field:
  `"custom"` (default, full-page ports like `qq2008`, `tdp-pro`, `tdp-pro-dark`,
  `sky-clock`),
  `"palette"` (pure-color ports, the ten workbuddy-skin-skill themes), or
  `"scenery"` (scenery illustration ports: `aurora`, `dream`, `forest`,
  `midnight`, `paper`, `sakura`). Any theme may
  set an optional `thumbnail` image (≤512KB, 640×400 WebP recommended) used as the
  theme-picker card cover; without it CSS themes show an accent→secondary gradient
  and image themes extract their hero/poster.
- `test/` — Node built-in unit tests (`node:test`): theme schema/poster/CSS rules and
  path-escape guard, bundled-theme guard (every `themes/` dir loads and its `js`
  compiles), skin CSS generation (title gradient / tagline / two-tone wordmark),
  theme listing/dedup, CDP session domains, CLI apply orchestration, video
  pre-provision chunking/dedup/failure degradation, CSS asset inlining, and 🎨 menu
  script structure (teardown, rAF-coalesced layout). Run `npm test`.
- `README.md` — full human-readable documentation.

## One-line summary for the user

> "I cloned workbuddy-skins and injected the theme (WorkBuddy was restarted
> into debug mode only if it wasn't already). Use the 🎨 button (top-right) to
> switch or revert. Re-run apply if you restart WorkBuddy manually."
