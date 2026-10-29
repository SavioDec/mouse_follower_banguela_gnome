/**
 * Banguela Mouse Follower
 * Copyright (c) 2026 Sávio Mariguela Decaro
 * Licensed under the MIT License (see LICENSE file for details)
 */

import Clutter from "gi://Clutter";
import Graphene from "gi://Graphene";
import GLib from "gi://GLib";
import St from "gi://St";
import Gio from "gi://Gio";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

export default class BanguelaExtension extends Extension {
  enable() {
    this._fullscreenSignalId = null;
    this._settingsChangedId = null;
    this._timeoutId = null;
    this._actor = null;

    this._isHiddenByFullscreen = false;

    this._currentPos = { x: 0, y: 0 };
    this._lastMousePos = { x: 0, y: 0 };

    this._lastFrameTime = GLib.get_monotonic_time() / 1000000;

    this._currentState = "sitting";
    this._stateStartTime = this._lastFrameTime;

    this._lastScaleX = 1;
    this._lastDirX = 1;
    this._lastAngle = 0;
    this._targetAngle = 0;
    
    this._gicons = {};

    this.ANIMATION_DATA = {
      sitting: { prefix: "SENTADINHO", fps: 7, frameCount: 33 },
      getting_up: { prefix: "LEVANTANDO", fps: 24, frameCount: 13 },
      walking: { prefix: "BANGUELA", fps: 15, frameCount: 21 },
      flying: { prefix: "VOANDO", fps: 13, frameCount: 6 },
      sitting_down: { prefix: "SENTANDO", fps: 24, frameCount: 8 },
    };

    this._settings = this.getSettings("org.gnome.shell.extensions.banguela");

    this.CONFIG = {
      STOP_DISTANCE: 40,
      WAKE_DISTANCE: 60,
      FLY_DISTANCE: 250,
      STOP_VELOCITY: 50,
      TARGET_OFFSET: 30,
      TYPING_FADE_SECONDS: 1.5,
      ACTIVE_INTERVAL_MS: 16,
      SITTING_INTERVAL_MS: 66,
      HIDDEN_INTERVAL_MS: 250,
      WALK_SPEED: 300,
      FLY_SPEED: 750,
      FLY_DYNAMIC: true,
      FLY_FULL_SPEED_DISTANCE: 900,
      PET_SIZE: 48,
      HOVER_OPACITY: 255,
    };
    this._refreshConfig();

    this._actor = new St.Icon({
      style_class: "banguela-actor",
      icon_size: this.CONFIG.PET_SIZE,
      reactive: false,
    });

    this._actor.pivot_point = new Graphene.Point({ x: 0.5, y: 0.5 });

    Main.layoutManager.uiGroup.add_child(this._actor);
    this._actor.show();

    this._loadIcons();

    const monitor = Main.layoutManager.primaryMonitor ||
      Main.layoutManager.monitors[0] || { x: 0, y: 0, width: 1920, height: 1080 };

    this._currentPos.x = monitor.x + monitor.width / 2;
    this._currentPos.y = monitor.y + monitor.height / 2;

    const [startX, startY] = global.get_pointer();
    this._lastMousePos.x = startX;
    this._lastMousePos.y = startY;

    this._fullscreenSignalId = global.display.connect(
      "in-fullscreen-changed",
      this._onFullscreenChanged.bind(this),
    );

    this._idleMonitor = global.backend.get_core_idle_monitor();
    this._lastKeyTime = -Infinity;
    this._keyCandidate = false;

    this._lastApplied = { x: NaN, y: NaN, scaleX: NaN, angle: NaN };
    this._targetOpacity = 255;
    this._loopMs = 0;

    this._startLoop(this.CONFIG.ACTIVE_INTERVAL_MS);

    this._settingsChangedId = this._settings.connect("changed", (_s, key) => {
      this._refreshConfig();
      if (key === "pet-size" && this._actor) {
        this._actor.icon_size = this.CONFIG.PET_SIZE;
      }
    });
  }

  _refreshConfig() {
    const s = this._settings;
    const size = s.get_int("pet-size");
    const opacity = Math.min(1, Math.max(0, s.get_double("hover-opacity")));

    this.CONFIG.WALK_SPEED = (s.get_double("walk-speed") || 2.0) * 150;
    this.CONFIG.FLY_SPEED = (s.get_double("fly-speed") || 5.0) * 150;
    this.CONFIG.FLY_DYNAMIC = s.get_boolean("fly-dynamic-speed");
    this.CONFIG.FLY_FULL_SPEED_DISTANCE = Math.max(
      this.CONFIG.FLY_DISTANCE + 1,
      s.get_int("fly-full-speed-distance"),
    );
    this.CONFIG.PET_SIZE = size > 0 ? size : 48;
    this.CONFIG.HOVER_OPACITY = Math.floor(opacity * 255);
  }

  _startLoop(ms) {
    this._loopMs = ms;
    this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      const next = this._updateFrame();
      if (next === this._loopMs) return GLib.SOURCE_CONTINUE;
      this._startLoop(next);
      return GLib.SOURCE_REMOVE;
    });
  }

  _getAnimDuration(state) {
    const anim = this.ANIMATION_DATA[state];
    return anim.frameCount / anim.fps;
  }

  disable() {
    if (this._timeoutId) {
      GLib.source_remove(this._timeoutId);
      this._timeoutId = null;
    }

    if (this._fullscreenSignalId) {
      global.display.disconnect(this._fullscreenSignalId);
      this._fullscreenSignalId = null;
    }

    if (this._settings && this._settingsChangedId) {
      this._settings.disconnect(this._settingsChangedId);
      this._settingsChangedId = null;
    }

    if (this._actor) {
      this._actor.destroy();
      this._actor = null;
    }

    this._settings = null;
    this._idleMonitor = null;
    this._gicons = {};
  }

  _onFullscreenChanged() {
    let isAnyFullscreen = false;
    const monitorsCount = Main.layoutManager.monitors.length;

    for (let i = 0; i < monitorsCount; i++) {
      if (global.display.get_monitor_in_fullscreen(i)) {
        isAnyFullscreen = true;
        break;
      }
    }

    this._isHiddenByFullscreen = isAnyFullscreen;

    if (this._actor) {
      if (isAnyFullscreen) {
        this._actor.hide();
      } else {
        this._actor.show();

        const [x, y] = global.get_pointer();
        const offsetX = (Math.random() > 0.5 ? 1 : -1) * (150 + Math.random() * 150);
        const offsetY = (Math.random() > 0.5 ? 1 : -1) * (150 + Math.random() * 150);

        this._currentPos.x = x + offsetX;
        this._currentPos.y = y + offsetY;

        this._lastMousePos.x = x;
        this._lastMousePos.y = y;

        this._currentState = "flying";
        this._stateStartTime = GLib.get_monotonic_time() / 1000000;
      }
    }

    if (this._timeoutId) {
      GLib.source_remove(this._timeoutId);
      this._startLoop(this.CONFIG.ACTIVE_INTERVAL_MS);
    }
  }

  _loadIcons() {
    for (let state in this.ANIMATION_DATA) {
      this._gicons[state] = [];
      const anim = this.ANIMATION_DATA[state];
      const stateDir = this.dir.get_child("media").get_child(state);

      for (let i = 0; i < anim.frameCount; i++) {
        const fileName = `${anim.prefix}_${i.toString().padStart(4, "0")}.png`;
        const file = stateDir.get_child(fileName);

        if (!file.query_exists(null)) {
          console.warn(
            `[Banguela Extension] ERRO CRÍTICO DE ASSET: Imagem não encontrada: ${file.get_path()}`,
          );
        }

        this._gicons[state].push(new Gio.FileIcon({ file }));
      }
    }
  }

  _changeState(newState, timestamp) {
    if (this._currentState === newState) return;
    this._currentState = newState;
    this._stateStartTime = timestamp;
  }

  _lerp(start, end, factor) {
    return start + (end - start) * factor;
  }

  _updateFrame() {
    if (!this._actor) return this._loopMs;
    if (this._isHiddenByFullscreen) return this.CONFIG.HIDDEN_INTERVAL_MS;

    const [x, y] = global.get_pointer();
    const timestamp = GLib.get_monotonic_time() / 1000000;

    const rawDeltaTime = timestamp - this._lastFrameTime;
    const deltaTime = Math.min(rawDeltaTime, 0.1); 
    this._lastFrameTime = timestamp;

    const mDx = x - this._lastMousePos.x;
    const mDy = y - this._lastMousePos.y;

    let mouseVelocity = 0;
    if (deltaTime > 0) {
      mouseVelocity = Math.sqrt(mDx * mDx + mDy * mDy) / deltaTime;
    }

    this._lastMousePos.x = x;
    this._lastMousePos.y = y;

    const pointerStill = mDx === 0 && mDy === 0;
    if (pointerStill && this._keyCandidate) this._lastKeyTime = timestamp;
    this._keyCandidate =
      pointerStill && this._idleMonitor.get_idletime() < rawDeltaTime * 1000 + 10;

    const dx = x - this._currentPos.x;
    const dy = y - this._currentPos.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance > 0.5) {
      if (
        this._currentState === "sitting" &&
        distance > this.CONFIG.WAKE_DISTANCE
      ) {
        this._changeState("getting_up", timestamp);
      } else if (this._currentState === "getting_up") {
        if (
          timestamp >=
          this._stateStartTime + this._getAnimDuration("getting_up")
        ) {
          this._changeState(
            distance > this.CONFIG.FLY_DISTANCE ? "flying" : "walking",
            timestamp,
          );
        }
      } else if (
        this._currentState === "walking" ||
        this._currentState === "flying"
      ) {
        if (
          distance <= this.CONFIG.STOP_DISTANCE &&
          mouseVelocity < this.CONFIG.STOP_VELOCITY
        ) {
          this._changeState("sitting_down", timestamp);
          this._targetAngle = 0; 
        } else {
          const shouldFly = distance > this.CONFIG.FLY_DISTANCE;
          this._changeState(shouldFly ? "flying" : "walking", timestamp);

          let pxPerSecond = this.CONFIG.WALK_SPEED;
          if (shouldFly && !this.CONFIG.FLY_DYNAMIC) {
            pxPerSecond = this.CONFIG.FLY_SPEED;
          } else if (shouldFly) {
            const minSpeed = Math.min(this.CONFIG.WALK_SPEED, this.CONFIG.FLY_SPEED);
            const t = Math.min(
              1,
              (distance - this.CONFIG.FLY_DISTANCE) /
                (this.CONFIG.FLY_FULL_SPEED_DISTANCE - this.CONFIG.FLY_DISTANCE),
            );
            pxPerSecond = minSpeed + (this.CONFIG.FLY_SPEED - minSpeed) * t;
          }
          const speed = pxPerSecond * deltaTime;

          const stepableDistance = Math.max(
            0,
            distance - this.CONFIG.TARGET_OFFSET,
          );
          const step = Math.min(speed, stepableDistance);

          if (step > 0) {
            this._currentPos.x += (dx / distance) * step;
            this._currentPos.y += (dy / distance) * step;
          }

          if (Math.abs(dx) > 10) {
            const currentDirX = dx < 0 ? 1 : -1;
            this._lastScaleX = currentDirX;

            if (currentDirX !== this._lastDirX) {
               this._lastAngle = 0;
               this._targetAngle = 0;
               this._lastDirX = currentDirX;
            } else {
               this._targetAngle = Math.max(
                 -35,
                 Math.min(35, -Math.atan2(dy, Math.abs(dx)) * (180 / Math.PI)),
               );
            }
          }
        }
      } else if (this._currentState === "sitting_down") {
        if (
          timestamp >=
          this._stateStartTime + this._getAnimDuration("sitting_down")
        ) {
          this._changeState("sitting", timestamp);
        }
      }
    }

    this._lastAngle = this._lerp(this._lastAngle, this._targetAngle, 10 * deltaTime);

    const icons = this._gicons[this._currentState];

    if (icons && icons.length > 0) {
      const anim = this.ANIMATION_DATA[this._currentState];
      let idx = 0;

      if (anim.frameCount > 1) {
        const elapsedTime = timestamp - this._stateStartTime;
        
        if (this._currentState === "getting_up" || this._currentState === "sitting_down") {
           idx = Math.floor(elapsedTime * anim.fps);
           idx = Math.min(idx, anim.frameCount - 1);
        } else {
           const totalFramesElapsed = Math.floor(elapsedTime * anim.fps);
           idx = totalFramesElapsed % anim.frameCount;
        }
      }

      if (this._actor.gicon !== icons[idx]) this._actor.gicon = icons[idx];
    }

    const hoverRadius = this.CONFIG.PET_SIZE / 2;
    const isHovering = distance * distance < hoverRadius * hoverRadius;
    const isTyping = timestamp - this._lastKeyTime < this.CONFIG.TYPING_FADE_SECONDS;

    let targetOpacity = 255;

    if (this._currentState === "flying" || this._currentState === "walking") {
      targetOpacity = 255;
    } else if (isHovering || isTyping) {
      targetOpacity = this.CONFIG.HOVER_OPACITY;
    } else if (this._currentState === "sitting") {
      if (timestamp - this._stateStartTime > 3.0) {
        targetOpacity = this.CONFIG.HOVER_OPACITY;
      }
    }

    if (this._targetOpacity !== targetOpacity) {
      this._targetOpacity = targetOpacity;
      this._actor.ease({
        opacity: targetOpacity,
        duration: 400,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });
    }

    const last = this._lastApplied;
    const offset = this.CONFIG.PET_SIZE / 2;
    const px = Math.floor(this._currentPos.x - offset);
    const py = Math.floor(this._currentPos.y - offset);

    if (px !== last.x || py !== last.y) {
      this._actor.set_position(px, py);
      last.x = px;
      last.y = py;
    }
    if (this._lastScaleX !== last.scaleX) {
      this._actor.scale_x = this._lastScaleX;
      last.scaleX = this._lastScaleX;
    }
    if (Math.abs(this._lastAngle - last.angle) > 0.01 || Number.isNaN(last.angle)) {
      this._actor.rotation_angle_z = this._lastAngle;
      last.angle = this._lastAngle;
    }

    const settled =
      this._currentState === "sitting" &&
      !isHovering &&
      mDx === 0 &&
      mDy === 0 &&
      Math.abs(this._lastAngle - this._targetAngle) < 0.05;

    return settled ? this.CONFIG.SITTING_INTERVAL_MS : this.CONFIG.ACTIVE_INTERVAL_MS;
  }
}
