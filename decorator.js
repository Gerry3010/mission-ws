// SPDX-License-Identifier: MIT
//
// Decorates the native overview WorkspaceThumbnail actors with two circular,
// Mac-Mission-Control-style hover buttons:
//   * top-left  -> reorder handle (draggable; reorders the workspace)
//   * top-right -> close button   (removes the workspace)
//
// The circles are centred ON the thumbnail corners, so they overhang its edge.
// They stay visible until the pointer leaves the thumbnail *plus the circle
// radius* (a deliberately generous mouse-out zone), matching macOS feel.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BUTTON_SIZE = 22;   // circle diameter in px (radius = SIZE / 2)
const HOVER_EXTRA = 8;    // px of grace above the top edge (to reach the circles)
const FADE_TIME = 120;    // ms fade in/out
const POLL_INTERVAL = 120; // ms between pointer polls (one shared timer)

const DROP_TARGET_CLASS = 'mission-ws-drop-target';

/**
 * Owns all per-thumbnail decorations and their lifecycle. One instance lives
 * for the duration of the extension; the ThumbnailsBox prototype injections in
 * extension.js call into `decorateThumbnail()` and the drop-target helpers.
 */
export class ThumbnailDecorator {
    constructor() {
        this._decorated = new Set();       // decorated WorkspaceThumbnail actors
        this._dropTargets = new Set();      // thumbnails currently highlighted
        this._pollId = 0;

        // A single pointer poll drives show/hide for *all* thumbnails (see
        // _updateHover). The thumbnails only exist while the overview is up, so
        // the timer runs only then — no idle wakeups when it's closed.
        Main.overview.connectObject(
            'showing', () => this._startPoll(),
            'hidden', () => this._stopPoll(),
            this);
        if (Main.overview.visible)
            this._startPoll();
    }

    destroy() {
        this._stopPoll();
        Main.overview.disconnectObject(this);
        for (const thumb of [...this._decorated])
            this._undecorate(thumb);
        this._decorated.clear();
        this.clearAllDropTargets();
    }

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
        // Don't leave any circles faded-in for the next overview open.
        for (const thumb of this._decorated)
            this._hide(thumb);
    }

    /** Idempotently add the hover circles + drag handle to a thumbnail. */
    decorateThumbnail(thumb) {
        if (!thumb || thumb._missionWs)
            return;

        const state = {
            shown: false,
            dragging: false,
        };
        thumb._missionWs = state;

        // The native thumbnail clips its children; disable so the circles can
        // overhang the corners. Remember the previous value to restore later.
        state.hadClip = thumb.clip_to_allocation;
        thumb.clip_to_allocation = false;

        // --- reorder handle (top-left) ---
        const handle = this._makeCircle('list-drag-handle-symbolic',
            'mission-ws-handle');
        thumb.add_child(handle);
        state.handle = handle;

        // --- close button (top-right) ---
        const close = this._makeCircle('window-close-symbolic',
            'mission-ws-close');
        thumb.add_child(close);
        state.close = close;

        close.connectObject('clicked', () => this._onClose(thumb), this);

        // --- make the handle draggable to reorder the workspace ---
        handle._delegate = {
            isMissionWsReorder: true,
            sourceWorkspace: thumb.metaWorkspace,
            getDragActor: () => {
                const clone = new Clutter.Clone({
                    source: thumb,
                    reactive: false,
                    opacity: 200,
                });
                clone.set_size(thumb.width, thumb.height);
                return clone;
            },
            getDragActorSource: () => thumb,
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

        // Keep everything above the window clones / indicator.
        thumb.set_child_above_sibling(handle, null);
        thumb.set_child_above_sibling(close, null);

        // Reposition on resize (thumbnails rescale as workspaces are added),
        // and clean up automatically when the shell destroys the thumbnail.
        const reposition = () => this._positionCircles(thumb);
        thumb.connectObject(
            'notify::width', reposition,
            'notify::height', reposition,
            'destroy', () => this._undecorate(thumb),
            this);
        reposition();

        this._decorated.add(thumb);
    }

    // --- drop-target highlight, called from the ThumbnailsBox injections ---

    setDropTarget(box, index) {
        this.clearAllDropTargets();
        const thumb = box._thumbnails?.[index];
        if (thumb) {
            thumb.add_style_class_name(DROP_TARGET_CLASS);
            this._dropTargets.add(thumb);
        }
    }

    clearAllDropTargets() {
        for (const thumb of this._dropTargets)
            thumb.remove_style_class_name?.(DROP_TARGET_CLASS);
        this._dropTargets.clear();
    }

    // --- internals ---

    _makeCircle(iconName, styleClass) {
        const button = new St.Button({
            style_class: `mission-ws-circle ${styleClass}`,
            reactive: true,
            can_focus: false,
            track_hover: true,
            child: new St.Icon({icon_name: iconName, icon_size: 12}),
        });
        button.set_size(BUTTON_SIZE, BUTTON_SIZE);
        button.opacity = 0;
        button.visible = false;
        return button;
    }

    _positionCircles(thumb) {
        const state = thumb._missionWs;
        if (!state)
            return;
        const r = BUTTON_SIZE / 2;
        const w = thumb.width;
        // Centre each circle exactly on the top corner (overhanging by r).
        state.handle.set_position(-r, -r);
        state.close.set_position(w - r, -r);
    }

    /**
     * Pick the single thumbnail whose controls should be visible this tick and
     * hide every other one. Precedence:
     *   1. a thumbnail being dragged keeps its own controls,
     *   2. else a *visible* button under the pointer wins — so a button that
     *      overhangs a neighbour still shows only its own thumbnail's controls,
     *   3. else the preview directly under the pointer.
     */
    _updateHover() {
        if (this._decorated.size === 0)
            return;
        const [px, py] = global.get_pointer();

        let active = null;
        for (const thumb of this._decorated) {
            if (thumb._missionWs?.dragging) {
                active = thumb;
                break;
            }
        }
        if (!active) {
            for (const thumb of this._decorated) {
                if (this._pointerOnButtons(thumb, px, py)) {
                    active = thumb;
                    break;
                }
            }
        }
        if (!active) {
            for (const thumb of this._decorated) {
                if (this._pointerOnPreview(thumb, px, py)) {
                    active = thumb;
                    break;
                }
            }
        }

        for (const thumb of this._decorated) {
            if (thumb === active)
                this._show(thumb);
            else
                this._hide(thumb);
        }

        // Raise the one active thumbnail above all its siblings (neighbours
        // *and* the active-workspace indicator), so both overhanging circles
        // render on top of everything. Only one is ever raised, and thumbnails
        // don't otherwise overlap, so this has no other visual effect.
        if (active)
            active.get_parent()?.set_child_above_sibling(active, null);
    }

    /**
     * Pointer directly over the preview. Sides/bottom are tight so a neighbour
     * never lights up; only the top is extended (by the button radius plus a
     * little) so moving up onto the overhanging circles keeps them shown.
     */
    _pointerOnPreview(thumb, px, py) {
        const [tx, ty] = thumb.get_transformed_position();
        const [tw, th] = thumb.get_transformed_size();
        if (!Number.isFinite(tx) || tw <= 0)
            return false;
        const topExtra = BUTTON_SIZE / 2 + HOVER_EXTRA;
        return px >= tx && px <= tx + tw &&
               py >= ty - topExtra && py <= ty + th;
    }

    /** Pointer over one of this thumbnail's own currently-visible circles. */
    _pointerOnButtons(thumb, px, py) {
        const state = thumb._missionWs;
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

    _show(thumb) {
        const state = thumb._missionWs;
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

    _hide(thumb) {
        const state = thumb._missionWs;
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

    _onClose(thumb) {
        const wm = global.workspace_manager;
        if (wm.get_n_workspaces() <= 1)
            return; // never remove the last workspace
        const ws = thumb.metaWorkspace;
        if (ws)
            wm.remove_workspace(ws, global.get_current_time());
    }

    _undecorate(thumb) {
        const state = thumb._missionWs;
        if (!state)
            return;

        thumb.disconnectObject(this);
        state.draggable?.disconnectAll?.();

        // Restore native clipping and drop any highlight.
        thumb.clip_to_allocation = state.hadClip;
        thumb.remove_style_class_name?.(DROP_TARGET_CLASS);
        this._dropTargets.delete(thumb);

        state.handle?.destroy();
        state.close?.destroy();

        delete thumb._missionWs;
        this._decorated.delete(thumb);
    }
}
