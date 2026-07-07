// SPDX-License-Identifier: MIT
//
// Shared base for the two workspace-preview decorators:
//   * ThumbnailDecorator      (decorator.js) — the overview thumbnail strip
//   * WorkspaceTileDecorator  (appgrid.js)   — the app-grid ("Launchpad") tiles
//
// Both add the same pair of Mac-Mission-Control-style hover circles — a
// top-left reorder handle (draggable) and a top-right close button — to a
// workspace preview actor, drive show/hide from one shared pointer poll, and
// tear everything down identically. This base owns all of that. Subclasses only
// supply what genuinely differs between a strip thumbnail and an app-grid tile:
//   * button geometry / placement  -> _addButtons()
//   * extra per-actor wiring        -> _connectExtra()   (e.g. reposition)
//   * whether controls are eligible -> _shouldShowControls()
//   * post-hover-resolution effect  -> _onHoverResolved()
//   * the drop-target highlight API -> setDropTarget()   (signature differs)
// plus a few instance fields (button size, hover grace) set in their ctor.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const FADE_TIME = 120;      // ms fade in/out
export const POLL_INTERVAL = 120;  // ms between pointer polls (one shared timer)
export const DROP_TARGET_CLASS = 'mission-ws-drop-target';

/**
 * Owns all per-actor decorations and their lifecycle for one preview surface.
 * One instance lives for the duration of the extension; the prototype
 * injections in extension.js call into decorate(), the drop-target helpers and
 * the accept path.
 */
export class WorkspaceDecoratorBase {
    constructor() {
        this._decorated = new Set();    // decorated preview actors
        this._dropTargets = new Set();  // actors currently highlighted
        this._pollId = 0;

        // Subclass overrides via instance fields (defaults are harmless).
        this._buttonSize = 22;   // circle diameter in px (radius = SIZE / 2)
        this._hoverExtra = 8;    // px of grace above the top edge

        // A single pointer poll drives show/hide for *all* actors (see
        // _updateHover). The previews only exist while the overview is up, so
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
        for (const actor of [...this._decorated])
            this._undecorate(actor);
        this._decorated.clear();
        this.clearAllDropTargets();
    }

    /**
     * Idempotently add the reorder handle + close circle to a preview actor and
     * wire up dragging, closing and teardown. Subclasses only place the buttons
     * (_addButtons) and add any extra per-actor wiring (_connectExtra).
     */
    decorate(actor) {
        if (!actor || actor._missionWs)
            return;

        const state = {shown: false, dragging: false};
        actor._missionWs = state;

        // The native preview clips its children; disable so the circles can
        // overhang the corners. Remember the previous value to restore later.
        state.hadClip = actor.clip_to_allocation;
        actor.clip_to_allocation = false;

        // Subclass creates + positions state.handle and state.close.
        this._addButtons(actor, state);

        state.close.connectObject('clicked', () => this._onClose(actor), this);

        // --- make the handle draggable to reorder the workspace ---
        state.handle._delegate = {
            isMissionWsReorder: true,
            sourceWorkspace: actor.metaWorkspace,
            getDragActor: () => {
                const clone = new Clutter.Clone({
                    source: actor,
                    reactive: false,
                    opacity: 200,
                });
                clone.set_size(actor.width, actor.height);
                return clone;
            },
            getDragActorSource: () => actor,
        };
        const draggable = DND.makeDraggable(state.handle, {dragActorOpacity: 200});
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

        // Keep both circles above the window clones / indicator.
        actor.set_child_above_sibling(state.handle, null);
        actor.set_child_above_sibling(state.close, null);

        // Clean up automatically when the shell destroys the actor; subclasses
        // add any extra wiring (e.g. reposition on resize) here.
        actor.connectObject('destroy', () => this._undecorate(actor), this);
        this._connectExtra(actor, state);

        this._decorated.add(actor);
    }

    clearAllDropTargets() {
        for (const actor of this._dropTargets)
            actor.remove_style_class_name?.(DROP_TARGET_CLASS);
        this._dropTargets.clear();
    }

    // --- hooks: overridden by subclasses (defaults suit the strip) ---

    /** Create, size, place and add state.handle + state.close onto `actor`. */
    _addButtons(_actor, _state) {
        throw new Error('WorkspaceDecoratorBase._addButtons must be overridden');
    }

    /** Extra per-actor signal wiring; default: nothing. */
    _connectExtra(_actor, _state) {}

    /** Whether the controls are eligible to show at all this tick. */
    _shouldShowControls() {
        return true;
    }

    /** Effect to run once the active actor has been picked; default: nothing. */
    _onHoverResolved(_active) {}

    // --- shared button factory ---

    _makeButton(iconName, styleClass, iconSize, props = {}) {
        const button = new St.Button({
            style_class: `mission-ws-circle ${styleClass}`,
            reactive: true,
            can_focus: false,
            track_hover: true,
            child: new St.Icon({icon_name: iconName, icon_size: iconSize}),
            ...props,
        });
        button.set_size(this._buttonSize, this._buttonSize);
        button.opacity = 0;
        button.visible = false;
        return button;
    }

    // --- pointer poll ---

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
        for (const actor of this._decorated)
            this._hide(actor);
    }

    /**
     * Pick the single actor whose controls should be visible this tick and hide
     * every other one. Precedence:
     *   1. an actor being dragged keeps its own controls,
     *   2. else a *visible* button under the pointer wins — so a button that
     *      overhangs a neighbour still shows only its own actor's controls,
     *   3. else the preview directly under the pointer.
     */
    _updateHover() {
        if (this._decorated.size === 0)
            return;
        if (!this._shouldShowControls()) {
            for (const actor of this._decorated)
                this._hide(actor);
            return;
        }

        const [px, py] = global.get_pointer();

        let active = null;
        for (const actor of this._decorated) {
            if (actor._missionWs?.dragging) {
                active = actor;
                break;
            }
        }
        if (!active) {
            for (const actor of this._decorated) {
                if (this._pointerOnButtons(actor, px, py)) {
                    active = actor;
                    break;
                }
            }
        }
        if (!active) {
            for (const actor of this._decorated) {
                if (this._pointerOnPreview(actor, px, py)) {
                    active = actor;
                    break;
                }
            }
        }

        for (const actor of this._decorated) {
            if (actor === active)
                this._show(actor);
            else
                this._hide(actor);
        }

        this._onHoverResolved(active);
    }

    /**
     * Pointer directly over the preview. Sides/bottom are tight so a neighbour
     * never lights up; only the top is extended (by the button radius plus a
     * little) so moving up onto the overhanging circles keeps them shown.
     */
    _pointerOnPreview(actor, px, py) {
        const [tx, ty] = actor.get_transformed_position();
        const [tw, th] = actor.get_transformed_size();
        if (!Number.isFinite(tx) || tw <= 0)
            return false;
        const topExtra = this._buttonSize / 2 + this._hoverExtra;
        return px >= tx && px <= tx + tw &&
               py >= ty - topExtra && py <= ty + th;
    }

    /** Pointer over one of this actor's own currently-visible circles. */
    _pointerOnButtons(actor, px, py) {
        const state = actor._missionWs;
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

    _show(actor) {
        const state = actor._missionWs;
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

    _hide(actor) {
        const state = actor._missionWs;
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

    _onClose(actor) {
        const wm = global.workspace_manager;
        if (wm.get_n_workspaces() <= 1)
            return; // never remove the last workspace
        const ws = actor.metaWorkspace;
        if (ws)
            wm.remove_workspace(ws, global.get_current_time());
    }

    _undecorate(actor) {
        const state = actor._missionWs;
        if (!state)
            return;

        actor.disconnectObject(this);
        state.draggable?.disconnectAll?.();

        // Restore native clipping and drop any highlight.
        actor.clip_to_allocation = state.hadClip;
        actor.remove_style_class_name?.(DROP_TARGET_CLASS);
        this._dropTargets.delete(actor);

        state.handle?.destroy();
        state.close?.destroy();

        delete actor._missionWs;
        this._decorated.delete(actor);
    }
}
