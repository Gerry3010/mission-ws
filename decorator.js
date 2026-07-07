// SPDX-License-Identifier: MIT
//
// Decorates the native overview WorkspaceThumbnail actors (the thumbnail strip)
// with two circular, Mac-Mission-Control-style hover buttons:
//   * top-left  -> reorder handle (draggable; reorders the workspace)
//   * top-right -> close button   (removes the workspace)
//
// The circles are centred ON the thumbnail corners, so they overhang its edge.
// All the lifecycle, hover-poll, dragging and teardown live in
// WorkspaceDecoratorBase; this subclass only supplies the strip-specific button
// placement (absolute set_position, repositioned as the strip rescales) and the
// index-based drop-target highlight the ThumbnailsBox injections call into.

import {WorkspaceDecoratorBase, DROP_TARGET_CLASS} from './decoratorBase.js';

const BUTTON_SIZE = 22;   // circle diameter in px (radius = SIZE / 2)
const ICON_SIZE = 12;
const HOVER_EXTRA = 8;    // px of grace above the top edge (to reach the circles)

export class ThumbnailDecorator extends WorkspaceDecoratorBase {
    constructor() {
        super();
        this._buttonSize = BUTTON_SIZE;
        this._hoverExtra = HOVER_EXTRA;
    }

    _addButtons(thumb, state) {
        const handle = this._makeButton('list-drag-handle-symbolic',
            'mission-ws-handle', ICON_SIZE);
        const close = this._makeButton('window-close-symbolic',
            'mission-ws-close', ICON_SIZE);
        thumb.add_child(handle);
        thumb.add_child(close);
        state.handle = handle;
        state.close = close;
        this._positionCircles(thumb);
    }

    _connectExtra(thumb, _state) {
        // Reposition on resize (thumbnails rescale as workspaces are added).
        const reposition = () => this._positionCircles(thumb);
        thumb.connectObject(
            'notify::width', reposition,
            'notify::height', reposition,
            this);
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
     * Raise the one active thumbnail above all its siblings (neighbours *and*
     * the active-workspace indicator), so both overhanging circles render on
     * top of everything. Only one is ever raised, and thumbnails don't otherwise
     * overlap, so this has no other visual effect.
     */
    _onHoverResolved(active) {
        if (active)
            active.get_parent()?.set_child_above_sibling(active, null);
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
}
