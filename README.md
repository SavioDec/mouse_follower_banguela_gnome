# 🐉 Banguela Mouse Follower

**Banguela Mouse Follower** é uma extensão nativa para o ecossistema **GNOME Shell (45 a 50)**, desenvolvida para atuar como um "desktop pet" que interage dinamicamente com o ponteiro do mouse. O projeto utiliza uma arquitetura baseada em eventos, processamento cinemático em tempo real e uma Máquina de Estados Finitos (FSM) para orquestrar comportamentos complexos.

---

## 1. Visão Geral do Sistema
A extensão integra-se diretamente ao compositor **Mutter** via **GJS (GNOME JavaScript)**. A renderização é processada através do toolkit **St (Shell Toolkit)**, aproveitando o hardware gráfico via **Clutter** para garantir transformações espaciais fluidas (escala, rotação e opacidade) sem sobrecarregar a CPU.

## 2. Arquitetura de Software

### A. Máquina de Estados Finita (FSM)
O comportamento do agente é modelado por uma FSM, garantindo transições de estado previsíveis e síncronas com as animações:

* **`sitting`**: Estado de repouso (IDLE). Entra em modo de economia de energia/transparência após 3 segundos de inatividade.
* **`getting_up`**: Transição bloqueante de animação para início de movimento.
* **`walking`**: Deslocamento vetorial de baixa velocidade para distâncias curtas.
* **`flying`**: Deslocamento vetorial de alta velocidade, ativo para grandes deltas de distância.
* **`sitting_down`**: Transição bloqueante de retorno ao repouso.

### B. Ciclo de Vida (Lifecycle)
O sistema implementa o protocolo da classe `Extension`:
1.  **`enable()`**: Alocação do ator, carregamento de `GSettings`, pré-cache de `GIcons` e inicialização do loop de alta prioridade (~60 FPS) via `GLib.timeout_add`.
2.  **`disable()`**: Desalocação manual de atores Clutter, desconexão de sinais e limpeza de cache para prevenir *memory leaks*.

---

## 3. Dinâmica de Movimento e Efeitos Visuais

### Cinemática e Rotação
A movimentação utiliza cálculos vetoriais para determinar a trajetória ideal. Além da translação, o sistema aplica:
* **Flipping Horizontal**: Inversão do eixo X baseada na direção do movimento.
* **Inclinação Dinâmica (Pitch)**: Rotação suave no eixo Z (entre -35° e 35°) calculada via `atan2`, simulando a inclinação do voo/caminhada.
* **Interpolação (LERP)**: As transições de ângulo e posição são suavizadas para evitar "jittering" visual.

### Opacidade Inteligente (Hover & Idle)
O sistema monitora a distância entre o cursor e o pet para gerenciar a oclusão da interface:
* **Detecção de Proximidade**: O pet torna-se translúcido automaticamente quando o mouse está sobre ele, garantindo que não obstrua elementos clicáveis.
* **Auto-Hide Idle**: Se o pet permanecer no estado `sitting` por mais de 3 segundos, ele suaviza sua opacidade para reduzir a distração visual.
* **Configuração**: A opacidade alvo é totalmente customizável via preferências.

---

## 4. Componentes Principais

### 🛠️ `extension.js`
* **Detecção de Fullscreen**: Suspende o processamento e oculta o ator quando aplicações em tela cheia são detectadas, otimizando o consumo de recursos.
* **Renderização de Frames**: Utiliza mutação de propriedade `gicon` sobre um único ator `St.Icon`. Essa abordagem minimiza o *layout thrashing* e otimiza o uso de VRAM.

### ⚙️ `prefs.js`
* **Stack Tecnológica**: Baseada em **Libadwaita** e **GTK4**.
* **Sincronização**: Utiliza `settings.bind` para persistência em tempo real das configurações de velocidade, tamanho e transparência.

---

## 5. Especificações de Animação (`ANIMATION_DATA`)

| Estado | FPS | Frame Count | Comportamento |
| :--- | :---: | :---: | :--- |
| **Sitting** | 7 | 33 | Loop de respiração / Repouso |
| **Getting Up** | 24 | 13 | Transição Bloqueante (Início) |
| **Walking** | 15 | 21 | Loop de caminhada cíclica |
| **Flying** | 13 | 6 | Loop de voo cíclico |
| **Sitting Down** | 24 | 8 | Transição Bloqueante (Fim) |

---

## 6. Configuração e GSettings
O esquema de dados (`gschema.xml`) permite o ajuste fino da experiência:
* `walk-speed`: Multiplicador de velocidade para caminhada.
* `fly-speed`: Multiplicador de velocidade para voo.
* `pet-size`: Escala do personagem em pixels.
* `hover-opacity`: Nível de transparência (0.0 a 1.0) para estados de hover/idle.