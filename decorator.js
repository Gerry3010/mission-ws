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

const BUTTON_SIZE = 22;   // circle diameter in px (radius = SIZE / 2)
const HOVER_EXTRA = 8;    // px added *beyond* the radius before circles hide
const FADE_TIME = 120;    // ms fade in/out
const POLL_INTERVAL = 120; // ms pointer poll while a thumbnail is shown

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
    }

    destroy() {
        for (const thumb of [...this._decorated])
            this._undecorate(thumb);
        this._decorated.clear();
        this.clearAllDropTargets();
    }

    /** Idempotently add the hover circles + drag handle to a thumbnail. */
    decorateThumbnail(thumb) {
        if (!thumb || thumb._missionWs)
            return;

        const state = {
            shown: false,
            dragging: false,
            pollId: 0,
            signalIds: [],
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

        close.connect('clicked', () => this._onClose(thumb));

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

        // Reposition on resize (thumbnails rescale as workspaces are added).
        const reposition = () => this._positionCircles(thumb);
        state.signalIds.push(thumb.connect('notify::width', reposition));
        state.signalIds.push(thumb.connect('notify::height', reposition));
        reposition();

        // Clean up automatically when the shell destroys the thumbnail.
        thumb.connect('destroy', () => this._undecorate(thumb));

        // Drive show/hide by polling the pointer against the expanded rect.
        // Robust against crossing-event quirks with the window clones on top.
        state.pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_INTERVAL,
            () => {
                if (!thumb._missionWs)
                    return GLib.SOURCE_REMOVE;
                if (state.dragging || this._pointerInside(thumb))
                    this._show(thumb);
                else
                    this._hide(thumb);
                return GLib.SOURCE_CONTINUE;
            });

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

    _pointerInside(thumb) {
        const [px, py] = global.get_pointer();
        const [tx, ty] = thumb.get_transformed_position();
        const [tw, th] = thumb.get_transformed_size();
        if (!Number.isFinite(tx) || tw <= 0)
            return false;
        const m = BUTTON_SIZE / 2 + HOVER_EXTRA;
        return px >= tx - m && px <= tx + tw + m &&
               py >= ty - m && py <= ty + th + m;
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

        if (state.pollId)
            GLib.source_remove(state.pollId);
        for (const id of state.signalIds)
            thumb.disconnect(id);
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
