## Computer Use

Use `cua` for Mac apps. Bindings and top-level `await` persist across calls.
Await each operation and keep app handles. Start with acquisition or inventory.

### Inventory

`await cua.getState()` returns available apps and windows. `await cua.listApps()` returns the app array.
App records are filtered by safety policy.

### App acquisition

For an app named by the user, acquire it directly:

```javascript
let app = await cua.getApp("Calculator");
```

A selector is an app name, bundle id or absolute `.app` path. Launch stays in the background.
`{ launch: false }` prevents a launch. `await cua.getApp({ windowId: "123" })` chooses a specific window.
Acquisition displays the window header and accessibility tree, and returns an app handle.
App access requires approval and identity checks. Ambiguity refuses.

### App reads

`await app.getAXState()` returns tree text and displays it. `{ disableDiffing: true }` requests a full tree.
`await app.getScreenshot()` returns and displays that window's screenshot.
`await app.getAXStateAndScreenshot()` returns `{ state, screenshot }` and displays both.
Pass `{ emit: false }` to retain a read or screenshot without displaying it. Reads also accept `depth` and `budgetMs`.
A limited read reports truncation. Window images use Retina pixels. Use the capture's geometry and scale note.

The tree begins with `Window: "<title>", App: <name>.` and numbered elements with `ID:`, `Help:`, `URL:` and `Secondary Actions:`. Secure fields show `<redacted>`.
Use numbers from the latest read of that window. A stale read or changed process identity refuses input.

### App input

`read`, `screenshot`, `type`, `key` and `press` calls on named app handles are rewritten before inspection.
Use the canonical methods below for containers.

```javascript
await app.click(4);
await app.click([120, 80], { mouseButton: "right", clickCount: 1 });
await app.doubleClick(4);
await app.rightClick(4);
await app.drag(4, [200, 140]);
await app.scroll(4, "down", { pixels: 400 });
await app.scroll(4, "up", 1);
await app.setValue(4, "Draft");
await app.selectText(4, "Draft", { prefix: "", suffix: "", selectionType: "text" });
await app.performSecondaryAction(4, "<advertised action>");
await app.typeText("Draft");
await app.paste("Draft", { format: "text" });
await app.pressKey("super+s");
```

A target is a number or exact ID string, `{ id: "AXIdentifier" }`, `{ label: "exact label" }` or screenshot point `[x, y]` (`{x,y}` also works).
Menus: `click the item's number; the menu need not be open`.
Click accepts `button` for `mouseButton`. Conflicts refuse. Double/right clicks take one target.
Points are window screenshot pixels from the top left. Text and key methods use the app's current caret or focus.
`pressKey` uses xdotool key names and chords. Paste formats are `text`, `md` and `html` when the driver supports them.
Only invoke secondary actions the current tree advertises. Methods not yet implemented return `METHOD_NOT_FOUND`.

Several awaited actions may share a cell when the parent's continuation rules permit them.
Actions report delivery and retry disposition. A posted event alone does not prove its effect.
After unknown delivery, read before retrying. Stop if a person takes over and read again.
Follow approval, lease, forbidden-target, payment and document-scope refusals. Never work around a refusal.

### Results and session lifetime

`nodeRepl.write(value)` displays text or a JSON value. `await nodeRepl.emitImage({ data: base64, mimeType: "image/png" })`
displays an image. A data URL or a `bytes` buffer can also supply image data. PNG, JPEG and WebP are accepted.
The final expression displays unless emitted or an app handle. Console output stays in the cell.

`js_reset` and timeouts clear bindings and handles. Acquire again.
`await cua.rewriteDocumentation()` displays and returns this reference without clearing bindings.
Driver restarts also expire app handles. Acquire again.
