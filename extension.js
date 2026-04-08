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
 * Classe principal da extensão. Gerencia o ciclo de vida do ator gráfico,
 * a máquina de estados da animação e o rastreamento do hardware cursor.
 */
export default class BanguelaExtension extends Extension {
  /**
   * Ponto de entrada (Entrypoint) da extensão.
   * Aloca recursos de memória, inicializa as propriedades da FSM, constrói o Scene Graph
   * e aciona os listeners de sistema e loop de renderização.
   */
  enable() {
    // Inicialização de ponteiros nulos para controle seguro no ciclo de Garbage Collection
    this._fullscreenSignalId = null;
    this._settingsChangedId = null;
    this._timeoutId = null;
    this._actor = null;

    // Flag de supressão de renderização para poupar recursos
    this._isHiddenByFullscreen = false;

    // Estado inicial: posições vetoriais globais e FSM
    this._currentPos = { x: 0, y: 0 };
    this._currentState = "sitting";
    this._stateStartTime = GLib.get_monotonic_time() / 1000000; // Timestamp de alta precisão em segundos

    // Transformações de matriz aplicadas na engine (evita alocações desnecessárias por frame)
    this._lastScaleX = 1;
    this._lastAngle = 0;

    // Cache de texturas carregadas em RAM
    this._gicons = {};

    // Dicionário de definição estrutural das animações.
    // Mapeia prefixo de arquivo, taxa de FPS alvo e total de frames lógicos.
    this.ANIMATION_DATA = {
      sitting: { prefix: "SENTADO", fps: 1, frameCount: 1 },
      getting_up: { prefix: "LEVANTANDO", fps: 24, frameCount: 13 },
      walking: { prefix: "BANGUELA", fps: 15, frameCount: 39 },
      flying: { prefix: "VOANDO", fps: 20, frameCount: 7 },
      sitting_down: { prefix: "SENTANDO", fps: 24, frameCount: 8 },
    };

    this._settings = this.getSettings("org.gnome.shell.extensions.banguela");

    // Definição de parâmetros físicos e de tolerância.
    // Utiliza getters para garantir leitura reativa em tempo real do GSettings.
    this.CONFIG = {
      STOP_DISTANCE: 40, // Limiar para transição Em Movimento -> Parado
      WAKE_DISTANCE: 60, // Limiar para transição Parado -> Levantando
      FLY_DISTANCE: 250, // Limiar dinâmico para decidir entre Andar ou Voar
      get WALK_SPEED() {
        return this._s.get_double("walk-speed") || 2.0;
      },
      get FLY_SPEED() {
        return this._s.get_double("fly-speed") || 5.0;
      },
      get PET_SIZE() {
        // Validação de sanidade: previne instabilidade do Clutter causada por dimensões zero ou NaN
        const size = this._s.get_int("pet-size");
        return size > 0 ? size : 48;
      },
      _s: this._settings,
    };

    // Criação do Ator UI (nó do grafo de cena) que renderizará o pet
    this._actor = new St.Icon({
      style_class: "banguela-actor",
      icon_size: this.CONFIG.PET_SIZE,
      reactive: false, // Desabilita hit-testing (captura de cliques), pet será intangível
    });

    // Desloca a âncora de rotação e posicionamento para o centro geométrico exato (0.5 = 50%)
    this._actor.pivot_point = new Graphene.Point({ x: 0.5, y: 0.5 });

    // Injeção explícita na UI principal. show() aciona o pipeline de mapeamento na GPU.
    Main.layoutManager.uiGroup.add_child(this._actor);
    this._actor.show();

    // Popula _gicons carregando os assets do disco
    this._loadIcons();

    // Determina o centro lógico do monitor primário como ponto de 'spawn'
    // Implementa fallback robusto em caso do layoutManager não estar pronto no Wayland.
    const monitor = Main.layoutManager.primaryMonitor ||
      Main.layoutManager.monitors[0] || {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
      };
    this._currentPos.x = monitor.x + monitor.width / 2;
    this._currentPos.y = monitor.y + monitor.height / 2;

    // Assinatura global de eventos de gerenciamento de janelas (compositor)
    this._fullscreenSignalId = global.display.connect(
      "in-fullscreen-changed",
      this._onFullscreenChanged.bind(this),
    );

    // Motor do loop principal.
    // Justificativa arquitetural: É utilizado GLib.timeout_add (e não Clutter.Timeline) para
    // forçar a atualização a ~60Hz (16ms) ignorando o estado de 'sleep' do frame clock do Mutter
    // quando a tela estiver sem redesenhos ativos (inerente ao Wayland Hardware Cursor).
    this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
      this._updateFrame();
      return GLib.SOURCE_CONTINUE; // Instrui a GMainLoop a invocar este callback novamente
    });

    // Observer Pattern: Escuta mudanças na chave de configuração para atualizar a UI
    this._settingsChangedId = this._settings.connect(
      "changed::pet-size",
      () => {
        if (this._actor) this._actor.icon_size = this.CONFIG.PET_SIZE;
      },
    );
  }

  /**
   * Utilitário matemático para calcular o tempo total (em segundos) que uma animação deve durar.
   * @param {string} state - Identificador do estado/animação.
   * @returns {number} Duração total baseada na proporção Frames/FPS.
   */
  _getAnimDuration(state) {
    const anim = this.ANIMATION_DATA[state];
    return anim.frameCount / anim.fps;
  }

  /**
   * Ciclo de destruição da extensão.
   * Executa a limpeza da memória e liberação explícita de recursos C/C++ vinculados ao GJS.
   * É imperativo zerar as referências para permitir a ação do Garbage Collector.
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
      this._actor.destroy(); // Libera instâncias na engine Clutter
      this._actor = null;
    }

    this._settings = null;
    this._gicons = {};
  }

  /**
   * Handler de interrupção executado quando uma janela entra ou sai de tela cheia.
   * Garante que a extensão não polua o ambiente em cenários de foco imersivo (jogos, vídeos).
   */
  _onFullscreenChanged() {
    let isAnyFullscreen = false;
    const monitorsCount = Main.layoutManager.monitors.length;

    // Varredura de múltiplos monitores. Tratamento de sub-superfícies no Xwayland.
    for (let i = 0; i < monitorsCount; i++) {
      if (global.display.get_monitor_in_fullscreen(i)) {
        isAnyFullscreen = true;
        break;
      }
    }

    this._isHiddenByFullscreen = isAnyFullscreen;

    if (this._actor) {
      if (isAnyFullscreen) {
        this._actor.hide(); // Suspende renderização (culling)
      } else {
        this._actor.show();

        // Recalibra as coordenadas de 'respawn' adicionando um desvio/offset dinâmico.
        // Impede que o ator dê "teleporte" direto para cima do mouse na volta da suspensão.
        const [x, y] = global.get_pointer();
        const offsetX =
          (Math.random() > 0.5 ? 1 : -1) * (150 + Math.random() * 150);
        const offsetY =
          (Math.random() > 0.5 ? 1 : -1) * (150 + Math.random() * 150);

        this._currentPos.x = x + offsetX;
        this._currentPos.y = y + offsetY;

        // Force-feed FSM: Sobrescreve o estado para "flying" garantindo movimento contínuo no retorno
        this._currentState = "flying";
        this._stateStartTime = GLib.get_monotonic_time() / 1000000;
      }
    }
  }

  /**
   * Resolução de I/O de disco.
   * Mapeia os arrays de instâncias `Gio.FileIcon` que serão atribuídas ao Ator.
   */
  _loadIcons() {
    for (let state in this.ANIMATION_DATA) {
      this._gicons[state] = [];
      const anim = this.ANIMATION_DATA[state];
      const stateDir = this.dir.get_child("media").get_child(state);

      // Algoritmo de injeção assume formatação fixa com '0' padding (Ex: ARQUIVO_0001.png)
      for (let i = 0; i < anim.frameCount; i++) {
        const fileName = `${anim.prefix}_${i.toString().padStart(4, "0")}.png`;
        const file = stateDir.get_child(fileName);

        // Proteção contra falhas de I/O silenciosas na pipeline
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
   * Atualiza a Máquina de Estados Finita e marca o tempo real de início da transição.
   * @param {string} newState - Chave do próximo estado
   * @param {number} timestamp - Monotonic time na chamada de transição
   */
  _changeState(newState, timestamp) {
    if (this._currentState === newState) return;
    this._currentState = newState;
    this._stateStartTime = timestamp;
  }

  /**
   * Engine loop principal contendo a lógica física, matemática vetorial e resolução gráfica.
   * Disparado recursivamente via Glib.timeout.
   */
  _updateFrame() {
    if (this._isHiddenByFullscreen || !this._actor) return;

    // Captura global incondicional de hardware cursor
    const [x, y] = global.get_pointer();
    const timestamp = GLib.get_monotonic_time() / 1000000;

    // Componentes de Delta X e Y (Vetor direcional do ponto atual para o alvo)
    const dx = x - this._currentPos.x;
    const dy = y - this._currentPos.y;

    // Cálculo do comprimento do vetor utilizando Teorema de Pitágoras (Distância Euclidiana)
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Threshold de 0.5 implementado para suprimir trepidação (jitter) sub-pixel ao atingir o alvo
    if (distance > 0.5) {
      // === ROUTING DA MÁQUINA DE ESTADOS (FSM) ===

      if (
        this._currentState === "sitting" &&
        distance > this.CONFIG.WAKE_DISTANCE
      ) {
        // Trigger de despertar baseado no raio WAKE_DISTANCE
        this._changeState("getting_up", timestamp);
      } else if (this._currentState === "getting_up") {
        // Bloqueio condicional (Yield): Impede nova transição enquanto a animação atual não esgotar sua duração
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
        if (distance <= this.CONFIG.STOP_DISTANCE) {
          // Destino atingido, despacha estado de repouso e zera inclinações/forças aplicadas
          this._changeState("sitting_down", timestamp);
          this._lastAngle = 0;
        } else {
          // Lógica de perseguição vetorial: O ator está se deslocando.
          // Decide dinâmica de animação atrelada à distância.
          const shouldFly = distance > this.CONFIG.FLY_DISTANCE;
          this._changeState(shouldFly ? "flying" : "walking", timestamp);

          // Normaliza velocidade frame a frame ponderada pelo fator (0.16 simulando deltaTime)
          const speed =
            (shouldFly ? this.CONFIG.FLY_SPEED : this.CONFIG.WALK_SPEED) * 0.16;
          const step = Math.min(speed, distance); // Clamping para impedir o 'overshoot' (passar do ponto e ricochetear)

          // Integração de posição baseada no vetor normalizado multiplicada pela magnitude do passo
          this._currentPos.x += (dx / distance) * step;
          this._currentPos.y += (dy / distance) * step;

          // Espelhamento Horizontal (Flip): Altera a matriz scaleX nativa da interface (-1 vira a textura)
          this._lastScaleX = dx < 0 ? 1 : -1;

          // Rotação Trigonométrica: Calcula inclinação (Pitch) usando Arc Tangent.
          // É mantida clampada entre -35º e +35º usando limites rígidos Math.min/max para evitar loops mortais visuais.
          this._lastAngle = Math.max(
            -35,
            Math.min(35, -Math.atan2(dy, Math.abs(dx)) * (180 / Math.PI)),
          );
        }
      } else if (this._currentState === "sitting_down") {
        // Bloqueio condicional (Yield) final, encerra o ciclo retornando ao repouso inicial
        if (
          timestamp >=
          this._stateStartTime + this._getAnimDuration("sitting_down")
        ) {
          this._changeState("sitting", timestamp);
        }
      }
    }

    // === SOLUÇÃO DE INTERPOLAÇÃO DE FRAMES (RENDER PIPELINE) ===

    const icons = this._gicons[this._currentState];

    if (icons && icons.length > 0) {
      const anim = this.ANIMATION_DATA[this._currentState];
      let idx = 0;

      if (anim.frameCount > 1) {
        // Cálculo do índice do frame atual dependente do tempo elapsed (Time-based animation) ao invés de ticks isolados
        idx = Math.floor((timestamp - this._stateStartTime) * anim.fps);

        // Lógica de Limite (Clamp) ou de Ciclo Ininterrupto (Modulo %) dependendo do tipo da FSM atual
        idx =
          this._currentState === "getting_up" ||
          this._currentState === "sitting_down"
            ? Math.min(idx, anim.frameCount - 1) // Trava no último frame
            : idx % anim.frameCount; // Loop infinito
      }

      // Aplicação otimizada: Apenas invoca a reescrita no Clutter se a propriedade GIcon de fato alterou
      if (this._actor.gicon !== icons[idx]) this._actor.gicon = icons[idx];
    }

    // Projeta coordenadas aplicando a correção de centro geométrico (Anchor Offsetting)
    const offset = this.CONFIG.PET_SIZE / 2;

    // Math.floor na aplicação do Clutter previne artefatos sub-pixel e recálculos custosos no sub-system gráfico
    this._actor.set_position(
      Math.floor(this._currentPos.x - offset),
      Math.floor(this._currentPos.y - offset),
    );

    // Commit final das transformações atômicas na matrix C++ do GNOME Shell
    this._actor.scale_x = this._lastScaleX;
    this._actor.rotation_angle_z = this._lastAngle;
  }
}
