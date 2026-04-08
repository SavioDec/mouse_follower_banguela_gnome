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

/**
 * Classe principal da extensão Banguela.
 * Atua como um daemon de interface gráfica responsável por instanciar um ator Clutter,
 * gerenciar seu ciclo de vida dentro do GNOME Shell e orquestrar uma Máquina de Estados Finitas (FSM)
 * que reage a eventos de hardware cursor por meio de cálculos cinemáticos e vetoriais bidimensionais.
 */
export default class BanguelaExtension extends Extension {
  /**
   * Inicializa o módulo e aloca recursos no subsistema gráfico do compositor (Mutter).
   * Estabelece as conexões de sinais globais, I/O e o loop principal de física.
   */
  enable() {
    // Inicialização explícita de referências na memória para prevenir acessos a ponteiros órfãos
    this._fullscreenSignalId = null;
    this._settingsChangedId = null;
    this._timeoutId = null;
    this._actor = null;

    // Flag de controle de renderização (culling)
    this._isHiddenByFullscreen = false;

    // Vetores bidimensionais de posicionamento global
    this._currentPos = { x: 0, y: 0 };

    // Memória do ponteiro (Cinemática)
    this._lastMousePos = { x: 0, y: 0 };

    // Relógio referencial para cálculo de DeltaTime inter-frames
    this._lastFrameTime = GLib.get_monotonic_time() / 1000000;

    // Configuração inicial da Máquina de Estados Finita (FSM)
    this._currentState = "sitting";
    this._stateStartTime = this._lastFrameTime;

    // Estado das transformações afins da matriz de renderização
    this._lastScaleX = 1;
    this._lastAngle = 0;

    // Dicionário de texturas (caching em RAM)
    this._gicons = {};

    /**
     * Tabela de roteamento de animações.
     * @typedef {Object} AnimProps
     * @property {string} prefix - Prefixo base do nome do arquivo no disco.
     * @property {number} fps - Taxa de quadros alvo da interpolação.
     * @property {number} frameCount - Quantidade total de assets que compõem o ciclo.
     */
    this.ANIMATION_DATA = {
      sitting: { prefix: "SENTADO", fps: 1, frameCount: 1 },
      getting_up: { prefix: "LEVANTANDO", fps: 24, frameCount: 13 },
      walking: { prefix: "BANGUELA", fps: 15, frameCount: 39 },
      flying: { prefix: "VOANDO", fps: 20, frameCount: 7 },
      sitting_down: { prefix: "SENTANDO", fps: 24, frameCount: 8 },
    };

    // Binding com as configurações de usuário via esquema dconf/GSettings
    this._settings = this.getSettings("org.gnome.shell.extensions.banguela");

    /**
     * Parâmetros de calibração física e limites topológicos.
     * Contém getters para garantir tempo de leitura (JIT) das chaves do GSettings.
     */
    this.CONFIG = {
      STOP_DISTANCE: 40,
      WAKE_DISTANCE: 60,
      FLY_DISTANCE: 250,
      STOP_VELOCITY: 50, // Cinemática: Threshold de velocidade do ponteiro (pixels/segundo) para assumir "repouso"
      TARGET_OFFSET: 30, // Geometria: Distância mínima (raio em pixels) para manter de distância absoluta do centro do cursor
      get WALK_SPEED() {
        // Multiplicador real de velocidade ajustado para cálculo baseado em DeltaTime (pixels/seg)
        return (this._s.get_double("walk-speed") || 2.0) * 150;
      },
      get FLY_SPEED() {
        return (this._s.get_double("fly-speed") || 5.0) * 150;
      },
      get PET_SIZE() {
        // Fallback de sanidade de 48px caso o schema retorne chaves vazias/nulas
        const size = this._s.get_int("pet-size");
        return size > 0 ? size : 48;
      },
      _s: this._settings,
    };

    // Alocação do nó no Scene Graph do GNOME
    this._actor = new St.Icon({
      style_class: "banguela-actor",
      icon_size: this.CONFIG.PET_SIZE,
      reactive: false, // Desativa captura de eventos de ponteiro no ator
    });

    // Reancora a matriz de transformação (escala/rotação) para o centro absoluto do plano (0.5, 0.5)
    this._actor.pivot_point = new Graphene.Point({ x: 0.5, y: 0.5 });

    // Injeção gráfica na interface principal (UI Group)
    Main.layoutManager.uiGroup.add_child(this._actor);
    this._actor.show(); // Força o mapeamento inicial pela GPU

    this._loadIcons();

    // Definição do ponto de "spawn" vetorial com proteção contra indefinição do layoutManager (Wayland boot)
    const monitor = Main.layoutManager.primaryMonitor ||
      Main.layoutManager.monitors[0] || {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
      };

    this._currentPos.x = monitor.x + monitor.width / 2;
    this._currentPos.y = monitor.y + monitor.height / 2;

    // Sincroniza ponteiro inicial para evitar "pulo" de velocidade no primeiro quadro
    const [startX, startY] = global.get_pointer();
    this._lastMousePos.x = startX;
    this._lastMousePos.y = startY;

    // Registro de callback global para supressão da extensão em mídias/jogos imersivos
    this._fullscreenSignalId = global.display.connect(
      "in-fullscreen-changed",
      this._onFullscreenChanged.bind(this),
    );

    // Main Game Loop: Delega a rotina iterativa para uma GSource independente da renderização do display
    // a fim de contornar a suspensão do frame clock do Clutter no Wayland.
    this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
      this._updateFrame();
      return GLib.SOURCE_CONTINUE;
    });

    // Registro de reatividade (Observer) às modificações da chave de tamanho do ator
    this._settingsChangedId = this._settings.connect(
      "changed::pet-size",
      () => {
        if (this._actor) this._actor.icon_size = this.CONFIG.PET_SIZE;
      },
    );
  }

  /**
   * Calcula o tempo absoluto de um ciclo de animação.
   * @param {string} state - Chave de roteamento em ANIMATION_DATA
   * @returns {number} Duração total em segundos.
   */
  _getAnimDuration(state) {
    const anim = this.ANIMATION_DATA[state];
    return anim.frameCount / anim.fps;
  }

  /**
   * Rotina de desmontagem (Tear-down).
   * Invoca o Garbage Collector de forma determinística removendo as fontes
   * da thread do GLib e destruindo referências C vinculadas ao GJS.
   */
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
      this._actor.destroy(); // Libera o nó do grafo
      this._actor = null;
    }

    this._settings = null;
    this._gicons = {}; // Esvazia o cache em memória RAM
  }

  /**
   * Handler invocado mediante alteração de janelas em tela cheia (Compositor Level).
   * Realiza a ocultação condicional (culling) do ator para preservar cycles de CPU.
   */
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

        // Recalibra as coordenadas pós-supressão somando um offset aleatório para evitar colisão imediata e teletransporte
        const [x, y] = global.get_pointer();
        const offsetX =
          (Math.random() > 0.5 ? 1 : -1) * (150 + Math.random() * 150);
        const offsetY =
          (Math.random() > 0.5 ? 1 : -1) * (150 + Math.random() * 150);

        this._currentPos.x = x + offsetX;
        this._currentPos.y = y + offsetY;

        // Zera cinemática no respawn
        this._lastMousePos.x = x;
        this._lastMousePos.y = y;

        // Force-feed FSM: Garante transição para movimento contínuo
        this._currentState = "flying";
        this._stateStartTime = GLib.get_monotonic_time() / 1000000;
      }
    }
  }

  /**
   * Rotina de leitura síncrona I/O.
   * Constrói objetos Gio.FileIcon e os mantém cacheados na propriedade de dicionário `_gicons`.
   */
  _loadIcons() {
    for (let state in this.ANIMATION_DATA) {
      this._gicons[state] = [];
      const anim = this.ANIMATION_DATA[state];
      const stateDir = this.dir.get_child("media").get_child(state);

      for (let i = 0; i < anim.frameCount; i++) {
        const fileName = `${anim.prefix}_${i.toString().padStart(4, "0")}.png`;
        const file = stateDir.get_child(fileName);

        // Sanity Check: Verifica disponibilidade estrutural no sistema de arquivos
        if (!file.query_exists(null)) {
          console.warn(
            `[Banguela Extension] ERRO CRÍTICO DE ASSET: Imagem não encontrada: ${file.get_path()}`,
          );
        }

        this._gicons[state].push(new Gio.FileIcon({ file }));
      }
    }
  }

  /**
   * Operação atômica de transição na Máquina de Estados Finita.
   * @param {string} newState - Chave identificadora do próximo estado.
   * @param {number} timestamp - Marcador de tempo atual (Monotonic Time).
   */
  _changeState(newState, timestamp) {
    if (this._currentState === newState) return;
    this._currentState = newState;
    this._stateStartTime = timestamp; // Reseta o relógio base para interpolação
  }

  /**
   * Pipeline de Processamento Principal (Physics and Rendering Loop).
   * Engloba: Atualização cinemática, Resolução de FSM e Mapeamento de Texturas na Matrix de Transformação.
   */
  _updateFrame() {
    if (this._isHiddenByFullscreen || !this._actor) return;

    // Obtém as coordenadas globais e o relógio monolítico do sistema operacional
    const [x, y] = global.get_pointer();
    const timestamp = GLib.get_monotonic_time() / 1000000;

    // Cálculo estrito de DeltaTime (Frame-Rate Independent Movement)
    const rawDeltaTime = timestamp - this._lastFrameTime;
    const deltaTime = Math.min(rawDeltaTime, 0.1); // Cap de 100ms
    this._lastFrameTime = timestamp;

    // --- MÓDULO CINEMÁTICO DO ALVO ---
    const mDx = x - this._lastMousePos.x;
    const mDy = y - this._lastMousePos.y;

    // Normalização cinemática: Extrai a velocidade real em pixels por segundo
    let mouseVelocity = 0;
    if (deltaTime > 0) {
      mouseVelocity = Math.sqrt(mDx * mDx + mDy * mDy) / deltaTime;
    }

    // Atualiza o cache do estado inercial do ponteiro
    this._lastMousePos.x = x;
    this._lastMousePos.y = y;
    // ------------------------------------

    // --- MÓDULO TOPOLÓGICO DO ATOR ---
    const dx = x - this._currentPos.x;
    const dy = y - this._currentPos.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Resolução da tolerância anti-jitter
    if (distance > 0.5) {
      // --- ROUTING DA MÁQUINA DE ESTADOS (FSM) ---

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
        // Transição de parada.
        if (
          distance <= this.CONFIG.STOP_DISTANCE &&
          mouseVelocity < this.CONFIG.STOP_VELOCITY
        ) {
          this._changeState("sitting_down", timestamp);
          this._lastAngle = 0;
        } else {
          const shouldFly = distance > this.CONFIG.FLY_DISTANCE;
          this._changeState(shouldFly ? "flying" : "walking", timestamp);

          // Cálculo do vetor velocidade escalar
          const speed =
            (shouldFly ? this.CONFIG.FLY_SPEED : this.CONFIG.WALK_SPEED) *
            deltaTime;

          // --- CORREÇÃO DE SOBREPOSIÇÃO VETORIAL ---
          // Impede que a integração da física empurre a âncora do ator diretamente
          // para o centro do cursor do mouse, subtraindo o TARGET_OFFSET.
          // O Math.max evita que um passo negativo empurre o ator para trás.
          const stepableDistance = Math.max(
            0,
            distance - this.CONFIG.TARGET_OFFSET,
          );
          const step = Math.min(speed, stepableDistance);

          // Se step > 0, o ator se aproxima; caso contrário, a física o mantém 'orbitando'
          if (step > 0) {
            this._currentPos.x += (dx / distance) * step;
            this._currentPos.y += (dy / distance) * step;
          }

          // Espelhamento lógico baseado na normal horizontal
          this._lastScaleX = dx < 0 ? 1 : -1;

          // Cálculo do Pitch vetorial utilizando tangente de arco (Math.atan2).
          this._lastAngle = Math.max(
            -35,
            Math.min(35, -Math.atan2(dy, Math.abs(dx)) * (180 / Math.PI)),
          );
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

    // --- PIPELINE DE RENDERIZAÇÃO E INTERPOLAÇÃO DE FRAMES ---

    const icons = this._gicons[this._currentState];

    if (icons && icons.length > 0) {
      const anim = this.ANIMATION_DATA[this._currentState];
      let idx = 0;

      if (anim.frameCount > 1) {
        idx = Math.floor((timestamp - this._stateStartTime) * anim.fps);

        idx =
          this._currentState === "getting_up" ||
          this._currentState === "sitting_down"
            ? Math.min(idx, anim.frameCount - 1)
            : idx % anim.frameCount;
      }

      if (this._actor.gicon !== icons[idx]) this._actor.gicon = icons[idx];
    }

    const offset = this.CONFIG.PET_SIZE / 2;

    this._actor.set_position(
      Math.floor(this._currentPos.x - offset),
      Math.floor(this._currentPos.y - offset),
    );

    this._actor.scale_x = this._lastScaleX;
    this._actor.rotation_angle_z = this._lastAngle;
  }
}
