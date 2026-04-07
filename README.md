# 🐉 Banguela Mouse Follower

**Banguela Mouse Follower** é uma extensão nativa para o ecossistema **GNOME Shell (45+)**, desenvolvida para atuar como um "desktop pet" que interage dinamicamente com o ponteiro do mouse. O projeto foi concebido sob a perspectiva de sistemas de tempo real, utilizando uma arquitetura baseada em eventos e controle de estado.

---

## 1. Visão Geral do Sistema
A extensão integra-se diretamente ao compositor **Mutter** via **GJS (GNOME JavaScript)**. A renderização é processada através do toolkit **St (Shell Toolkit)**, aproveitando o hardware gráfico via **Clutter** para garantir transformações espaciais fluidas sem sobrecarregar a CPU.

## 2. Arquitetura de Software

### A. Máquina de Estados Finita (FSM)
O comportamento do agente é modelado por uma FSM, garantindo transições de estado previsíveis e síncronas com as animações:

* **`sitting`**: Estado de repouso (IDLE).
* **`getting_up`**: Transição bloqueante de animação para início de movimento.
* **`walking`**: Deslocamento vetorial de baixa velocidade para distâncias curtas.
* **`flying`**: Deslocamento vetorial de alta velocidade, ativo para grandes deltas de distância.
* **`sitting_down`**: Transição bloqueante de retorno ao repouso.

### B. Ciclo de Vida (Lifecycle)
O sistema implementa rigorosamente o protocolo da classe `Extension`:
1.  **`enable()`**: Alocação de memória para o ator, carregamento de `GSettings`, pré-cache de `GIcons` na VRAM e inicialização do loop de alta prioridade via `GLib.timeout_add`.
2.  **`disable()`**: Desalocação manual (Garbage Collection de baixo nível) de atores Clutter e desconexão de sinais de hardware para prevenir *memory leaks*.

---

## 3. Lógica de Movimentação e Física
A movimentação utiliza **Cálculo Vetorial** para determinar a trajetória ideal. A cada ciclo de ~16ms, o sistema calcula a distância Euclidiana ($d$) entre a posição atual ($P_{curr}$) e o alvo ($P_{target}$):

$$d = \sqrt{(x_{target} - x_{curr})^2 + (y_{target} - y_{curr})^2}$$

Se $d > 0.5$ px, o novo posicionamento é calculado normalizando o vetor de direção e aplicando a escalar de velocidade ($s$):

$$x_{next} = x_{curr} + \left(\frac{dx}{d}\right) \cdot s$$
$$y_{next} = y_{curr} + \left(\frac{dy}{d}\right) \cdot s$$

> **Nota de Implementação:** As velocidades são normalizadas por um fator de **0.16** para compensar a frequência de atualização do loop e manter a consistência visual em monitores com diferentes taxas de atualização (Hz).

---

## 4. Componentes Principais

### 🛠️ `extension.js`
* **Detecção de Fullscreen**: Utiliza o sinal `in-fullscreen-changed`. O sistema suspende o processamento da FSM (*early return*) quando aplicações em tela cheia (jogos ou vídeos) são detectadas, otimizando o consumo de energia.
* **Renderização de Frames**: Implementa mutação de propriedade `gicon` sobre um único ator `St.Icon`. Essa abordagem evita o *layout thrashing* e minimiza o consumo de VRAM.

### ⚙️ `prefs.js`
* **Stack Tecnológica**: Baseada em **Libadwaita** e **GTK4**.
* **Data Binding**: Sincronização em tempo real entre a interface de preferências e o motor da extensão via `settings.bind`, permitindo ajustes dinâmicos de tamanho e performance.

---

## 5. Especificações de Animação (`ANIMATION_DATA`)

| Estado | FPS | Frame Count | Comportamento |
| :--- | :---: | :---: | :--- |
| **Sitting** | 1 | 1 | Estático (Consumo zero) |
| **Getting Up** | 24 | 13 | Transição Bloqueante |
| **Walking** | 15 | 39 | Loop Cíclico |
| **Flying** | 20 | 7 | Loop Cíclico |
| **Sitting Down** | 24 | 8 | Transição Bloqueante |

---

## 6. Configuração e GSettings
O esquema de dados é persistido via banco de dados nativo do GNOME (`gschema.xml`):
* `walk-speed`: Escalar de velocidade para caminhada.
* `fly-speed`: Escalar de velocidade para voo.
* `pet-size`: Dimensão do ator em pixels (lado do quadrado).
