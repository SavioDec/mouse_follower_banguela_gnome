import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

/**
 * BanguelaExtension - Um pet de desktop nativo para GNOME Shell.
 * Implementa uma Máquina de Estados Finita (FSM) para controle de animação e movimento.
 */
export default class BanguelaExtension extends Extension {
    
    enable() {
        // Inicialização de flags e IDs de controle
        this._timeoutId = null;
        this._fullscreenSignalId = null;
        this._actor = null;
        this._isHiddenByFullscreen = false;
        
        // Estado inicial do Pet no plano cartesiano
        this._currentPos = { x: 0, y: 0 };
        this._currentState = 'sitting';
        this._stateStartTime = 0;
        this._lastScaleX = 1; // Controla a inversão horizontal (espelhamento)
        this._lastAngle = 0;   // Controla a inclinação do voo
        
        this._gicons = {}; // Cache de referências de arquivos (GIcon)

        // Metadados de Animação: FPS e contagem de frames por estado
        this.ANIMATION_DATA = {
            'sitting':      { prefix: 'SENTADO',    fps: 1,  frameCount: 1 },  
            'getting_up':   { prefix: 'LEVANTANDO', fps: 24, frameCount: 13 },  
            'walking':      { prefix: 'BANGUELA',   fps: 15, frameCount: 39 }, 
            'flying':       { prefix: 'VOANDO',     fps: 20, frameCount: 7 }, 
            'sitting_down': { prefix: 'SENTANDO',   fps: 24, frameCount: 8 }   
        };

        // Interface com o banco de dados GSettings do sistema
        this._settings = this.getSettings('org.gnome.shell.extensions.banguela');

        // Objeto de configuração reativo
        this.CONFIG = {
            STOP_DISTANCE: 40, // Distância para o pet decidir sentar
            WAKE_DISTANCE: 60, // Distância para o pet decidir levantar
            FLY_DISTANCE: 250, // Gatilho para mudar de 'walking' para 'flying'
            get WALK_SPEED() { return this._s.get_double('walk-speed'); },
            get FLY_SPEED() { return this._s.get_double('fly-speed'); },
            get PET_SIZE() { return this._s.get_int('pet-size'); },
            _s: this._settings
        };

        // Instanciação do Widget via Shell Toolkit (St)
        this._actor = new St.Icon({
            style_class: 'banguela-actor',
            icon_size: this.CONFIG.PET_SIZE,
            reactive: false // Permite que cliques passem através do pet para janelas abaixo
        });
        
        // Define o centro do ícone como âncora para rotações e escalas
        this._actor.pivot_point = new Graphene.Point({ x: 0.5, y: 0.5 });
        Main.layoutManager.uiGroup.add_child(this._actor);

        this._loadIcons(); // Pré-carregamento de ponteiros de mídia

        // Posicionamento inicial (Centro do monitor principal)
        const monitor = Main.layoutManager.primaryMonitor;
        this._currentPos.x = monitor.x + (monitor.width / 2);
        this._currentPos.y = monitor.y + (monitor.height / 2);

        // Signal: Oculta o pet quando o monitor entra em tela cheia (ex: vídeos/jogos)
        this._fullscreenSignalId = global.display.connect('in-fullscreen-changed', this._onFullscreenChanged.bind(this));
        
        // Timestamp inicial em segundos (Precisão de microssegundos convertida)
        this._stateStartTime = GLib.get_monotonic_time() / 1000000;
        
        // Game Loop: Roda a cada 16ms (~60 FPS)
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => this._updateFrame());

        // Listener para atualização de tamanho em tempo real via menu de preferências
        this._settings.connect('changed::pet-size', () => {
            if (this._actor) this._actor.icon_size = this.CONFIG.PET_SIZE;
        });
    }

    /**
     * Calcula a duração de uma animação específica em segundos.
     */
    _getAnimDuration(state) {
        const anim = this.ANIMATION_DATA[state];
        return anim.frameCount / anim.fps;
    }

    disable() {
        // Limpeza de recursos (Essencial para evitar Memory Leaks e crashes no Shell)
        if (this._timeoutId) GLib.source_remove(this._timeoutId);
        if (this._fullscreenSignalId) global.display.disconnect(this._fullscreenSignalId);
        if (this._actor) this._actor.destroy(); // Remove o pet da memória de vídeo
        this._settings = null;
        this._gicons = {};
    }

    _onFullscreenChanged() {
        const monitorIndex = Main.layoutManager.findMonitorIndexForActor(this._actor);
        const isFullscreen = global.display.get_monitor_in_fullscreen(monitorIndex);
        this._isHiddenByFullscreen = isFullscreen;
        if (this._actor) isFullscreen ? this._actor.hide() : this._actor.show();
    }

    _loadIcons() {
        // Mapeia os arquivos de imagem para objetos Gio.FileIcon (abstração de baixo nível)
        for (let state in this.ANIMATION_DATA) {
            this._gicons[state] = [];
            const anim = this.ANIMATION_DATA[state];
            const stateDir = this.dir.get_child('media').get_child(state);
            for (let i = 0; i < anim.frameCount; i++) {
                const file = stateDir.get_child(`${anim.prefix}_${i.toString().padStart(4, '0')}.png`);
                this._gicons[state].push(new Gio.FileIcon({ file }));
            }
        }
    }

    _changeState(newState, timestamp) {
        if (this._currentState === newState) return;
        this._currentState = newState;
        this._stateStartTime = timestamp; 
    }

    _updateFrame() {
        if (this._isHiddenByFullscreen) return GLib.SOURCE_CONTINUE;

        const [x, y] = global.get_pointer(); // Captura coordenadas X,Y do mouse
        const timestamp = GLib.get_monotonic_time() / 1000000;

        // Vetores de distância
        const dx = x - this._currentPos.x;
        const dy = y - this._currentPos.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        // Guard Clause: Evita divisão por zero e processamento desnecessário se parado
        if (distance > 0.5) {
            
            // --- Lógica da Máquina de Estados (FSM) ---
            if (this._currentState === 'sitting' && distance > this.CONFIG.WAKE_DISTANCE) {
                this._changeState('getting_up', timestamp);
            } 
            else if (this._currentState === 'getting_up') {
                // Bloqueia movimentação até concluir a animação de levantar
                if (timestamp >= (this._stateStartTime + this._getAnimDuration('getting_up'))) {
                    this._changeState(distance > this.CONFIG.FLY_DISTANCE ? 'flying' : 'walking', timestamp);
                }
            } 
            else if (this._currentState === 'walking' || this._currentState === 'flying') {
                if (distance <= this.CONFIG.STOP_DISTANCE) {
                    this._changeState('sitting_down', timestamp);
                    this._lastAngle = 0; // Reseta inclinação ao parar
                } else {
                    const shouldFly = distance > this.CONFIG.FLY_DISTANCE;
                    this._changeState(shouldFly ? 'flying' : 'walking', timestamp);
                    
                    // Cálculo de interpolação linear (Movimento)
                    const speed = (shouldFly ? this.CONFIG.FLY_SPEED : this.CONFIG.WALK_SPEED) * 0.16;
                    const step = Math.min(speed, distance);
                    
                    this._currentPos.x += (dx / distance) * step;
                    this._currentPos.y += (dy / distance) * step;
                    
                    // Lógica Visual: Inversão horizontal baseada na direção X
                    this._lastScaleX = dx < 0 ? 1 : -1;
                    
                    // Cálculo de inclinação (Pitch): arco-tangente entre os eixos
                    this._lastAngle = Math.max(-35, Math.min(35, -Math.atan2(dy, Math.abs(dx)) * (180 / Math.PI)));
                }
            } 
            else if (this._currentState === 'sitting_down') {
                // Bloqueia transição até o pet terminar de sentar
                if (timestamp >= (this._stateStartTime + this._getAnimDuration('sitting_down'))) {
                    this._changeState('sitting', timestamp);
                }
            }
        }

        // --- Renderização do Frame Atual ---
        const icons = this._gicons[this._currentState];
        if (icons && icons.length > 0) {
            const anim = this.ANIMATION_DATA[this._currentState];
            let idx = 0;
            if (anim.frameCount > 1) {
                // Calcula qual frame exibir com base no tempo transcorrido e FPS
                idx = Math.floor((timestamp - this._stateStartTime) * anim.fps);
                
                // Transições não fazem loop, animações contínuas sim
                idx = (this._currentState === 'getting_up' || this._currentState === 'sitting_down') 
                    ? Math.min(idx, anim.frameCount - 1) 
                    : idx % anim.frameCount;
            }
            // Só atualiza a propriedade gicon se o frame mudou (otimização de render)
            if (this._actor.gicon !== icons[idx]) this._actor.gicon = icons[idx];
        }

        // Aplicação das transformações espaciais no Ator (Widget)
        const offset = this.CONFIG.PET_SIZE / 2;
        this._actor.set_position(Math.floor(this._currentPos.x - offset), Math.floor(this._currentPos.y - offset));
        this._actor.scale_x = this._lastScaleX;
        this._actor.rotation_angle_z = this._lastAngle;

        return GLib.SOURCE_CONTINUE; // Mantém o loop ativo
    }
}