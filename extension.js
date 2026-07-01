// SPDX-License-Identifier: MIT
//
// Mission WS — reorder GNOME workspaces by drag & drop from the overview
// thumbnail strip, with Mac-Mission-Control-style hover circles.
//
// Strategy: patch the native ThumbnailsBox (workspaceThumbnail.js) via
// InjectionManager instead of building a separate popup, so we reuse the
// shell's live workspace previews and layout.

import {Extension, InjectionManager}
    from 'resource:///org/gnome/shell/extensions/extension.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import {ThumbnailsBox} from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';

import {ThumbnailDecorator} from './decorator.js';

export default class MissionWsExtension extends Extension {
    enable() {
        this._decorator = new ThumbnailDecorator();
        this._injections = new InjectionManager();
        const decorator = this._decorator;

        // Decorate every thumbnail the box (re)builds. addThumbnails() is the
        // single choke-point for both the initial fill and later additions.
        this._injections.overrideMethod(ThumbnailsBox.prototype, 'addThumbnails',
            originalMethod => function (...args) {
                originalMethod.apply(this, args);
                for (const thumb of this._thumbnails)
                    decorator.decorateThumbnail(thumb);
            });

        // Teach the box's drag-target interface about our reorder drags.
        this._injections.overrideMethod(ThumbnailsBox.prototype, 'handleDragOver',
            originalMethod => function (source, actor, x, y, time) {
                if (source?.isMissionWsReorder) {
                    const index = missionWsTargetIndex(this._thumbnails, x);
                    this._missionWsDrop = index;
                    decorator.setDropTarget(this, index);
                    return index >= 0
                        ? DND.DragMotionResult.MOVE_DROP
                        : DND.DragMotionResult.CONTINUE;
                }
                return originalMethod.call(this, source, actor, x, y, time);
            });

        this._injections.overrideMethod(ThumbnailsBox.prototype, 'acceptDrop',
            originalMethod => function (source, actor, x, y, time) {
                if (source?.isMissionWsReorder) {
                    const index = missionWsTargetIndex(this._thumbnails, x);
                    decorator.clearAllDropTargets();
                    if (index >= 0 && source.sourceWorkspace) {
                        global.workspace_manager.reorder_workspace(
                            source.sourceWorkspace, index);
                    }
                    return true;
                }
                return originalMethod.call(this, source, actor, x, y, time);
            });
    }

    disable() {
        this._injections?.clear();
        this._injections = null;
        this._decorator?.destroy();
        this._decorator = null;
    }
}

/**
 * Nearest thumbnail (by horizontal centre) to the box-local x coordinate.
 * Always returns a valid slot when thumbnails exist, so dropping in the gap
 * between two previews still reorders to the closest one.
 *
 * @param {object[]} thumbnails ThumbnailsBox._thumbnails
 * @param {number} x box-local pointer x
 * @returns {number} target workspace index, or -1 if there are none
 */
function missionWsTargetIndex(thumbnails, x) {
    let index = -1;
    let best = Infinity;
    thumbnails.forEach((thumb, i) => {
        const centre = thumb.x + thumb.width / 2;
        const dist = Math.abs(x - centre);
        if (dist < best) {
            best = dist;
            index = i;
        }
    });
    return index;
}
