// SPDX-License-Identifier: MIT
//
// Decorates the App-Grid ("Launchpad") workspace tiles — the WorkspacesView
// `Workspace` actors GNOME shows side-by-side (FitMode.ALL) in the app-grid
// state — with the same reorder handle + close circles as the thumbnail strip,
// sized up for the much larger previews.
//
// The `ThumbnailsBox` strip is hidden in the app grid, so nothing there would
// otherwise be reorderable; this brings the feature to the tiles the user
// actually sees. The controls are only shown while the overview is in the
// APP_GRID state (the same tiles appear big in the window-picker, where the
// strip already handles reordering).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BUTTON_SIZE = 36;    // bigger than the strip's 22px, for the large tiles
const ICON_SIZE = 20;
const HOVER_EXTRA = 8;     // px of grace above the top edge (to reach circles)
const FADE_TIME = 120;     // ms
const POLL_INTERVAL = 120; // ms
const APP_GRID_STATE = 2;  // ControlsState.APP_GRID

const DROP_TARGET_CLASS = 'mission-ws-drop-target';

/**
 * Owns the per-tile decorations for the app-grid workspace previews. Mirrors
 * ThumbnailDecorator but kept separate so the (perfected) strip path is never
 * touched; the tiles differ enough (BinLayout corner placement, larger
 * buttons, app-grid state gating) to warrant their own small class.
 */
export class WorkspaceTileDecorator {
    constructor() {
        this._decorated = new Set();
        this._dropTargets = new Set();
        this._pollId = 0;

        this._overviewSignals = [
            Main.overview.connect('showing', () => this._startPoll()),
            Main.overview.connect('hidden', () => this._stopPoll()),
        ];
        if (Main.overview.visible)
            this._startPoll();
    }

    destroy() {
        this._stopPoll();
        for (const id of this._overviewSignals)
            Main.overview.disconnect(id);
        this._overviewSignals = [];
        for (const tile of [...this._decorated])
            this._undecorate(tile);
        this._decorated.clear();
        this.clearAllDropTargets();
    }

    /** Idempotently add the reorder handle + close circle to a tile. */
    decorateTile(tile) {
        if (!tile || tile._missionWsTile)
            return;

        const state = {shown: false, dragging: false, signalIds: []};
        tile._missionWsTile = state;

        // Let the circles overhang the tile corners (like the strip) rather
        // than sitting inside; the tile clips its children by default, so
        // disable it and restore the previous value on teardown.
        state.hadClip = tile.clip_to_allocation;
        tile.clip_to_allocation = false;

        // Workspace uses a BinLayout for its own children, so buttons added
        // here are placed by alignment (the WorkspaceLayout that lays out window
        // clones lives on tile._container, not on `tile`); a translation then
        // pulls each circle half-way outside its corner.
        const r = BUTTON_SIZE / 2;
        const handle = this._makeCircle('list-drag-handle-symbolic',
            'mission-ws-handle', Clutter.ActorAlign.START, -r);
        const close = this._makeCircle('window-close-symbolic',
            'mission-ws-close', Clutter.ActorAlign.END, r);
        tile.add_child(handle);
        tile.add_child(close);
        state.handle = handle;
        state.close = close;

        close.connect('clicked', () => this._onClose(tile));

        handle._delegate = {
            isMissionWsReorder: true,
            sourceWorkspace: tile.metaWorkspace,
            getDragActor: () => {
                const clone = new Clutter.Clone({
                    source: tile,
                    reactive: false,
                    opacity: 200,
                });
                clone.set_size(tile.width, tile.height);
                return clone;
            },
            getDragActorSource: () => tile,
        };
        const draggable = DND.makeDraggable(handle, {dragActorOpacity: 200});
        state.draggable = draggable;
        draggable.connect('drag-begin', () => {
            state.dragging = true;
        });
        draggable.connect('drag-end', () => {
            state.dragging = false;
            this.clearAllDropTargets();
        });
        draggable.connect('drag-cancelled', () => {
            state.dragging = false;
            this.clearAllDropTargets();
        });

        tile.set_child_above_sibling(handle, null);
        tile.set_child_above_sibling(close, null);

        tile.connect('destroy', () => this._undecorate(tile));

        this._decorated.add(tile);
    }

    // --- drop-target highlight, called from the Workspace injections ---

    setDropTarget(tile) {
        this.clearAllDropTargets();
        if (tile?._missionWsTile) {
            tile.add_style_class_name(DROP_TARGET_CLASS);
            this._dropTargets.add(tile);
        }
    }

    clearAllDropTargets() {
        for (const tile of this._dropTargets)
            tile.remove_style_class_name?.(DROP_TARGET_CLASS);
        this._dropTargets.clear();
    }

    // --- internals ---

    _startPoll() {
        if (this._pollId)
            return;
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_INTERVAL,
            () => {
                this._updateHover();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopPoll() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
        for (const tile of this._decorated)
            this._hide(tile);
    }

    _makeCircle(iconName, styleClass, xAlign, translationX) {
        const button = new St.Button({
            style_class: `mission-ws-circle mission-ws-circle-large ${styleClass}`,
            reactive: true,
            can_focus: false,
            track_hover: true,
            child: new St.Icon({icon_name: iconName, icon_size: ICON_SIZE}),
            x_align: xAlign,
            y_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_expand: true,
        });
        button.set_size(BUTTON_SIZE, BUTTON_SIZE);
        // Overhang the corner: half outside horizontally, half above the top.
        button.translation_x = translationX;
        button.translation_y = -BUTTON_SIZE / 2;
        button.opacity = 0;
        button.visible = false;
        return button;
    }

    /**
     * Show controls on the single tile under the pointer — but only while the
     * overview is in (or near) the APP_GRID state. In the window-picker these
     * same tiles are shown big and the thumbnail strip handles reordering.
     */
    _updateHover() {
        if (this._decorated.size === 0)
            return;

        const controls = Main.overview._overview?.controls;
        const stateValue = controls?._stateAdjustment?.value ?? 0;
        if (stateValue < APP_GRID_STATE - 0.5) {
            for (const tile of this._decorated)
                this._hide(tile);
            return;
        }

        const [px, py] = global.get_pointer();
        let active = null;
        for (const tile of this._decorated) {
            if (tile._missionWsTile?.dragging) {
                active = tile;
                break;
            }
        }
        // A visible circle wins even where it overhangs a neighbour tile.
        if (!active) {
            for (const tile of this._decorated) {
                if (this._pointerOnButtons(tile, px, py)) {
                    active = tile;
                    break;
                }
            }
        }
        if (!active) {
            for (const tile of this._decorated) {
                if (this._pointerOnTile(tile, px, py)) {
                    active = tile;
                    break;
                }
            }
        }

        for (const tile of this._decorated) {
            if (tile === active)
                this._show(tile);
            else
                this._hide(tile);
        }
    }

    _pointerOnTile(tile, px, py) {
        const [tx, ty] = tile.get_transformed_position();
        const [tw, th] = tile.get_transformed_size();
        if (!Number.isFinite(tx) || tw <= 0)
            return false;
        // Sides/bottom tight (no neighbour bleed); top extended so moving up
        // onto the overhanging circles keeps them shown.
        const topExtra = BUTTON_SIZE / 2 + HOVER_EXTRA;
        return px >= tx && px <= tx + tw &&
               py >= ty - topExtra && py <= ty + th;
    }

    _pointerOnButtons(tile, px, py) {
        const state = tile._missionWsTile;
        if (!state)
            return false;
        for (const btn of [state.handle, state.close]) {
            if (!btn?.visible)
                continue;
            const [bx, by] = btn.get_transformed_position();
            const [bw, bh] = btn.get_transformed_size();
            if (!Number.isFinite(bx) || bw <= 0)
                continue;
            if (px >= bx && px <= bx + bw && py >= by && py <= by + bh)
                return true;
        }
        return false;
    }

    _show(tile) {
        const state = tile._missionWsTile;
        if (!state || state.shown)
            return;
        state.shown = true;
        for (const btn of [state.handle, state.close]) {
            btn.visible = true;
            btn.remove_all_transitions();
            btn.ease({opacity: 255, duration: FADE_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
    }

    _hide(tile) {
        const state = tile._missionWsTile;
        if (!state || !state.shown)
            return;
        state.shown = false;
        for (const btn of [state.handle, state.close]) {
            btn.remove_all_transitions();
            btn.ease({opacity: 0, duration: FADE_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (!state.shown)
                        btn.visible = false;
                }});
        }
    }

    _onClose(tile) {
        const wm = global.workspace_manager;
        if (wm.get_n_workspaces() <= 1)
            return; // never remove the last workspace
        const ws = tile.metaWorkspace;
        if (ws)
            wm.remove_workspace(ws, global.get_current_time());
    }

    _undecorate(tile) {
        const state = tile._missionWsTile;
        if (!state)
            return;

        for (const id of state.signalIds)
            tile.disconnect(id);
        state.draggable?.disconnectAll?.();

        tile.clip_to_allocation = state.hadClip;
        tile.remove_style_class_name?.(DROP_TARGET_CLASS);
        this._dropTargets.delete(tile);

        state.handle?.destroy();
        state.close?.destroy();

        delete tile._missionWsTile;
        this._decorated.delete(tile);
    }
}
