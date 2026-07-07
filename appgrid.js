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
//
// All the shared lifecycle/hover/drag/teardown lives in WorkspaceDecoratorBase.
// This subclass only supplies the tile-specific pieces: BinLayout corner
// placement (alignment + translation), the larger buttons, the app-grid state
// gating and the per-tile drop-target highlight.

import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {WorkspaceDecoratorBase, DROP_TARGET_CLASS} from './decoratorBase.js';

const BUTTON_SIZE = 36;    // bigger than the strip's 22px, for the large tiles
const ICON_SIZE = 20;
const HOVER_EXTRA = 8;     // px of grace above the top edge (to reach circles)
const APP_GRID_STATE = 2;  // ControlsState.APP_GRID

export class WorkspaceTileDecorator extends WorkspaceDecoratorBase {
    constructor() {
        super();
        this._buttonSize = BUTTON_SIZE;
        this._hoverExtra = HOVER_EXTRA;
    }

    _addButtons(tile, state) {
        // Workspace uses a BinLayout for its own children, so buttons added here
        // are placed by alignment (the WorkspaceLayout that lays out window
        // clones lives on tile._container, not on `tile`); a translation then
        // pulls each circle half-way outside its corner.
        const r = BUTTON_SIZE / 2;
        const handle = this._makeButton('list-drag-handle-symbolic',
            'mission-ws-circle-large mission-ws-handle', ICON_SIZE, {
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.START,
                x_expand: true,
                y_expand: true,
            });
        handle.translation_x = -r;
        handle.translation_y = -BUTTON_SIZE / 2;

        const close = this._makeButton('window-close-symbolic',
            'mission-ws-circle-large mission-ws-close', ICON_SIZE, {
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.START,
                x_expand: true,
                y_expand: true,
            });
        close.translation_x = r;
        close.translation_y = -BUTTON_SIZE / 2;

        tile.add_child(handle);
        tile.add_child(close);
        state.handle = handle;
        state.close = close;
    }

    /**
     * Controls only show while the overview is in (or near) the APP_GRID state.
     * In the window-picker these same tiles are shown big and the thumbnail
     * strip handles reordering.
     */
    _shouldShowControls() {
        const controls = Main.overview._overview?.controls;
        const stateValue = controls?._stateAdjustment?.value ?? 0;
        return stateValue >= APP_GRID_STATE - 0.5;
    }

    // --- drop-target highlight, called from the Workspace injections ---

    setDropTarget(tile) {
        this.clearAllDropTargets();
        if (tile?._missionWs) {
            tile.add_style_class_name(DROP_TARGET_CLASS);
            this._dropTargets.add(tile);
        }
    }
}
