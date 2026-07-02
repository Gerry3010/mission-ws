# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A GNOME Shell extension (UUID `mission-ws@geraldhofbauer.net`) that adds
drag & drop workspace reordering to the overview thumbnail strip, plus
Mac-Mission-Control-style hover circles on each thumbnail. Targets GNOME
Shell **48–50** (developed on 50.1, Wayland). ES modules only (GJS/ESM).

## Commands

```sh
make install       # copy sources into ~/.local/share/gnome-shell/extensions/<UUID>
make install-link  # symlink the repo there instead (live editing)
make enable        # gnome-extensions enable <UUID>
make disable
make test          # `make install` + throwaway `gnome-shell --nested --wayland` (Wayland-safe, does not touch the live session)
make pack          # build the distributable .shell-extension.zip via gnome-extensions pack
make lint          # eslint if installed, else no-op
```

After `make install` on a live Wayland session, changes only take effect
after log out / back in (Xorg: `Alt+F2`, `r`). Use `make test` to iterate
without that — open the overview with **Super** inside the nested window.

There is no test suite. CI (`.github/workflows/ci.yml`) only validates
`metadata.json`, runs `node --check` on the JS sources, and packages the zip.

## Architecture

Two source files, patched onto the shell rather than added as a separate UI.

**`extension.js`** — the `Extension` entry point. `enable()` uses an
`InjectionManager` to wrap three methods on the native
`ThumbnailsBox.prototype` (from `resource:///.../ui/workspaceThumbnail.js`):

- `addThumbnails` — the single choke-point where the box builds thumbnails
  (initial fill *and* later additions). Wrapped to call
  `decorator.decorateThumbnail()` on each.
- `handleDragOver` / `acceptDrop` — wrapped to recognise *our* reorder drag
  (identified by `source.isMissionWsReorder`) and call
  `global.workspace_manager.reorder_workspace()`. Any other drag source (e.g.
  the native window-onto-workspace drop) falls through to the original method.

`missionWsTargetIndex()` maps a pointer x-coordinate to the nearest thumbnail
by horizontal centre — so dropping in the gap still reorders to the closest.

**`decorator.js`** — `ThumbnailDecorator`, one long-lived instance owning all
per-thumbnail decoration and its lifecycle. Per thumbnail it adds two circular
`St.Button`s: a top-left drag **handle** (made draggable via `DND.makeDraggable`;
its `_delegate` carries `isMissionWsReorder` + `sourceWorkspace`) and a
top-right **close** button (`workspace_manager.remove_workspace`, never the last
one). Circles are centred on the top corners so they overhang the edge — this
requires disabling the thumbnail's `clip_to_allocation` (restored on teardown).

Show/hide is driven by **polling** `global.get_pointer()` against an expanded
thumbnail rect every `POLL_INTERVAL` ms (see constants at the top of the file),
not crossing events — deliberately, because the window clones sit on top and
make enter/leave events unreliable. The hover zone extends `BUTTON_SIZE/2 +
HOVER_EXTRA` px beyond the thumbnail so circles don't flicker at the edge.

**`stylesheet.css`** — `.mission-ws-circle` and the per-button/drop-target
classes. The close button leans red on hover, the handle blue.

## Conventions / gotchas

- **Teardown is load-bearing.** Everything created in `enable()`/`decorate`
  must be reverted in `disable()`/`_undecorate()`: `InjectionManager.clear()`,
  removing the `GLib.timeout` poll, disconnecting every stored signal id,
  `draggable.disconnectAll()`, destroying the button actors, restoring
  `clip_to_allocation`, and deleting the `thumb._missionWs` marker. When adding
  any new actor/timer/handler, wire up its cleanup in the same commit.
- Per-thumbnail state lives on `thumb._missionWs` (also the "already decorated"
  guard — `decorateThumbnail` is idempotent).
- Keep everything ESM with the `gi://` / `resource:///` import scheme already in
  use. `node --check` in CI is the only syntax gate, so it must stay valid ESM.
- Bump `version-name` in `metadata.json` for releases; `shell-version` lists the
  supported GNOME majors.
```
