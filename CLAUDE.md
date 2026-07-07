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

Four source files, patched onto the shell rather than added as a separate UI.
`extension.js` wires the injections; `decoratorBase.js` holds the decoration
logic shared by both preview surfaces; `decorator.js` (thumbnail strip) and
`appgrid.js` (app-grid tiles) are thin subclasses supplying only what differs.

**`extension.js`** — the `Extension` entry point. `enable()` uses an
`InjectionManager` to wrap `addThumbnails` / `handleDragOver` / `acceptDrop` on
the native `ThumbnailsBox.prototype` (from
`resource:///.../ui/workspaceThumbnail.js`) plus `_updateWorkspaces` /
`handleDragOver` / `acceptDrop` on `WorkspacesView` and `Workspace` (the
app-grid tiles):

- `addThumbnails` — the single choke-point where the box builds thumbnails
  (initial fill *and* later additions). Wrapped to call `decorator.decorate()`
  on each (`_updateWorkspaces` is the analogous choke-point for the tiles).
- `handleDragOver` / `acceptDrop` — wrapped to recognise *our* reorder drag
  (identified by `source.isMissionWsReorder`) and call
  `global.workspace_manager.reorder_workspace()`. Any other drag source (e.g.
  the native window-onto-workspace drop) falls through to the original method.

`missionWsTargetIndex()` maps a pointer x-coordinate to the nearest thumbnail
by horizontal centre — so dropping in the gap still reorders to the closest.

**`decoratorBase.js`** — `WorkspaceDecoratorBase`, the long-lived instance
owning all decoration and its lifecycle for one preview surface. Per preview it
adds two circular `St.Button`s: a top-left drag **handle** (made draggable via
`DND.makeDraggable`; its `_delegate` carries `isMissionWsReorder` +
`sourceWorkspace`) and a top-right **close** button
(`workspace_manager.remove_workspace`, never the last one). Circles are centred
on the top corners so they overhang the edge — this requires disabling the
actor's `clip_to_allocation` (restored on teardown).

Show/hide is driven by **polling** `global.get_pointer()` against an expanded
preview rect every `POLL_INTERVAL` ms, not crossing events — deliberately,
because the window clones sit on top and make enter/leave events unreliable. The
hover zone extends `BUTTON_SIZE/2 + HOVER_EXTRA` px beyond the preview so circles
don't flicker at the edge. Subclasses override a handful of `_`-prefixed hooks —
`_addButtons` (button geometry/placement), `_connectExtra` (extra per-actor
wiring), `_shouldShowControls` (eligibility gate), `_onHoverResolved` (post-pick
effect) — plus `setDropTarget` and a couple of instance fields (`_buttonSize`,
`_hoverExtra`).

**`decorator.js`** — `ThumbnailDecorator extends WorkspaceDecoratorBase`, for the
overview thumbnail strip: 22px circles positioned absolutely (`set_position`,
repositioned on resize), always eligible, raising the active thumbnail above its
siblings. `missionWsTargetIndex()` (in `extension.js`) picks the drop slot.

**`appgrid.js`** — `WorkspaceTileDecorator extends WorkspaceDecoratorBase`, for
the app-grid ("Launchpad") `Workspace` tiles: larger 36px circles placed by
BinLayout alignment + translation, gated to the `APP_GRID` overview state, each
tile its own drop target (its `metaWorkspace.index()` is the slot).

**`stylesheet.css`** — `.mission-ws-circle` and the per-button/drop-target
classes. The close button leans red on hover, the handle blue.

## Conventions / gotchas

- **Teardown is load-bearing.** Everything created in `enable()`/`decorate`
  must be reverted in `disable()`/`_undecorate()`: `InjectionManager.clear()`,
  removing the `GLib.timeout` poll, disconnecting every stored signal id,
  `draggable.disconnectAll()`, destroying the button actors, restoring
  `clip_to_allocation`, and deleting the `actor._missionWs` marker. When adding
  any new actor/timer/handler, wire up its cleanup in the same commit.
- Per-preview state lives on `actor._missionWs` (also the "already decorated"
  guard — `decorate()` is idempotent).
- Keep everything ESM with the `gi://` / `resource:///` import scheme already in
  use. `node --check` in CI is the only syntax gate, so it must stay valid ESM.
- Bump `version-name` in `metadata.json` for releases; `shell-version` lists the
  supported GNOME majors.
```
