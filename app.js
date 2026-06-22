/**
 * =============================================================================
 * TELEMETRIA F1 DASHBOARD - SISTEMA JAVASCRIPT CORE (versione WebSocket)
 * =============================================================================
 *
 * Questo modulo implementa la dashboard front-end per la simulazione F1.
 * Riceve i dati in tempo reale via WebSocket, aggiorna la classifica,
 * i grafici, il tracciato animato e gestisce l'interazione utente.
 *
 * Dipendenze: Chart.js, ChartDataLabels (per il grafico comparison).
 *
 * STRUTTURA DEL FILE:
 *   1. Configurazione – Parametri costanti
 *   2. Stato globale – Variabili di runtime
 *   3. WebSocket – Connessione e gestione eventi
 *   4. Aggiornamento dati – updateAll e funzioni correlate
 *   5. UI: Leaderboard – Classifica animata
 *   6. UI: Comparison Chart – Grafico a barre del gap
 *   7. UI: Grafici principali e PiP – Speed, Acc, Radar
 *   8. Utility – Interpolazione angoli, intersezioni segmenti
 *   9. Tracciato – Caricamento, salvataggio, normalizzazione
 *  10. Trasformazioni geometriche – Coordinate canvas ↔ tracciato
 *  11. Disegno tracciato – Funzione principale drawTrack
 *  12. Disegno vetture, scie e ghost
 *  13. Render loop – Ciclo di animazione
 *  14. Drag e follow mode – Interazione con la pista
 *  15. Editor del tracciato – Modifica punti
 *  16. Picture-in-Picture (PiP) – Widget galleggianti
 *  17. Grafici Chart.js – Inizializzazione
 *  18. Comunicazione REST – Devices, Race, AI
 *  19. Utility UI – Ridimensionamento, pulsanti
 *  20. Inizializzazione – Avvio all'avvio della pagina
 * =============================================================================
 */

// =============================================================================
// 1. CONFIGURAZIONE – Parametri e costanti globali
// =============================================================================

/**
 * URL del backend FastAPI (modificare in base al proprio server)
 * @constant {string}
 */
const BACKEND_URL = "http://192.168.1.70:8000";

/** Numero di campioni per i buffer dei grafici (speed e acc) */
const BUFFER_SIZE = 50;

/** Altezza in pixel di ogni riga della leaderboard */
const ROW_HEIGHT = 64;

/** Larghezza effettiva della pista in metri (usata per il posizionamento laterale) */
const TRACK_WIDTH_METERS = 12.0;

/** Scala base per i punti del tracciato (adattata al canvas) */
const TRACK_SCALE = 1000;

/** Dimensione di base per il salvataggio del tracciato (normalizzazione) */
const TRACK_BASE_SIZE = 4000;

/** Flag per forzare il ridisegno del tracciato al prossimo frame */
let trackNeedsRedraw = false;

/** Limiti minimo e massimo per lo zoom della pista */
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3.0;

/** Chiave per il salvataggio del tracciato personalizzato nel localStorage */
const TRACK_STORAGE_KEY = "f1_custom_track_points";

/** Punti del tracciato di default (normalizzati, verranno scalati) */
const DEFAULT_TRACK_POINTS = [
    [20, 130], [78, 38], [150, 34], [208, 74], [262, 48],
    [322, 92], [292, 150], [226, 140], [204, 206], [138, 228],
    [94, 184], [48, 218], [6, 170], [20, 130]
];

/** ID del contenitore per i widget Picture‑in‑Picture */
const PIP_CONTAINER_ID = 'pip-container';

// Flag di default per il tracciato chiuso (sarà sovrascritto dal backend)
let trackClosed = true;

/** Array di note rally (posizioni e parametri) */
let rallyNotes = [];

/** Visibilità delle note rally sul canvas */
let showRallyNotes = true;

// =============================================================================
// 2. STATO GLOBALE – Variabili di runtime
// =============================================================================

/** Riferimenti ai grafici Chart.js principali */
let speedChart = null, accChart = null, compareChart = null, radarChart = null;

/** ID della vettura attualmente selezionata */
let selectedDevice = null;

/** Indica se la gara è in corso (start/stop) */
let raceRunning = false;

/** Stato più recente ricevuto dal server per ogni vettura (dati grezzi) */
let serverCarStates = {};

/** Stato interpolato per il rendering client (posizione, angolo, velocità smoothed) */
let clientRenderStates = {};

/** Scie (trails) di ogni vettura: array di punti {lap, lateral_pos, acc} */
let carTrails = {};

/** Posizioni precedenti in classifica per calcolare i delta di sorpasso */
let previousPositions = {};

/** Riferimenti alle righe DOM della leaderboard (per aggiornamenti efficienti) */
let leaderboardElements = {};

/** Timestamp dell'ultimo cambio di posizione per ogni vettura (indicatori di sorpasso) */
let positionChangeTimestamps = {};

/** Delta (variazione) di posizione per ogni vettura */
let positionChangeDeltas = {};

/** Buffer circolari per i grafici della vettura selezionata */
let speedBuffer = [], accBuffer = [];

/** Punti correnti del tracciato (scalati per il rendering) */
let TRACK_POINTS = loadTrackPoints();

/** Lunghezza del tracciato in metri (dinamica, ricevuta dal backend) */
let trackLength = 2000;  // default, verrà sovrascritto

/** Livello di zoom corrente sulla pista */
let trackZoom = 1.0;

/** Flag per abilitare la modalità editor del tracciato */
let trackEditorEnabled = false;

/** Punti del tracciato in fase di editing (bozza) */
let trackDraftPoints = [];

/** Flag per la modalità espansa (canvas a tutto schermo) */
let trackExpanded = false;

/** Stato del giro più veloce (record) – usato per la ghost car */
let fastestLapState = {
    device: null,      // ID della vettura che ha stabilito il record
    timestamp: 0,      // Momento dell'ultimo aggiornamento
    lapTime: null      // Tempo del giro in millisecondi
};

/** Progresso della ghost car (0.0 – 1.0) lungo il tracciato */
let ghostLapProgress = 0.0;

/** Flag per indicare se la ghost è in attesa (quando la vettura selezionata è in zona partenza) */
let ghostWaiting = false;

/** Timestamp dell'ultimo frame renderizzato (per il calcolo del delta time) */
let lastFrameTime = Date.now();

/** Widget PiP: riferimenti ai grafici, stato di attivazione e dimensioni */
let pipCharts = { speed: null, acc: null, compare: null, radar: null };
let pipActive = { speed: false, acc: false, compare: false, radar: false };
let pipSizes = {
    speed: { width: 300, height: 170 },
    acc: { width: 300, height: 170 },
    compare: { width: 300, height: 170 },
    radar: { width: 300, height: 170 }
};

/** Dati per il ridimensionamento (resize) dei widget PiP */
let resizeData = null;

/** Riferimento al canvas della pista e al suo contesto 2D */
const trackCanvas = document.getElementById("trackCanvas");
const ctxTrack = trackCanvas.getContext("2d");

/** Connessione WebSocket */
let ws = null;

/** Elemento DOM che mostra gli FPS (creato all'inizializzazione) */
let fpsDiv = null;

/** Contatore di frame per il calcolo degli FPS */
let frameCount = 0;

/** Timestamp per il calcolo periodico degli FPS */
let fpsLastTime = performance.now();

/** Ultimo ridimensionamento del canvas (per evitare troppi resize) */
let lastCanvasResize = 0;

/** Cache per la leaderboard (ottimizzazione delle ricostruzioni DOM) */
let leaderboardCache = {};

// ---------- PAN (trascinamento della pista) ----------
/** Offset di pan (spostamento orizzontale e verticale) in coordinate di tracciato */
let panX = 0;
let panY = 0;

/** Flag per indicare se l'utente sta trascinando la pista */
let isDragging = false;

/** Coordinate di inizio del trascinamento (pixel) */
let dragStartX = 0, dragStartY = 0;

/** Offset di pan all'inizio del trascinamento */
let panStartX = 0, panStartY = 0;

// ---------- FOLLOW MODE ----------
/** Flag per la modalità follow (la telecamera segue la vettura selezionata) */
let followMode = false;

// Registra il plugin ChartDataLabels per i grafici (necessario per il comparison)
Chart.register(ChartDataLabels);

// Comodo alias per il mezzo bordo pista
const TRACK_EDGE_METERS = TRACK_WIDTH_METERS / 2;

// =============================================================================
// 3. WEBSOCKET – Gestione della connessione in tempo reale
// =============================================================================

/**
 * Stabilisce la connessione WebSocket con il backend.
 * In caso di chiusura, tenta la riconnessione automatica dopo 1 secondo.
 */
function connectWebSocket() {
    const wsUrl = `ws://${BACKEND_URL.replace('http://', '')}/ws`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        // Connessione stabilita – nessun log in produzione, solo commento
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);

        // Aggiorna il flag di tracciato chiuso se presente
        if (data.track) {
            trackClosed = data.track.closed !== undefined ? data.track.closed : true;
        }

        if (data.type === 'state') {
            // Aggiorna il tracciato se presente e se è cambiato
            if (data.track && data.track.points && data.track.points.length > 0) {
                const newVersion = data.track.version || 0;
                // Solo se il tracciato è cambiato o non c'è ancora un tracciato
                if (!window._trackVersion || window._trackVersion !== newVersion) {
                    TRACK_POINTS = data.track.points;
                    if (data.track.length_meters) {
                        trackLength = data.track.length_meters;
                        // Salva nel localStorage per persistenza
                        const normalized = TRACK_POINTS.map(p => [p[0] / TRACK_SCALE, p[1] / TRACK_SCALE]);
                        localStorage.setItem(TRACK_STORAGE_KEY, JSON.stringify(normalized));
                        localStorage.setItem('f1_track_length', String(trackLength));
                    }
                    // Reset di zoom e pan solo se il tracciato è effettivamente cambiato
                    trackZoom = 1.0;
                    panX = 0;
                    panY = 0;
                    if (!trackExpanded) {
                        updateCanvasSize();
                    }
                    // Aggiorna la versione per futuri confronti
                    window._trackVersion = newVersion;
                }
            }
            // Aggiorna tutta la UI con i dati delle vetture
            updateAll(data.cars);
        }
    };

    ws.onclose = () => {
        // Riconnessione automatica
        setTimeout(connectWebSocket, 1000);
    };

    ws.onerror = () => {
        // Gli errori vengono gestiti da onclose
    };
}

// =============================================================================
// 4. AGGIORNAMENTO COMPLETO – Punto di ingresso per ogni messaggio WebSocket
// =============================================================================

/**
 * Aggiorna tutti gli elementi dell'interfaccia in base all'array delle vetture.
 * @param {Array} cars - Array di oggetti vettura dal server (vuoto se nessuna auto).
 */
function updateAll(cars) {
    // Se non ci sono auto, resetta tutto lo stato a vuoto
    if (!cars || cars.length === 0) {
        speedBuffer = [];
        accBuffer = [];

        // Resetta i grafici principali
        if (speedChart) {
            speedChart.data.datasets[0].data = Array(50).fill(0);
            speedChart.update('none');
        }
        if (accChart) {
            accChart.data.datasets[0].data = Array(50).fill(0);
            accChart.update('none');
        }
        if (radarChart) {
            radarChart.data.datasets[0].data = [0, 0, 0, 0, 0];
            radarChart.update('none');
        }

        // Resetta i grafici nei widget PiP
        if (pipCharts.speed) {
            pipCharts.speed.data.datasets[0].data = Array(50).fill(0);
            pipCharts.speed.update('none');
        }
        if (pipCharts.acc) {
            pipCharts.acc.data.datasets[0].data = Array(50).fill(0);
            pipCharts.acc.update('none');
        }
        if (pipCharts.radar) {
            pipCharts.radar.data.datasets[0].data = [0, 0, 0, 0, 0];
            pipCharts.radar.update('none');
        }

        // Resetta i valori numerici nei widget PiP
        document.querySelectorAll('.pip-item').forEach(wrapper => {
            const valueEl = wrapper._valueElement;
            if (valueEl) {
                valueEl.textContent = '--';
                valueEl.style.color = 'rgba(255,255,255,0.3)';
            }
        });

        // Aggiorna le altre UI con stato vuoto
        updateServerStates(cars);
        updateLeaderboardUI(cars);
        updateComparisonUI(cars);
        updateLapTimerUI();

        return;
    }

    // Se ci sono auto, procedi con gli aggiornamenti normali
    updateServerStates(cars);
    updateLeaderboardUI(cars);
    updateComparisonUI(cars);
    updateChartsUI();
    updateLapTimerUI();
    if (!trackExpanded) {
        updateCanvasSize();
    }
}

// =============================================================================
// 4.1 Aggiornamento dello stato delle vetture (server e fastest lap)
// =============================================================================

/**
 * Popola serverCarStates con i dati ricevuti, gestisce il giro più veloce
 * e aggiorna i buffer per la vettura selezionata.
 * @param {Array} cars - Array di vetture dal server.
 */
function updateServerStates(cars) {
    const newStates = {};
    let foundFastest = false;

    cars.forEach(car => {
        // Calcola la frazione di giro (0..1) usando la lunghezza dinamica
        const lap = car.lap !== undefined ? car.lap : (trackLength > 0 ? (car.distance % trackLength) / trackLength : 0);
        newStates[car.device] = {
            lap: lap,
            speed: car.speed,
            acc: car.accX || 0,
            lateral_pos: car.lateral_pos || 0,
            rank: car.position - 1,
            label: `${car.position_label} (${car.device})`
        };

        // Se questa vettura ha il giro più veloce, aggiorna fastestLapState
        if (car.is_fastest_lap && car.fastest_lap_time) {
            const newTime = car.fastest_lap_time;
            if (fastestLapState.device !== car.device || fastestLapState.lapTime !== newTime) {
                fastestLapState.device = car.device;
                fastestLapState.timestamp = Date.now();
                fastestLapState.lapTime = newTime;
                ghostLapProgress = 0.0;
                ghostWaiting = false;
            }
            foundFastest = true;
        }

        // Se questa è la vettura selezionata, aggiorna i buffer per i grafici
        if (car.device === selectedDevice) {
            speedBuffer.push(car.speed);
            accBuffer.push(car.accX || 0);
            if (speedBuffer.length > BUFFER_SIZE) {
                speedBuffer.shift();
                accBuffer.shift();
            }
        }
    });

    // Sincronizza lo stato "arrivato" per le vetture che hanno finito (tracciato aperto)
    Object.keys(clientRenderStates).forEach(id => {
        if (clientRenderStates[id].finished && newStates[id]) {
            newStates[id].lap = 1.0;
            newStates[id].speed = 0;
            newStates[id].acc = 0;
        }
    });

    // Se non c'è più il fastest, resetta lo stato
    if (!foundFastest && fastestLapState.device) {
        const stillExists = cars.some(c => c.device === fastestLapState.device);
        if (!stillExists) {
            fastestLapState.device = null;
            fastestLapState.lapTime = null;
            ghostLapProgress = 0.0;
            ghostWaiting = false;
        }
    }

    // Sostituisci lo stato server con i nuovi dati
    serverCarStates = newStates;

    // Rimuovi gli stati client per vetture non più presenti
    const currentDevices = new Set(cars.map(c => c.device));
    Object.keys(clientRenderStates).forEach(id => {
        if (!currentDevices.has(id)) {
            delete clientRenderStates[id];
            delete carTrails[id];
        }
    });
}

// =============================================================================
// 5. UI: LEADERBOARD – Classifica dinamica con animazioni e indicatori
// =============================================================================

/**
 * Aggiorna la leaderboard (classifica) visualizzata a sinistra.
 * Utilizza una cache per evitare ricostruzioni DOM non necessarie.
 * @param {Array} cars - Array di vetture (già ordinate per posizione).
 */
function updateLeaderboardUI(cars) {
    const container = document.getElementById("leaderboard");
    if (!container) return;

    // Se non ci sono auto, mostra un messaggio e pulisce tutto
    if (!cars || cars.length === 0) {
        container.innerHTML = "<div style='padding:20px; text-align:center; opacity:0.4;'>No cars on track...</div>";
        leaderboardElements = {};
        leaderboardCache = {};
        return;
    }

    const now = Date.now();
    const currentOrder = cars.map(c => c.device);

    // --- 1. Rimuovi le righe per le auto scomparse ---
    const currentDevices = new Set(currentOrder);
    Object.keys(leaderboardElements).forEach(id => {
        if (!currentDevices.has(id)) {
            const el = leaderboardElements[id];
            if (el && el.parentNode) el.parentNode.removeChild(el);
            delete leaderboardElements[id];
            delete leaderboardCache[id];
            delete positionChangeTimestamps[id];
            delete positionChangeDeltas[id];
        }
    });

    // --- 2. Calcola i delta di posizione (per gli indicatori di sorpasso) ---
    const positionDeltas = {};
    cars.forEach((car, index) => {
        const prevPos = previousPositions[car.device];
        if (prevPos !== undefined) {
            const delta = prevPos - index;  // positivo = guadagnato posizioni
            positionDeltas[car.device] = delta;
            if (delta !== 0) {
                positionChangeDeltas[car.device] = delta;
                positionChangeTimestamps[car.device] = now;
            }
        } else {
            positionDeltas[car.device] = 0;
        }
    });

    // --- 3. Crea o aggiorna le righe DOM per ogni vettura ---
    cars.forEach((car, index) => {
        let el = leaderboardElements[car.device];
        if (!el) {
            el = document.createElement('div');
            el.className = 'leaderboard-row';
            el.dataset.device = car.device;
            container.appendChild(el);
            leaderboardElements[car.device] = el;
        }

        const isSelected = car.device === selectedDevice;
        const posNum = index + 1;
        // Classe per il colore della posizione (top 3)
        let posClass = 'pos-other';
        if (posNum === 1) posClass = 'pos-1';
        else if (posNum === 2) posClass = 'pos-2';
        else if (posNum === 3) posClass = 'pos-3';

        // Calcolo del gap dal leader in metri
        const leaderDist = cars[0].distance || 0;
        const gap = leaderDist - (car.distance || 0);
        const gapPercent = leaderDist > 0 ? Math.min(100, Math.max(0, (gap / leaderDist) * 100)) : 0;
        const gapText = gap < 1 ? '🏆' : (gap < 10 ? `${gap.toFixed(1)}m` : `${Math.round(gap)}m`);

        // Usura gomme (tyre) – valori da 0 a 100
        let tyreVal = parseFloat(car.tyre);
        if (isNaN(tyreVal) || tyreVal < 0) tyreVal = 100;
        const tyrePct = Math.max(0, Math.min(100, tyreVal));
        const tyreColor = tyrePct > 60 ? '#4caf50' : tyrePct > 30 ? '#ff7b00' : '#ff3b30';

        // Miglior giro – formattazione
        let bestLapText = '--.--';
        if (car.best_lap !== undefined && car.best_lap !== null && car.best_lap !== "--.--" && car.best_lap !== "") {
            const lapNum = parseFloat(car.best_lap);
            if (!isNaN(lapNum) && lapNum > 0) {
                bestLapText = `${lapNum.toFixed(2)}s`;
            } else {
                bestLapText = String(car.best_lap);
                if (!isNaN(lapNum) && lapNum > 0 && !bestLapText.includes('.')) {
                    bestLapText = `${lapNum.toFixed(2)}s`;
                }
            }
        }

        // --- 4. Calcola un hash dei dati per il diff (evita ricostruzioni inutili) ---
        const dataHash = JSON.stringify({
            pos: posNum,
            gapPct: Math.round(gapPercent),
            gapText: gapText,
            tyre: Math.round(tyrePct),
            tyreColor: tyreColor,
            speed: Math.round(car.speed),
            dist: Math.round(car.distance),
            best: bestLapText,
            inPit: car.in_pit || false,
            isSelected: isSelected,
            posClass: posClass,
            change: positionChangeDeltas[car.device] || 0
        });

        // Se i dati non sono cambiati, aggiorna solo la posizione (transform) e le classi
        if (leaderboardCache[car.device] === dataHash) {
            el.style.transform = `translateY(${index * 64}px)`;
            el.className = `leaderboard-row ${isSelected ? 'selected' : ''} ${(positionDeltas[car.device] || 0) > 0 ? 'overtaking' : ''}`;
            el.style.borderLeftColor = isSelected ? 'var(--f1-blue)' : 'transparent';
            return;
        }
        // Altrimenti aggiorna la cache e ricostruisce l'HTML
        leaderboardCache[car.device] = dataHash;

        // --- 5. Gestione dell'indicatore di sorpasso (visibile per 5 secondi) ---
        const lastDelta = positionChangeDeltas[car.device] || 0;
        const lastChangeTime = positionChangeTimestamps[car.device] || 0;
        const timeSinceChange = now - lastChangeTime;
        const showIndicator = (timeSinceChange < 5000 && lastDelta !== 0);
        let changeHtml = '';
        if (showIndicator) {
            const arrow = lastDelta > 0 ? '↑' : '↓';
            const colorClass = lastDelta > 0 ? 'up' : 'down';
            const count = Math.abs(lastDelta);
            changeHtml = `<span class="leaderboard-change ${colorClass}">${arrow}${count}</span>`;
        } else {
            changeHtml = `<span class="leaderboard-change neutral">—</span>`;
        }

        // --- 6. Costruzione del markup della riga ---
        el.className = `leaderboard-row ${isSelected ? 'selected' : ''} ${(positionDeltas[car.device] || 0) > 0 ? 'overtaking' : ''}`;
        el.style.borderLeftColor = isSelected ? 'var(--f1-blue)' : 'transparent';

        el.innerHTML = `
            <span class="leaderboard-pos ${posClass}">${posNum}</span>
            <span class="leaderboard-name">${isSelected ? `<span class="highlight">${car.device}</span>` : car.device}</span>
            <div class="leaderboard-progress-wrap">
                <div class="leaderboard-progress-bg">
                    <div class="leaderboard-progress-fill" style="width:${gapPercent}%;"></div>
                </div>
                <span class="leaderboard-progress-label">${gapText}</span>
            </div>
            <div class="leaderboard-details">
                <span class="detail-item tyre">
                    <span class="detail-icon">🏁</span>
                    <span style="font-weight:700; color:${tyreColor};">${Math.round(tyrePct)}%</span>
                </span>
                <span class="detail-item">
                    <span class="detail-icon">⚡</span>
                    <span class="detail-value speed">${car.in_pit ? 'PIT' : `${Math.round(car.speed)}`}</span>
                </span>
                <span class="detail-item">
                    <span class="detail-icon">📏</span>
                    <span class="detail-value distance">${Math.round(car.distance)}m</span>
                </span>
                <span class="detail-item">
                    <span class="detail-icon">🏆</span>
                    <span class="detail-value best">${bestLapText}</span>
                </span>
            </div>
            ${changeHtml}
        `;
    });

    // --- 7. Applica le trasformazioni per il posizionamento assoluto (animazione) ---
    const newElements = Object.values(leaderboardElements).filter(el => !el._initialized);
    newElements.forEach(el => {
        el.style.transition = 'none';
        el.style.transform = 'translateY(0px)';
    });
    void container.offsetHeight; // Forza il reflow per far partire le transizioni
    cars.forEach((car, index) => {
        const el = leaderboardElements[car.device];
        if (!el) return;
        if (newElements.includes(el)) {
            el.style.transition = '';
            el._initialized = true;
        }
        el.style.transform = `translateY(${index * 64}px)`;
    });

    // --- 8. Aggiorna previousPositions per i prossimi calcoli di delta ---
    previousPositions = {};
    cars.forEach((car, index) => {
        previousPositions[car.device] = index;
    });
}

// =============================================================================
// 6. UI: COMPARISON CHART – Grafico a barre del gap dal leader
// =============================================================================

/**
 * Aggiorna il grafico comparison (barre orizzontali) che mostra
 * il gap in metri di ogni vettura dal leader.
 * @param {Array} cars - Array di vetture (ordinate per posizione).
 */
function updateComparisonUI(cars) {
    // Se non ci sono auto, resetta il grafico e i widget PiP
    if (!cars || cars.length === 0) {
        document.querySelectorAll('.pip-item[data-type="compare"]').forEach(w => {
            const v = w._valueElement;
            if (v) { v.textContent = 'N/A'; v.style.color = 'rgba(255,255,255,0.3)'; }
        });
        compareChart.data.labels = [];
        compareChart.data.datasets[0].data = [];
        compareChart.data.datasets[0].backgroundColor = [];
        compareChart.update('none');
        if (pipCharts.compare) {
            pipCharts.compare.data.labels = [];
            pipCharts.compare.data.datasets[0].data = [];
            pipCharts.compare.data.datasets[0].backgroundColor = [];
            pipCharts.compare.update('none');
        }
        return;
    }

    const leaderDist = cars[0].distance;
    const labels = [];
    const values = [];
    const backgroundColors = [];
    const borderColors = [];

    cars.forEach((car, index) => {
        labels.push(car.device);
        const gap = leaderDist - car.distance;
        const clampedGap = Math.max(0, gap);
        values.push(clampedGap);

        // Colori dinamici in base alla posizione e selezione
        let bgColor, borderColor;
        const isSelected = car.device === selectedDevice;
        const position = car.position;

        if (isSelected) {
            // Vettura selezionata: blu brillante con gradiente
            bgColor = 'rgba(74, 158, 255, 0.7)';
            borderColor = '#4a9eff';
        } else if (position === 1) {
            // Leader: oro
            bgColor = 'rgba(255, 215, 0, 0.8)';
            borderColor = '#ffd700';
        } else if (position === 2) {
            // Secondo: argento
            bgColor = 'rgba(192, 192, 192, 0.6)';
            borderColor = '#c0c0c0';
        } else if (position === 3) {
            // Terzo: bronzo
            bgColor = 'rgba(205, 127, 50, 0.6)';
            borderColor = '#cd7f32';
        } else {
            // Altri: trasparenza variabile in base al gap
            const opacity = Math.max(0.2, 0.5 - (position / 20));
            bgColor = `rgba(255, 255, 255, ${opacity})`;
            borderColor = `rgba(255, 255, 255, ${opacity + 0.2})`;
        }

        backgroundColors.push(bgColor);
        borderColors.push(borderColor);
    });

    // Aggiorna il dataset del grafico
    compareChart.data.labels = labels;
    compareChart.data.datasets[0].data = values;
    compareChart.data.datasets[0].backgroundColor = backgroundColors;
    compareChart.data.datasets[0].borderColor = borderColors;

    // Imposta il massimo dell'asse X in base al valore massimo (con un po' di margine)
    const maxValue = Math.max(...values, 10);
    compareChart.options.scales.x.max = maxValue * 1.15;

    compareChart.update(); // Animazione automatica

    // Aggiorna il widget PiP se attivo
    if (pipCharts.compare) {
        pipCharts.compare.data.labels = labels;
        pipCharts.compare.data.datasets[0].data = values;
        pipCharts.compare.data.datasets[0].backgroundColor = backgroundColors;
        pipCharts.compare.data.datasets[0].borderColor = borderColors;
        pipCharts.compare.update('none');
    }

    // Aggiorna i valori numerici nei widget PiP
    document.querySelectorAll('.pip-item[data-type="compare"]').forEach(wrapper => {
        const valueEl = wrapper._valueElement;
        if (!valueEl) return;
        if (!selectedDevice || !cars.length) {
            valueEl.textContent = '--';
            valueEl.style.color = 'rgba(255,255,255,0.3)';
            return;
        }
        const car = cars.find(c => c.device === selectedDevice);
        if (!car) {
            valueEl.textContent = 'N/A';
            valueEl.style.color = 'rgba(255,255,255,0.3)';
            return;
        }
        const gap = leaderDist - car.distance;
        const gapRounded = Math.round(gap);
        if (gapRounded === 0 && car.device === cars[0].device) {
            valueEl.textContent = '🏆 Leader';
            valueEl.style.color = '#ffd700';
            valueEl.style.textShadow = '0 0 20px rgba(255, 215, 0, 0.4)';
        } else {
            valueEl.textContent = gapRounded + ' m';
            valueEl.style.textShadow = 'none';
            if (gapRounded < 10) valueEl.style.color = '#00ff88';
            else if (gapRounded < 50) valueEl.style.color = '#ffaa00';
            else valueEl.style.color = '#ff004c';
        }
    });
}

// =============================================================================
// 7. UI: GRAFICI PRINCIPALI (speed, acc, radar) e AGGIORNAMENTO PIP
// =============================================================================

/**
 * Aggiorna i grafici speed, acc e i rispettivi widget PiP.
 * Viene chiamata ad ogni aggiornamento dati.
 */
function updateChartsUI() {
    // Aggiorna il grafico speed
    if (speedChart) {
        speedChart.data.datasets[0].data = speedBuffer;
        speedChart.update('none');
    }
    // Aggiorna il grafico acc
    if (accChart) {
        accChart.data.datasets[0].data = accBuffer;
        accChart.update('none');
    }
    // Aggiorna i widget PiP corrispondenti
    if (pipCharts.speed) {
        pipCharts.speed.data.datasets[0].data = speedBuffer;
        pipCharts.speed.update('none');
    }
    if (pipCharts.acc) {
        pipCharts.acc.data.datasets[0].data = accBuffer;
        pipCharts.acc.update('none');
    }

    // Aggiorna i valori numerici (ultimo campione) nei widget PiP
    const lastSpeed = speedBuffer.length ? speedBuffer[speedBuffer.length-1] : null;
    const lastAcc = accBuffer.length ? accBuffer[accBuffer.length-1] : null;
    document.querySelectorAll('.pip-item').forEach(wrapper => {
        const type = wrapper.dataset.type;
        const valueEl = wrapper._valueElement;
        if (!valueEl) return;
        if (type === 'speed' && lastSpeed !== null) {
            valueEl.textContent = Math.round(lastSpeed) + ' km/h';
            valueEl.style.color = lastSpeed > 200 ? '#00ff88' : '#ffaa00';
        } else if (type === 'acc' && lastAcc !== null) {
            const accDisplay = lastAcc > 0 ? '+' + lastAcc.toFixed(1) : lastAcc.toFixed(1);
            valueEl.textContent = accDisplay + ' m/s²';
            valueEl.style.color = lastAcc > 0 ? '#00ff88' : '#ff004c';
        }
    });
}

/**
 * Aggiorna il grafico radar (profilo della vettura selezionata).
 * Viene chiamata ogni 3 secondi tramite setInterval.
 */
async function updateRadar() {
    if (!selectedDevice) return;
    try {
        const res = await fetch(`${BACKEND_URL}/telemetry?device_id=${selectedDevice}&n=50`);
        const data = await res.json();
        if (data.profile && Object.keys(data.profile).length > 0) {
            const radarData = [
                data.profile.driver_skill,
                data.profile.engine_power,
                data.profile.tyre_life,
                data.profile.top_speed,
                data.profile.brake_bias
            ];
            radarChart.data.datasets[0].data = radarData;
            radarChart.update('none');
            if (pipCharts.radar) {
                pipCharts.radar.data.datasets[0].data = radarData;
                pipCharts.radar.update('none');
            }
            // Aggiorna il valore medio nel widget PiP
            document.querySelectorAll('.pip-item[data-type="radar"]').forEach(wrapper => {
                const valueEl = wrapper._valueElement;
                if (valueEl && radarData.length) {
                    const avg = radarData.reduce((a,b) => a+b, 0) / radarData.length;
                    valueEl.textContent = Math.round(avg) + '%';
                    valueEl.style.color = avg > 70 ? '#00ff88' : avg > 40 ? '#ffaa00' : '#ff004c';
                }
            });
        }
    } catch (e) {
        // Silenzioso – se il backend non risponde, il radar rimane invariato
    }
}

/**
 * Aggiorna il timer del giro più veloce (nell'header).
 */
function updateLapTimerUI() {
    const timerEl = document.getElementById('lapTimer');
    if (!timerEl) return;
    if (fastestLapState.lapTime && fastestLapState.device) {
        const seconds = fastestLapState.lapTime / 1000;
        timerEl.textContent = `${seconds.toFixed(3)}s`;
        timerEl.classList.add('purple');
    } else {
        timerEl.textContent = '--:--';
        timerEl.classList.remove('purple');
    }
}

// =============================================================================
// 8. FUNZIONI DI UTILITÀ GENERALE
// =============================================================================

/**
 * Interpola linearmente un angolo (in radianti) per evitare salti bruschi.
 * Gestisce il wraparound tra -PI e PI.
 * @param {number} current - Angolo corrente.
 * @param {number} target - Angolo bersaglio.
 * @param {number} factor - Fattore di interpolazione (0..1).
 * @returns {number} Angolo interpolato.
 */
function smoothAngle(current, target, factor) {
    let diff = target - current;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return current + diff * factor;
}

/**
 * Calcola l'intersezione tra due segmenti (a-b) e (c-d).
 * Restituisce il punto di intersezione o null se non c'è.
 * Usato per individuare i ponti nel tracciato.
 */
function getLineIntersection(a, b, c, d) {
    const abX = b.x - a.x;
    const abY = b.y - a.y;
    const cdX = d.x - c.x;
    const cdY = d.y - c.y;
    const denom = abX * cdY - abY * cdX;
    if (Math.abs(denom) < 0.0001) return null;
    const acX = c.x - a.x;
    const acY = c.y - a.y;
    const t = (acX * cdY - acY * cdX) / denom;
    const u = (acX * abY - acY * abX) / denom;
    if (t <= 0.04 || t >= 0.96 || u <= 0.04 || u >= 0.96) return null;
    return { x: a.x + abX * t, y: a.y + abY * t, t, u };
}

// =============================================================================
// 9. GESTIONE DEL TRACCIATO (CARICAMENTO, SALVATAGGIO, NORMALIZZAZIONE)
// =============================================================================

/**
 * Carica i punti del tracciato dal localStorage, o usa quelli di default.
 * I punti vengono caricati in coordinate scalate (TRACK_SCALE).
 * @returns {Array} Array di punti [x,y] scalati.
 */
function loadTrackPoints() {
    try {
        const saved = localStorage.getItem(TRACK_STORAGE_KEY);
        if (!saved) {
            const normalized = normalizePoints(DEFAULT_TRACK_POINTS);
            return normalized.map(p => [p[0] * TRACK_SCALE, p[1] * TRACK_SCALE]);
        }
        const parsed = JSON.parse(saved);
        if (!Array.isArray(parsed) || parsed.length < 4) {
            const normalized = normalizePoints(DEFAULT_TRACK_POINTS);
            return normalized.map(p => [p[0] * TRACK_SCALE, p[1] * TRACK_SCALE]);
        }
        return parsed.map(p => [p[0] * TRACK_SCALE, p[1] * TRACK_SCALE]);
    } catch (err) {
        // In caso di errore, usa il tracciato di default
        const normalized = normalizePoints(DEFAULT_TRACK_POINTS);
        return normalized.map(p => [p[0] * TRACK_SCALE, p[1] * TRACK_SCALE]);
    }
}

/**
 * Salva i punti del tracciato nel localStorage (normalizzati).
 * @param {Array} points - Punti in coordinate assolute (scalate).
 */
function saveTrackPoints(points) {
    const percent = points.map(p => [p[0] / TRACK_BASE_SIZE, p[1] / TRACK_BASE_SIZE]);
    localStorage.setItem(TRACK_STORAGE_KEY, JSON.stringify(percent));
}

/**
 * Normalizza un insieme di punti in modo che siano centrati e abbiano
 * estensione massima 1 (range -1..1).
 * @param {Array} points - Array di [x,y].
 * @returns {Array} Punti normalizzati.
 */
function normalizePoints(points) {
    if (!points || points.length < 2) return points;
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    points.forEach(p => {
        minX = Math.min(minX, p[0]);
        minY = Math.min(minY, p[1]);
        maxX = Math.max(maxX, p[0]);
        maxY = Math.max(maxY, p[1]);
    });
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const halfWidth = (maxX - minX) / 2;
    const halfHeight = (maxY - minY) / 2;
    const maxHalf = Math.max(halfWidth, halfHeight);
    if (maxHalf === 0) return points.map(p => [0, 0]);
    return points.map(p => [
        (p[0] - cx) / maxHalf,
        (p[1] - cy) / maxHalf
    ]);
}

/**
 * Denormalizza punti (da normalizzati a scalati).
 * @param {Array} normalized - Punti normalizzati.
 * @param {number} scale - Fattore di scala (default TRACK_SCALE).
 * @returns {Array} Punti scalati.
 */
function denormalizePoints(normalized, scale = TRACK_SCALE) {
    return normalized.map(p => [p[0] * scale, p[1] * scale]);
}

/**
 * Carica il tracciato dal backend (endpoint /get_track) e aggiorna le variabili globali.
 */
async function loadTrackFromBackend() {
    try {
        const res = await fetch(`${BACKEND_URL}/get_track`);
        const data = await res.json();
        if (data.ok && data.points && data.points.length > 0) {
            TRACK_POINTS = data.points;
            trackClosed = data.closed !== undefined ? data.closed : true;
            if (data.track_length_meters) {
                trackLength = data.track_length_meters;
                // Salva nel localStorage per persistenza
                const normalized = TRACK_POINTS.map(p => [p[0] / TRACK_SCALE, p[1] / TRACK_SCALE]);
                localStorage.setItem(TRACK_STORAGE_KEY, JSON.stringify(normalized));
                localStorage.setItem('f1_track_length', String(trackLength));
            }
            // Reset di zoom e pan
            trackZoom = 1.0;
            panX = 0;
            panY = 0;
            updateCanvasSize();
        }
    } catch (err) {
        // Fallback silenzioso – il tracciato locale rimane
    }
}

// =============================================================================
// 10. TRASFORMAZIONI GEOMETRICHE PER IL RENDERING DELLA PISTA
// =============================================================================

/** Cache per il layout di trasformazione (ottimizzazione) */
const layoutCache = {};

/**
 * Calcola il layout di trasformazione per portare i punti del tracciato
 * nello spazio canvas, tenendo conto di zoom e pan.
 * @param {number} w - Larghezza canvas.
 * @param {number} h - Altezza canvas.
 * @param {number} zoom - Fattore di zoom (default trackZoom).
 * @returns {Object} Layout con minX, minY, maxX, maxY, scale, offsetX, offsetY.
 */
function getTrackLayout(w, h, zoom = trackZoom) {
    const key = `${w}|${h}|${zoom}|${panX.toFixed(3)}|${panY.toFixed(3)}`;
    if (layoutCache[key]) return layoutCache[key];

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    TRACK_POINTS.forEach(p => {
        minX = Math.min(minX, p[0]);
        minY = Math.min(minY, p[1]);
        maxX = Math.max(maxX, p[0]);
        maxY = Math.max(maxY, p[1]);
    });

    const padding = 46;
    const baseScale = Math.min(
        (w - padding * 2) / (maxX - minX),
        (h - padding * 2) / (maxY - minY)
    );
    const effectiveScale = baseScale * zoom;
    const scaledWidth = (maxX - minX) * effectiveScale;
    const scaledHeight = (maxY - minY) * effectiveScale;

    const layout = {
        minX, minY, maxX, maxY,
        scale: effectiveScale,
        offsetX: (w - scaledWidth) / 2 + panX * effectiveScale,
        offsetY: (h - scaledHeight) / 2 + panY * effectiveScale
    };
    layoutCache[key] = layout;
    return layout;
}

/**
 * Converte un punto del tracciato (coordinate assolute) in coordinate canvas.
 * @param {Array} point - [x,y] in coordinate assolute.
 * @param {Object} layout - Layout ottenuto da getTrackLayout().
 * @returns {Object} {x, y} coordinate canvas.
 */
function toCanvasPoint(point, layout) {
    return {
        x: layout.offsetX + (point[0] - layout.minX) * layout.scale,
        y: layout.offsetY + (layout.maxY - point[1]) * layout.scale
    };
}

/**
 * Restituisce il punto, la normale e la tangente sul tracciato in una data frazione t.
 * @param {number} t - Frazione da 0 a 1 (può essere >1, verrà normalizzata).
 * @param {number} w - Larghezza canvas.
 * @param {number} h - Altezza canvas.
 * @returns {Object} {x, y, normalX, normalY, tangentX, tangentY, index, layout}
 */
function getTrackSegment(t, w, h) {
    let percentage;
    if (!trackClosed && t >= 1.0) {
        percentage = 1.0;
    } else {
        percentage = t % 1.0;
        if (percentage < 0) percentage += 1.0;
    }
    const points = TRACK_POINTS;
    const n = points.length - 1;
    const scaledT = percentage * n;
    const index = Math.min(Math.floor(scaledT), n - 1);
    const localT = scaledT - index;
    const layout = getTrackLayout(w, h);
    const p1 = toCanvasPoint(points[index], layout);
    const p2 = toCanvasPoint(points[index + 1], layout);
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    return {
        x: p1.x + dx * localT,
        y: p1.y + dy * localT,
        normalX: -dy / len,
        normalY: dx / len,
        tangentX: dx / len,
        tangentY: dy / len,
        index,
        layout
    };
}

/**
 * Versione semplificata: restituisce solo le coordinate canvas di un punto sul tracciato.
 */
function getTrackPositionFromT(t, w, h) {
    const segment = getTrackSegment(t, w, h);
    return { x: segment.x, y: segment.y };
}

/**
 * Calcola le coordinate canvas di una vettura data la sua frazione di giro (t)
 * e l'offset laterale (lateral_pos in metri).
 * @param {number} t - Frazione di giro (0..1).
 * @param {number} lateralPos - Offset laterale in metri (positivo = sinistra? dipende dalla normale).
 * @param {number} w - Larghezza canvas.
 * @param {number} h - Altezza canvas.
 * @param {number} zoomFactor - Fattore di zoom (per la scala laterale).
 * @param {number|null} lateralScale - Scala pixel/metro (se null, calcolata automaticamente).
 * @returns {Object} {x, y} coordinate canvas.
 */
function getCartesianCoordinates2D(t, lateralPos, w, h, zoomFactor = 1.0, lateralScale = null) {
    const segment = getTrackSegment(t, w, h);
    const clampedLateral = Math.max(-TRACK_EDGE_METERS, Math.min(TRACK_EDGE_METERS, lateralPos));
    if (lateralScale === null) {
        lateralScale = getLateralScale(w, h);
    }
    const lateralPixel = clampedLateral * lateralScale * zoomFactor;
    return {
        x: segment.x + segment.normalX * lateralPixel,
        y: segment.y + segment.normalY * lateralPixel
    };
}

/**
 * Calcola la scala pixel/metro per la larghezza della pista in base alle dimensioni del canvas.
 * @param {number} w - Larghezza canvas.
 * @param {number} h - Altezza canvas.
 * @returns {number} Pixel per metro.
 */
function getLateralScale(w, h) {
    // Larghezza strada in pixel: minimo 8px, massimo 5% del lato minore
    const roadWidthPx = Math.max(8, Math.min(60, 0.03 * Math.min(w, h)));
    return roadWidthPx / TRACK_WIDTH_METERS;
}

// =============================================================================
// 11. DISEGNO DEL TRACCIATO (funzione principale)
// =============================================================================

/**
 * Disegna l'intero tracciato sul canvas: erba, asfalto, bordi, linea start/finish,
 * ponti e, se attivo, l'editor.
 * @param {CanvasRenderingContext2D} ctx - Contesto 2D del canvas.
 * @param {number} w - Larghezza canvas.
 * @param {number} h - Altezza canvas.
 */
function drawTrack(ctx, w, h) {
    if (!TRACK_POINTS || TRACK_POINTS.length < 2) {
        ctx.fillStyle = "#ffffff";
        ctx.font = "20px Arial";
        ctx.textAlign = "center";
        ctx.fillText("⛔ Nessun tracciato caricato", w/2, h/2);
        return;
    }

    // ============================================================
    // 1. SFONDO VERDE (erba)
    // ============================================================
    const grassGrad = ctx.createLinearGradient(0, 0, 0, h);
    grassGrad.addColorStop(0, '#3a8a3a');
    grassGrad.addColorStop(0.5, '#2d7d2d');
    grassGrad.addColorStop(1, '#1a5a1a');
    ctx.fillStyle = grassGrad;
    ctx.fillRect(0, 0, w, h);

    // ============================================================
    // 2. TRACCIATO - calcolo layout e punti canvas
    // ============================================================
    const layout = getTrackLayout(w, h);
    const canvasPoints = TRACK_POINTS.map(p => toCanvasPoint(p, layout));
    const roadWidth = getLateralScale(w, h) * TRACK_WIDTH_METERS * trackZoom;

    ctx.save();

    // Ombra esterna
    ctx.strokeStyle = "rgba(0, 0, 0, 0.5)";
    ctx.lineWidth = roadWidth + 14;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    canvasPoints.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    if (trackClosed) ctx.closePath();
    ctx.stroke();

    // Helper per tracciare il percorso della pista
    const drawTrackPath = (closePath = trackClosed) => {
        ctx.beginPath();
        canvasPoints.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
        if (closePath) ctx.closePath();
    };

    // ============================================================
    // 3. BORDO BIANCO ESTERNO
    // ============================================================
    ctx.setLineDash([]);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
    ctx.lineWidth = roadWidth + 10;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    drawTrackPath();
    ctx.stroke();

    // ============================================================
    // 4. BORDO ROSSO INTERNO
    // ============================================================
    ctx.strokeStyle = "rgba(255, 68, 68, 0.95)";
    ctx.lineWidth = roadWidth + 7;
    drawTrackPath();
    ctx.stroke();

    // ============================================================
    // 5. ASFALTO (copre la parte centrale)
    // ============================================================
    ctx.strokeStyle = "#25282b";
    ctx.lineWidth = roadWidth;
    drawTrackPath();
    ctx.stroke();

    // ============================================================
    // 6. LINEA CENTRALE TRATTEGGIATA
    // ============================================================
    ctx.setLineDash([16, 20]);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
    ctx.lineWidth = 2;
    drawTrackPath();
    ctx.stroke();
    ctx.setLineDash([]);

    // ============================================================
    // 7. PONTI (sovrapposizioni del tracciato)
    // ============================================================
    drawTrackBridges(ctx, canvasPoints, roadWidth);

    // ============================================================
    // 8. LINEA START/FINISH
    // ============================================================
    const startSegment = getTrackSegment(0.035, w, h);
    const start = { x: startSegment.x, y: startSegment.y };
    const gateHalf = roadWidth / 2 + 5;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(start.x - startSegment.normalX * gateHalf, start.y - startSegment.normalY * gateHalf);
    ctx.lineTo(start.x + startSegment.normalX * gateHalf, start.y + startSegment.normalY * gateHalf);
    ctx.stroke();

    // Etichetta START/FINISH
    const labelSide = -1;
    const labelX = start.x + startSegment.normalX * labelSide * (gateHalf + 42) + startSegment.tangentX * 8;
    const labelY = start.y + startSegment.normalY * labelSide * (gateHalf + 42) + startSegment.tangentY * 8;
    ctx.font = "bold 11px 'Segoe UI', Arial";
    ctx.textAlign = "right";
    const titleText = "START/FINISH";
    const labelWidth = Math.max(ctx.measureText(titleText).width) + 14;
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(labelX - labelWidth + 7, labelY - 13, labelWidth, 32);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(titleText, labelX, labelY);
    ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
    ctx.font = "10px 'Segoe UI', Arial";
    ctx.fillText(" ", labelX, labelY + 14);
    ctx.textAlign = "left";

    // ---------- DISEGNO NOTE RALLY ----------
    if (showRallyNotes && rallyNotes && rallyNotes.length > 0) {
        rallyNotes.forEach(note => {
            let canvasPos;
            // Se la nota ha coordinate fisse (da file con x,y), usale direttamente
            if (note.fixed && note.x !== undefined && note.y !== undefined) {
                canvasPos = { x: note.x, y: note.y };
            } else if (note.t !== undefined) {
                // Altrimenti calcola la posizione in base alla frazione di giro
                const segment = getTrackSegment(note.t, w, h);
                canvasPos = { x: segment.x, y: segment.y };
            } else {
                return; // salta se non valida
            }

            ctx.save();

            // Colore in base al livello di pericolosità
            let color;
            const danger = note.danger || 1;
            if (danger <= 2) color = '#4caf50';      // verde
            else if (danger <= 3) color = '#ffaa00'; // arancione
            else color = '#ff1744';                  // rosso

            // Cerchio esterno con ombra
            ctx.shadowColor = 'rgba(0,0,0,0.5)';
            ctx.shadowBlur = 8;
            ctx.beginPath();
            ctx.arc(canvasPos.x, canvasPos.y, 8, 0, 2 * Math.PI);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.shadowBlur = 0;

            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.stroke();

            // Etichetta
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 10px "Segoe UI", Arial';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(note.note || '', canvasPos.x + 14, canvasPos.y - 6);

            // Velocità
            if (note.speed) {
                ctx.fillStyle = '#ffcc00';
                ctx.font = 'bold 9px "Segoe UI", Arial';
                ctx.fillText(`${note.speed} km/h`, canvasPos.x + 14, canvasPos.y + 12);
            }

            ctx.restore();
        });
    }

    // ============================================================
    // 9. EDITOR (se attivo) – disegna la bozza dei punti
    // ============================================================
    if (trackEditorEnabled) {
        const draftLayout = getTrackLayout(w, h, trackZoom);
        const draftCanvasPoints = trackDraftPoints.map(p => toCanvasPoint(p, draftLayout));
        ctx.save();
        ctx.setLineDash([8, 8]);
        ctx.strokeStyle = "rgba(0, 238, 255, 0.75)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        draftCanvasPoints.forEach((p, i) => {
            if (i === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
        draftCanvasPoints.forEach((p, i) => {
            ctx.beginPath();
            ctx.fillStyle = i === 0 ? "#00ff88" : "#00eef5";
            ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#ffffff";
            ctx.font = "bold 10px 'Segoe UI', Arial";
            ctx.textAlign = "center";
            ctx.fillText(String(i + 1), p.x, p.y - 9);
        });
        ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
        ctx.font = "11px 'Segoe UI', Arial";
        ctx.textAlign = "left";
        ctx.fillText("Click sul canvas per aggiungere punti. SAVE chiude il circuito.", 14, h - 14);
        ctx.restore();
    }

    ctx.restore();
}

/**
 * Disegna i ponti (sovrapposizioni) sul tracciato.
 * @param {CanvasRenderingContext2D} ctx - Contesto 2D.
 * @param {Array} canvasPoints - Punti del tracciato in coordinate canvas.
 * @param {number} roadWidth - Larghezza della strada in pixel.
 */
function drawTrackBridges(ctx, canvasPoints, roadWidth) {
    const crossings = getTrackCrossings(canvasPoints);
    if (!crossings.length) return;
    crossings.forEach((crossing) => {
        const p1 = canvasPoints[crossing.overIndex];
        const p2 = canvasPoints[crossing.overIndex + 1];
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const tx = dx / len;
        const ty = dy / len;
        const bridgeHalf = Math.max(20, roadWidth * 0.85);
        const startX = crossing.x - tx * bridgeHalf;
        const startY = crossing.y - ty * bridgeHalf;
        const endX = crossing.x + tx * bridgeHalf;
        const endY = crossing.y + ty * bridgeHalf;
        ctx.save();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.setLineDash([]);
        // Ombra del ponte
        ctx.strokeStyle = "rgba(0, 0, 0, 0.78)";
        ctx.lineWidth = roadWidth + 14;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        ctx.stroke();
        // Asfalto del ponte
        ctx.strokeStyle = "#25282b";
        ctx.lineWidth = roadWidth;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        ctx.stroke();
        // Bordo rosso
        ctx.strokeStyle = "rgba(255, 68, 68, 0.95)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        ctx.stroke();
        ctx.restore();
    });
}

/**
 * Trova le intersezioni tra i segmenti del tracciato (per individuare i ponti).
 * @param {Array} canvasPoints - Punti del tracciato in coordinate canvas.
 * @returns {Array} Array di oggetti intersezione.
 */
function getTrackCrossings(canvasPoints) {
    const crossings = [];
    const lastSegmentIndex = canvasPoints.length - 2;
    for (let i = 0; i < canvasPoints.length - 1; i++) {
        const a = canvasPoints[i];
        const b = canvasPoints[i + 1];
        for (let j = i + 2; j < canvasPoints.length - 1; j++) {
            const sharesClosingPoint = i === 0 && j === lastSegmentIndex;
            if (sharesClosingPoint) continue;
            const c = canvasPoints[j];
            const d = canvasPoints[j + 1];
            const hit = getLineIntersection(a, b, c, d);
            if (!hit) continue;
            crossings.push({
                x: hit.x, y: hit.y,
                underIndex: Math.min(i, j),
                overIndex: Math.max(i, j),
                tBySegment: { [i]: hit.t, [j]: hit.u }
            });
        }
    }
    return crossings;
}

/**
 * Determina se una vettura in una certa posizione lungo il tracciato
 * è nascosta da un ponte (per il disegno in profondità).
 * @param {number} lap - Frazione di giro.
 * @param {number} w - Larghezza canvas.
 * @param {number} h - Altezza canvas.
 * @returns {boolean} True se la vettura è sotto un ponte.
 */
function isCarHiddenByBridge(lap, w, h) {
    const canvasPoints = TRACK_POINTS.map(p => toCanvasPoint(p, getTrackLayout(w, h)));
    const crossings = getTrackCrossings(canvasPoints);
    const n = TRACK_POINTS.length - 1;
    let percentage = lap % 1.0;
    if (percentage < 0) percentage += 1.0;
    const scaledT = percentage * n;
    const segmentIndex = Math.min(Math.floor(scaledT), n - 1);
    const localT = scaledT - segmentIndex;
    return crossings.some((crossing) => {
        if (segmentIndex !== crossing.underIndex) return false;
        const crossingT = crossing.tBySegment[segmentIndex];
        if (crossingT === undefined) return false;
        return Math.abs(localT - crossingT) < 0.055;
    });
}

// =============================================================================
// 12. DISEGNO DELLE VETTURE, SCIE E GHOST CAR
// =============================================================================

/**
 * Disegna la scia (trail) di una vettura, con colori che variano in base all'accelerazione.
 * @param {CanvasRenderingContext2D} ctx - Contesto 2D.
 * @param {string} deviceId - ID della vettura.
 * @param {number} lateralScale - Scala pixel/metro per la larghezza della pista.
 */
function drawTelemetryTrail(ctx, deviceId, lateralScale) {
    const trail = carTrails[deviceId];
    if (!trail || trail.length < 2) return;

    const w = trackCanvas.width;
    const h = trackCanvas.height;
    const zoomFactor = trackZoom;

    const points = trail.map(p => {
        const pos = getCartesianCoordinates2D(p.lap, p.lateral_pos, w, h, zoomFactor, lateralScale);
        return {
            x: pos.x,
            y: pos.y,
            acc: p.acc
        };
    });

    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (let i = 1; i < points.length; i++) {
        const p1 = points[i - 1];
        const p2 = points[i];
        let r = 220, g = 220, b = 220;
        if (p2.acc > 1.0) { r = 0; g = 255; b = 136; }
        else if (p2.acc < -1.0) { r = 255; g = 68; b = 68; }
        const alpha = i / points.length;
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha * 0.6})`;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
    }
}

/**
 * Disegna una singola vettura sul canvas, con dettagli stilizzati
 * (carrozzeria, ruote, alettoni, numero, indicatore pit).
 * @param {CanvasRenderingContext2D} ctx - Contesto 2D.
 * @param {number} x - Coordinata x canvas.
 * @param {number} y - Coordinata y canvas.
 * @param {number} angle - Angolo di rotazione (radianti).
 * @param {string} color - Colore principale della vettura.
 * @param {boolean} highlighted - Se true, aggiunge bordo luminoso.
 * @param {boolean} isPit - Se true, mostra la croce rossa di pit.
 * @param {number} scaleFactor - Fattore di scala aggiuntivo.
 */
function drawCar(ctx, x, y, angle, color, highlighted, isPit = false, scaleFactor = 1.0) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    // Scala base moltiplicata per il fattore di zoom
    const baseScale = 0.85;
    const s = baseScale * scaleFactor;

    // --- 1. Carrozzeria principale (forma a "goccia" allungata) ---
    ctx.beginPath();
    ctx.moveTo(14 * s, 0);
    ctx.quadraticCurveTo(12 * s, -2.5 * s, 8 * s, -3 * s);
    ctx.quadraticCurveTo(4 * s, -3.5 * s, -2 * s, -3.5 * s);
    ctx.quadraticCurveTo(-6 * s, -3.5 * s, -10 * s, -3 * s);
    ctx.quadraticCurveTo(-12 * s, -2 * s, -13 * s, -0.5 * s);
    ctx.lineTo(-13 * s, 0.5 * s);
    ctx.quadraticCurveTo(-12 * s, 2 * s, -10 * s, 3 * s);
    ctx.quadraticCurveTo(-6 * s, 3.5 * s, -2 * s, 3.5 * s);
    ctx.quadraticCurveTo(4 * s, 3.5 * s, 8 * s, 3 * s);
    ctx.quadraticCurveTo(12 * s, 2.5 * s, 14 * s, 0);
    ctx.closePath();

    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = highlighted ? "rgba(255,255,255,0.6)" : "rgba(0,0,0,0.2)";
    ctx.lineWidth = highlighted ? 1.5 : 0.8;
    ctx.stroke();

    // --- 2. Muso anteriore ---
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.moveTo(14 * s, 0);
    ctx.quadraticCurveTo(13 * s, -1 * s, 11 * s, -1.5 * s);
    ctx.quadraticCurveTo(12 * s, 0, 11 * s, 1.5 * s);
    ctx.quadraticCurveTo(13 * s, 1 * s, 14 * s, 0);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;

    // --- 3. Alettone anteriore ---
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(12 * s, -1.2 * s);
    ctx.lineTo(13.5 * s, -3.5 * s);
    ctx.lineTo(14.5 * s, -3.5 * s);
    ctx.lineTo(13 * s, -1.5 * s);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(12 * s, 1.2 * s);
    ctx.lineTo(13.5 * s, 3.5 * s);
    ctx.lineTo(14.5 * s, 3.5 * s);
    ctx.lineTo(13 * s, 1.5 * s);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.fillRect(14 * s, -4 * s, 0.8 * s, 1 * s);
    ctx.fillRect(14 * s, 3 * s, 0.8 * s, 1 * s);
    ctx.globalAlpha = 1;

    // --- 4. Alettone posteriore ---
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(-11 * s, -2 * s);
    ctx.lineTo(-13 * s, -4.5 * s);
    ctx.lineTo(-14 * s, -4.5 * s);
    ctx.lineTo(-12.5 * s, -2.5 * s);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-11 * s, 2 * s);
    ctx.lineTo(-13 * s, 4.5 * s);
    ctx.lineTo(-14 * s, 4.5 * s);
    ctx.lineTo(-12.5 * s, 2.5 * s);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;

    // --- 5. Ruote (con ombra) ---
    ctx.shadowColor = 'rgba(0,0,0,0.15)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 1;

    const wheelPos = [
        { x: 6.5 * s, y: -3.8 * s, r: 2.4 * s },
        { x: 6.5 * s, y: 3.8 * s, r: 2.4 * s },
        { x: -3.5 * s, y: -4.2 * s, r: 2.6 * s },
        { x: -3.5 * s, y: 4.2 * s, r: 2.6 * s }
    ];

    wheelPos.forEach(w => {
        ctx.beginPath();
        ctx.arc(w.x, w.y, w.r, 0, Math.PI * 2);
        ctx.fillStyle = "#1a1a1a";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(w.x, w.y, w.r * 0.35, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(80,80,80,0.5)";
        ctx.fill();
        ctx.strokeStyle = "rgba(120,120,120,0.2)";
        ctx.lineWidth = 0.5;
        for (let i = 0; i < 4; i++) {
            const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
            ctx.beginPath();
            ctx.moveTo(w.x, w.y);
            ctx.lineTo(w.x + Math.cos(a) * w.r * 0.3, w.y + Math.sin(a) * w.r * 0.3);
            ctx.stroke();
        }
    });
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // --- 6. Abitacolo ---
    ctx.fillStyle = "rgba(255,255,255,0.15)";
    ctx.beginPath();
    ctx.ellipse(1.5 * s, 0, 2 * s, 3 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.1)";
    ctx.lineWidth = 0.5;
    ctx.stroke();

    // --- 7. Rollbar ---
    ctx.fillStyle = "rgba(255,255,255,0.1)";
    ctx.fillRect(-0.5 * s, -2.8 * s, 1 * s, 0.8 * s);

    // --- 8. Numero (simbolico) ---
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = `bold ${5 * scaleFactor}px 'Orbitron', Arial`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("1", 1.5 * s, 0);

    // --- 9. Indicatore pit stop (croce rossa) ---
    if (isPit) {
        ctx.fillStyle = "#e10600";
        ctx.globalAlpha = 0.8;
        ctx.font = `bold ${10 * scaleFactor}px Arial`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("✕", 1.5 * s, 0);
        ctx.globalAlpha = 1;
    }

    ctx.restore();
}

// =============================================================================
// 13. RENDER LOOP – Ciclo principale di animazione
// =============================================================================

/**
 * Ciclo di rendering chiamato ad ogni frame tramite requestAnimationFrame.
 * Gestisce il ridimensionamento del canvas, il calcolo del delta time,
 * l'aggiornamento delle posizioni delle vetture (dead reckoning), il disegno
 * della pista, delle scie, della ghost car e delle vetture.
 */
function renderLoop() {
    if (trackCanvas.width < 10 || trackCanvas.height < 10) {
        updateCanvasSize();
        requestAnimationFrame(renderLoop);
        return;
    }

    // --- Gestione canvas espanso ---
    if (trackExpanded) {
        const container = trackCanvas.parentElement;
        if (container) {
            const rect = container.getBoundingClientRect();
            const availableHeight = rect.height - 60;
            const targetHeight = Math.max(400, availableHeight);
            const currentWidth = trackCanvas.clientWidth;
            if (!canvasSizeUpdatePending &&
                (trackCanvas.height !== targetHeight || trackCanvas.width !== currentWidth)) {
                const now = Date.now();
                if (now - lastCanvasResize > 150) {
                    trackCanvas.width = currentWidth;
                    trackCanvas.height = targetHeight;
                    lastCanvasResize = now;
                    lastFrameTime = now;
                }
            }
        }
    }

    if (trackCanvas.width === 0 || trackCanvas.height === 0 || trackCanvas.width > 5000) {
        updateCanvasSize();
        requestAnimationFrame(renderLoop);
        return;
    }

    if (canvasSizeUpdatePending) {
        requestAnimationFrame(renderLoop);
        return;
    }

    const ctx = ctxTrack;
    const w = trackCanvas.width;
    const h = trackCanvas.height;
    const lateralScale = getLateralScale(w, h);
    const roadWidth = lateralScale * TRACK_WIDTH_METERS * trackZoom;
    const carScale = Math.max(0.2, Math.min(2.0, roadWidth / 30));

    const nowTimestamp = Date.now();
    let deltaTime = nowTimestamp - lastFrameTime;
    if (deltaTime > 1000) {
        deltaTime = 0;
        lastFrameTime = nowTimestamp;
    }
    lastFrameTime = nowTimestamp;
    const deltaTimeSeconds = Math.min(deltaTime / 1000, 0.004);

    // Calcolo FPS
    frameCount++;
    const nowPerf = performance.now();
    if (nowPerf - fpsLastTime >= 1000) {
        const fps = Math.round(frameCount * 1000 / (nowPerf - fpsLastTime));
        if (fpsDiv) fpsDiv.textContent = `${fps} FPS`;
        frameCount = 0;
        fpsLastTime = nowPerf;
    }

    drawTrack(ctx, w, h);

    // --- Follow mode: sposta la camera per seguire la vettura selezionata ---
    if (followMode && selectedDevice && clientRenderStates[selectedDevice]) {
        const cx = clientRenderStates[selectedDevice].x;
        const cy = clientRenderStates[selectedDevice].y;
        const layout = getTrackLayout(w, h);
        const scale = layout.scale;
        const deltaX = (w/2 - cx) / scale;
        const deltaY = (h/2 - cy) / scale;
        const smoothFactor = 0.06;
        panX += deltaX * smoothFactor;
        panY += deltaY * smoothFactor;
        trackNeedsRedraw = true;
    }

    // --- 1. Calcolo posizioni (dead reckoning) e disegno scie ---
    Object.keys(serverCarStates).forEach((carId) => {
        const targetState = serverCarStates[carId];
        if (!targetState) return;

        if (!clientRenderStates[carId]) {
            clientRenderStates[carId] = {
                lap: targetState.lap || 0,
                lateral_pos: targetState.lateral_pos || 0,
                x: 0, y: 0,
                speed: targetState.speed || 0,
                headingAngle: undefined,
                finished: false
            };
            const initialPos = getTrackPositionFromT(targetState.lap || 0, w, h);
            clientRenderStates[carId].x = initialPos.x;
            clientRenderStates[carId].y = initialPos.y;
        }

        const clientState = clientRenderStates[carId];
        let safeDelta = deltaTimeSeconds;
        if (isNaN(safeDelta) || safeDelta > 0.004 || safeDelta <= 0) safeDelta = 0.004;

        // Se è già arrivata, mantieni la posizione
        if (clientState.finished) {
            clientState.lap = 1.0;
            clientState.speed = 0;
            const currentPos = getCartesianCoordinates2D(clientState.lap, clientState.lateral_pos, w, h, trackZoom, lateralScale);
            clientState.x = currentPos.x;
            clientState.y = currentPos.y;
            return; // Salta il resto
        }

        // Se il backend dice che è arrivata (targetState.lap >= 1.0), fermala subito
        if (!trackClosed && targetState.lap >= 1.0) {
            clientState.finished = true;
            clientState.lap = 1.0;
            clientState.speed = 0;
            const currentPos = getCartesianCoordinates2D(clientState.lap, clientState.lateral_pos, w, h, trackZoom, lateralScale);
            clientState.x = currentPos.x;
            clientState.y = currentPos.y;
            return;
        }

        // Interpolazione velocità
        if (targetState.speed === 0) {
            clientState.speed = 0;
            clientState.lap = targetState.lap;
        } else {
            if (clientState.speed === undefined) clientState.speed = targetState.speed || 0;
            const speedBlend = 1 - Math.exp(-safeDelta * 4.0);
            clientState.speed += ((targetState.speed || 0) - clientState.speed) * speedBlend;
        }

        const speedMPS = clientState.speed / 3.6;

        // Avanzamento (solo se non è già finito e non è aperto con target >= 1)
        if (!trackClosed && clientState.lap >= 1.0) {
            clientState.finished = true;
            clientState.speed = 0;
            clientState.lap = 1.0;
        } else {
            if (trackLength > 0) {
                clientState.lap = (clientState.lap + (speedMPS * safeDelta) / trackLength);
                if (!trackClosed && clientState.lap >= 1.0) {
                    clientState.finished = true;
                    clientState.lap = 1.0;
                    clientState.speed = 0;
                }
            } else {
                clientState.lap = (clientState.lap + (speedMPS * safeDelta) / 2000);
                if (!trackClosed && clientState.lap >= 1.0) {
                    clientState.finished = true;
                    clientState.lap = 1.0;
                    clientState.speed = 0;
                }
            }
        }

        // Correzione drift (solo se non finito e non tracciato aperto con target già >=1)
        if (!clientState.finished) {
            let shouldSkipCorrection = false;
            if (!trackClosed && clientState.lap > 0.9 && targetState.lap < clientState.lap) {
                shouldSkipCorrection = true;
            }
            if (!shouldSkipCorrection) {
                let deltaLap = targetState.lap - clientState.lap;
                if (deltaLap < -0.5) deltaLap += 1.0;
                if (deltaLap > 0.5) deltaLap -= 1.0;
                if (targetState.speed > 0) {
                    const positionBlend = 1 - Math.exp(-safeDelta * 2.0);
                    clientState.lap = (clientState.lap + deltaLap * positionBlend) % 1.0;
                }
                if (clientState.lap < 0) clientState.lap += 1.0;
            }
        }

        // Posizione laterale
        const targetLateral = targetState.lateral_pos !== undefined ? targetState.lateral_pos : 0;
        if (clientState.lateral_pos === undefined) clientState.lateral_pos = targetLateral;
        const lateralDelta = targetLateral - clientState.lateral_pos;
        const maxLateralStep = 5.5 * safeDelta;
        clientState.lateral_pos += Math.max(-maxLateralStep, Math.min(maxLateralStep, lateralDelta));

        // Coordinate canvas
        const currentPos = getCartesianCoordinates2D(clientState.lap, clientState.lateral_pos, w, h, trackZoom, lateralScale);
        clientState.x = currentPos.x;
        clientState.y = currentPos.y;

        // Angolo
        const trackHeading = getTrackSegment(clientState.lap, w, h);
        const targetAngle = Math.atan2(trackHeading.tangentY, trackHeading.tangentX);
        if (clientState.headingAngle === undefined) {
            clientState.headingAngle = targetAngle;
        } else {
            clientState.headingAngle = smoothAngle(clientState.headingAngle, targetAngle, 0.18);
        }

        // Scia
        if (clientState.speed > 1) {
            if (!carTrails[carId]) carTrails[carId] = [];
            carTrails[carId].push({
                lap: clientState.lap,
                lateral_pos: clientState.lateral_pos,
                acc: targetState.acc
            });
            if (carTrails[carId].length > 35) carTrails[carId].shift();
        }
        drawTelemetryTrail(ctx, carId, lateralScale);
    });

    // --- 2. Ghost Car ---
    if (fastestLapState.device && fastestLapState.lapTime && fastestLapState.lapTime > 0) {
        let selectedCarProgress = 0;
        if (selectedDevice && serverCarStates[selectedDevice]) {
            selectedCarProgress = clientRenderStates[selectedDevice] ? clientRenderStates[selectedDevice].lap : serverCarStates[selectedDevice].lap;
        }

        if (ghostWaiting && selectedCarProgress < 0.15) {
            ghostWaiting = false;
            ghostLapProgress = 0.0;
        }

        if (!ghostWaiting && raceRunning) {
            ghostLapProgress += deltaTime / fastestLapState.lapTime;
            if (ghostLapProgress >= 1.0) {
                if (selectedCarProgress > 0.15) {
                    ghostWaiting = true;
                    ghostLapProgress = 0.999;
                } else {
                    ghostLapProgress = ghostLapProgress % 1.0;
                }
            }
        }

        const ghostPos = getTrackPositionFromT(ghostLapProgress, w, h);
        ctx.save();
        ctx.beginPath();
        ctx.fillStyle = ghostWaiting ? "rgba(255, 165, 0, 0.3)" : "rgba(0, 238, 255, 0.25)";
        ctx.shadowColor = ghostWaiting ? "#ffa500" : "#00eef5";
        ctx.shadowBlur = 6;
        ctx.arc(ghostPos.x, ghostPos.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
        ctx.font = "italic 8px 'Segoe UI', Arial";
        ctx.textAlign = "center";
        const labelText = ghostWaiting ? "⏳ GHOST WAITING" : "👻 GHOST";
        ctx.fillText(labelText, ghostPos.x, ghostPos.y - 10);
        ctx.restore();
    } else {
        ghostLapProgress = 0.0;
        ghostWaiting = false;
    }

    // --- 3. Disegno delle vetture ---
    Object.keys(serverCarStates).forEach((id) => {
        const clientState = clientRenderStates[id];
        const targetState = serverCarStates[id];
        if (!clientState || !targetState) return;

        const isSelected = id === selectedDevice;
        ctx.save();
        const now = Date.now();
        const isFastestActive = (id === fastestLapState.device) && (now - fastestLapState.timestamp < 10000);
        if (isFastestActive) {
            const pulse = 10 + Math.sin(now / 100) * 5;
            ctx.shadowBlur = pulse;
            ctx.shadowColor = "#ff00ff";
        }

        const pos2d = { x: clientState.x, y: clientState.y };

        let color;
        if (isSelected) color = "#0055ff";
        else if (targetState.rank === 0) color = "#ff4444";
        else if (targetState.rank === 1) color = "#ffcc00";
        else if (targetState.rank === 2) color = "#00ff88";
        else color = "#FF0050";

        const angle = clientState.headingAngle ?? 0;

        if (isCarHiddenByBridge(clientState.lap, w, h)) {
            ctx.restore();
            return;
        }

        drawCar(ctx, pos2d.x, pos2d.y, angle, color, isSelected || targetState.rank <= 2, targetState.in_pit, carScale);

        // Etichetta della vettura
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 10px 'Segoe UI', Arial";
        ctx.textAlign = "center";
        let labelText = targetState.label;
        if (targetState.rank === 0) labelText = "👑 " + labelText;
        if (isFastestActive) labelText = "⏱️ " + labelText;
        if (clientState.finished) labelText += " 🏁";
        ctx.fillText(labelText, pos2d.x, pos2d.y - 12);
        ctx.restore();
    });

    requestAnimationFrame(renderLoop);
}

// =============================================================================
// 14. DRAG DELLA PISTA (pan) e FOLLOW MODE
// =============================================================================

/** Evento mousedown sul canvas: avvia il trascinamento (pan) */
trackCanvas.addEventListener('mousedown', (e) => {
    if (trackEditorEnabled) return;
    if (e.target.closest('button')) return;

    // Se followMode è attivo, disattivalo quando l'utente trascina
    if (followMode) {
        followMode = false;
        const btn = document.getElementById("followBtn");
        if (btn) {
            btn.classList.remove("active");
            btn.innerText = "🎯 Follow";
        }
    }

    isDragging = true;
    const rect = trackCanvas.getBoundingClientRect();
    dragStartX = e.clientX - rect.left;
    dragStartY = e.clientY - rect.top;
    panStartX = panX;
    panStartY = panY;
    trackCanvas.style.cursor = 'grabbing';
});

/** Evento mousemove globale: aggiorna il pan durante il drag */
document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const rect = trackCanvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const dx = mouseX - dragStartX;
    const dy = mouseY - dragStartY;

    const layout = getTrackLayout(trackCanvas.width, trackCanvas.height);
    const scale = layout.scale;

    panX = panStartX + dx / scale;
    panY = panStartY + dy / scale;
});

/** Evento mouseup globale: termina il drag */
document.addEventListener('mouseup', () => {
    if (isDragging) {
        isDragging = false;
        trackCanvas.style.cursor = 'default';
        trackNeedsRedraw = true;
    }
});

/** Doppio click sul canvas: resetta il pan (centra la pista) */
trackCanvas.addEventListener('dblclick', () => {
    panX = 0;
    panY = 0;
});

// =============================================================================
// 15. EDITOR DEL TRACCIATO
// =============================================================================

/**
 * Restituisce le coordinate del punto cliccato sul canvas in pixel (locali).
 */
function getCanvasLocalPoint(event) {
    const rect = trackCanvas.getBoundingClientRect();
    const scaleX = trackCanvas.width / rect.width;
    const scaleY = trackCanvas.height / rect.height;
    return {
        x: (event.clientX - rect.left) * scaleX,
        y: (event.clientY - rect.top) * scaleY
    };
}

/**
 * Converte un punto canvas in un punto del tracciato (coordinate assolute).
 */
function canvasPointToTrackPoint(canvasPoint, w, h, layout) {
    if (!layout) layout = getTrackLayout(w, h);
    return [
        (canvasPoint.x - layout.offsetX) / layout.scale + layout.minX,
        layout.maxY - (canvasPoint.y - layout.offsetY) / layout.scale
    ];
}

/** Attiva/disattiva la modalità editor del tracciato */
function toggleTrackEditor() {
    trackEditorEnabled = !trackEditorEnabled;
    trackDraftPoints = trackEditorEnabled ? [] : trackDraftPoints;
    const btn = document.getElementById("trackEditorToggle");
    if (btn) {
        btn.classList.toggle("active", trackEditorEnabled);
        btn.innerText = trackEditorEnabled ? "EDITING TRACK" : "EDIT TRACK";
    }
}

/** Annulla l'ultimo punto inserito nell'editor */
function undoTrackPoint() {
    if (!trackEditorEnabled) return;
    trackDraftPoints.pop();
}

/** Salva il tracciato editato e lo applica */
function saveEditedTrack() {
    if (trackDraftPoints.length < 3) {
        alert("Aggiungi almeno 3 punti per creare un tracciato.");
        return;
    }
    const normalized = normalizePoints(trackDraftPoints);
    const closedNormalized = [...normalized, [...normalized[0]]];
    localStorage.setItem(TRACK_STORAGE_KEY, JSON.stringify(closedNormalized));
    TRACK_POINTS = closedNormalized.map(p => [p[0] * TRACK_SCALE, p[1] * TRACK_SCALE]);
    trackEditorEnabled = false;
    trackDraftPoints = [];
    resetTrackRenderState();
    trackZoom = 1.0;
    panX = 0;
    panY = 0;
    const btn = document.getElementById("trackEditorToggle");
    if (btn) {
        btn.classList.remove("active");
        btn.innerText = "EDIT TRACK";
    }
}

/** Ripristina il tracciato di default */
function resetEditedTrack() {
    if (!confirm("Ripristinare il tracciato di default?")) return;
    localStorage.removeItem(TRACK_STORAGE_KEY);
    const normalized = normalizePoints(DEFAULT_TRACK_POINTS);
    TRACK_POINTS = normalized.map(p => [p[0] * TRACK_SCALE, p[1] * TRACK_SCALE]);
    trackDraftPoints = [];
    trackEditorEnabled = false;
    resetTrackRenderState();
    trackZoom = 1.0;
    panX = 0;
    panY = 0;
    const btn = document.getElementById("trackEditorToggle");
    if (btn) {
        btn.classList.remove("active");
        btn.innerText = "EDIT TRACK";
    }
}

/** Gestisce il click sul canvas in modalità editor: aggiunge un punto alla bozza */
function handleTrackCanvasClick(event) {
    if (!trackEditorEnabled) return;
    const canvasPoint = getCanvasLocalPoint(event);
    const w = trackCanvas.width;
    const h = trackCanvas.height;
    const layout = getTrackLayout(w, h, trackZoom);
    const trackPoint = canvasPointToTrackPoint(canvasPoint, w, h, layout);
    trackDraftPoints.push(trackPoint);
    trackNeedsRedraw = true;
}

/** Mostra/nasconde il pannello dei controlli dell'editor */
function setTrackEditorPanelVisible(visible) {
    const controls = document.getElementById("trackEditorControls");
    const editorBtn = document.getElementById("toggleTrackPanel");
    if (!controls || !editorBtn) return;
    controls.hidden = !visible;
    editorBtn.classList.toggle("active", visible);
    if (!visible && trackEditorEnabled) toggleTrackEditor();
}

/** Installa i listener per i pulsanti dell'editor */
function installTrackEditorControls() {
    const controls = document.getElementById("trackEditorControls");
    const editorBtn = document.getElementById("toggleTrackPanel");
    const editBtn = document.getElementById("trackEditorToggle");
    const undoBtn = document.getElementById("undoTrackPointBtn");
    const saveBtn = document.getElementById("saveEditedTrackBtn");
    const resetBtn = document.getElementById("resetEditedTrackBtn");

    if (!trackCanvas || !controls || !editorBtn || !editBtn || !undoBtn || !saveBtn || !resetBtn) return;

    controls.hidden = true;

    editorBtn.addEventListener("click", () => {
        setTrackEditorPanelVisible(controls.hidden);
    });

    editBtn.addEventListener("click", toggleTrackEditor);
    undoBtn.addEventListener("click", undoTrackPoint);
    saveBtn.addEventListener("click", saveEditedTrack);
    resetBtn.addEventListener("click", resetEditedTrack);

    trackCanvas.addEventListener("click", handleTrackCanvasClick);
}

// =============================================================================
// 16. PICTURE-IN-PICTURE (PiP) – Widget galleggianti per i grafici
// =============================================================================

/**
 * Crea o restituisce il canvas per un widget PiP di un dato tipo.
 * Se non esiste, crea il wrapper completo con header, valore, canvas e handle di resize.
 * @param {string} type - 'speed', 'acc', 'compare', 'radar'.
 * @returns {HTMLCanvasElement|null} Il canvas del widget.
 */
function getPipCanvas(type) {
    const container = document.getElementById(PIP_CONTAINER_ID);
    if (!container) return null;
    const existing = container.querySelector(`.pip-canvas[data-type="${type}"]`);
    if (existing) return existing;

    const wrapper = document.createElement('div');
    wrapper.className = 'pip-item';
    wrapper.dataset.type = type;

    const size = pipSizes[type] || { width: 300, height: 170 };
    wrapper.style.width = size.width + 'px';
    wrapper.style.height = size.height + 'px';

    // Header con titolo e valore numerico
    const header = document.createElement('div');
    header.className = 'pip-header';

    const title = document.createElement('span');
    title.className = 'pip-title';
    const icon = document.createElement('span');
    icon.className = 'pip-icon';
    const titleText = document.createElement('span');

    switch(type) {
        case 'speed': icon.textContent = '📈'; titleText.textContent = 'Speed'; break;
        case 'acc': icon.textContent = '📉'; titleText.textContent = 'G-Force'; break;
        case 'compare': icon.textContent = '🏁'; titleText.textContent = 'Gap'; break;
        case 'radar': icon.textContent = '🎯'; titleText.textContent = 'Profile'; break;
    }
    title.appendChild(icon);
    title.appendChild(titleText);

    const value = document.createElement('span');
    value.className = 'pip-value';
    if (type === 'acc') value.classList.add('acc');
    value.textContent = '--';

    header.appendChild(title);
    header.appendChild(value);

    // Canvas per il grafico
    const canvas = document.createElement('canvas');
    canvas.className = 'pip-canvas';
    canvas.dataset.type = type;
    const headerHeight = 28;
    const padding = 8;
    canvas.width = size.width;
    canvas.height = size.height - headerHeight - padding;
    canvas.style.width = '100%';
    canvas.style.height = `calc(100% - ${headerHeight}px - ${padding}px)`;

    // Pulsante chiudi
    const closeBtn = document.createElement('button');
    closeBtn.className = 'pip-close';
    closeBtn.innerHTML = '✕';
    closeBtn.title = 'Rimuovi grafico';
    closeBtn.onclick = () => togglePip(type);

    // Handle di resize (angolo inferiore destro)
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'pip-resize-handle';
    resizeHandle.title = 'Trascina per ridimensionare';
    resizeHandle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        startResize(type, e);
    });

    wrapper.appendChild(header);
    wrapper.appendChild(canvas);
    wrapper.appendChild(closeBtn);
    wrapper.appendChild(resizeHandle);
    container.appendChild(wrapper);

    wrapper._valueElement = value;
    wrapper._type = type;

    // Posizionamento iniziale a cascata
    const existingWidgets = container.querySelectorAll('.pip-item');
    const offset = (existingWidgets.length - 1) * 30;
    wrapper.style.left = offset + 'px';
    wrapper.style.top = offset + 'px';
    makeDraggable(wrapper);

    return canvas;
}

/** Avvia il ridimensionamento del widget PiP */
function startResize(type, e) {
    const wrapper = document.querySelector(`.pip-item[data-type="${type}"]`);
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    resizeData = {
        type: type,
        startX: e.clientX,
        startY: e.clientY,
        startWidth: rect.width,
        startHeight: rect.height,
        wrapper: wrapper
    };
    document.addEventListener('mousemove', onResizeMove);
    document.addEventListener('mouseup', onResizeEnd);
    wrapper.style.userSelect = 'none';
}

/** Muove l'handle di resize e aggiorna il grafico */
function onResizeMove(e) {
    if (!resizeData) return;
    const { type, startX, startY, startWidth, startHeight, wrapper } = resizeData;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    let newWidth = Math.min(600, Math.max(200, startWidth + dx));
    let newHeight = Math.min(400, Math.max(120, startHeight + dy));
    wrapper.style.width = newWidth + 'px';
    wrapper.style.height = newHeight + 'px';
    pipSizes[type] = { width: newWidth, height: newHeight };

    const canvas = wrapper.querySelector('.pip-canvas');
    if (canvas) {
        const headerHeight = 28;
        const padding = 8;
        canvas.width = newWidth;
        canvas.height = newHeight - headerHeight - padding;
        const chart = pipCharts[type];
        if (chart) {
            chart.resize();
            chart.update('none');
        }
    }
}

/** Termina il resize */
function onResizeEnd(e) {
    if (resizeData) {
        resizeData.wrapper.style.userSelect = '';
        resizeData = null;
    }
    document.removeEventListener('mousemove', onResizeMove);
    document.removeEventListener('mouseup', onResizeEnd);
}

/**
 * Crea un grafico Chart.js all'interno del widget PiP.
 * @param {string} type - Tipo di grafico.
 */
function createPipChart(type) {
    if (pipCharts[type]) return;
    const canvas = getPipCanvas(type);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let chart = null;

    switch(type) {
        case 'speed':
            chart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: Array.from({ length: 50 }, (_, i) => i),
                    datasets: [{
                        label: 'Speed km/h',
                        data: speedBuffer.length ? speedBuffer : Array(50).fill(0),
                        borderColor: '#4a9eff',
                        backgroundColor: 'rgba(74, 158, 255, 0.15)',
                        borderWidth: 3,
                        fill: true,
                        tension: 0.4,
                        pointRadius: 2
                    }]
                },
                options: {
                    animation: { duration: 100, easing: 'easeOutQuart' },
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: { x: { display: false }, y: { display: false, beginAtZero: true } }
                }
            });
            break;
        case 'acc':
            chart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: Array.from({ length: 50 }, (_, i) => i),
                    datasets: [{
                        label: 'AccX',
                        data: accBuffer.length ? accBuffer : Array(50).fill(0),
                        borderColor: '#ff3b30',
                        backgroundColor: 'rgba(255, 59, 48, 0.15)',
                        borderWidth: 3,
                        fill: true,
                        tension: 0.4,
                        pointRadius: 2
                    }]
                },
                options: {
                    animation: { duration: 100, easing: 'easeOutQuart' },
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: { x: { display: false }, y: { display: false, beginAtZero: true } }
                }
            });
            break;
        case 'compare':
            chart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: compareChart ? compareChart.data.labels : [],
                    datasets: [{
                        label: 'Gap',
                        data: compareChart ? compareChart.data.datasets[0].data : [],
                        backgroundColor: compareChart ? compareChart.data.datasets[0].backgroundColor : []
                    }]
                },
                options: {
                    animation: { duration: 300, easing: 'easeOutCubic' },
                    responsive: true,
                    maintainAspectRatio: false,
                    indexAxis: 'y',
                    plugins: { legend: { display: false } },
                    scales: { x: { display: false }, y: { display: false } }
                }
            });
            break;
        case 'radar':
            chart = new Chart(ctx, {
                type: 'radar',
                data: {
                    labels: ['Driver Skill', 'Engine Power', 'Tyre Life', 'Top Speed', 'Brake Bias'],
                    datasets: [{
                        label: 'Car Spec Profile',
                        data: radarChart ? radarChart.data.datasets[0].data : [0, 0, 0, 0, 0],
                        borderColor: '#ff7b00',
                        backgroundColor: 'rgba(255, 123, 0, 0.08)',
                        pointBackgroundColor: '#4a9eff',
                        borderWidth: 2,
                        pointBorderColor: '#fff',
                        pointRadius: 3
                    }]
                },
                options: {
                    animation: { duration: 200, easing: 'easeOutQuart' },
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        r: {
                            angleLines: { color: 'rgba(255, 255, 255, 0.1)' },
                            grid: { color: 'rgba(255, 255, 255, 0.1)' },
                            pointLabels: {
                                color: '#eaeaea',
                                font: { size: 9, family: 'Rajdhani' },
                                padding: 6
                            },
                            ticks: { display: false, stepSize: 25 },
                            suggestedMin: 0,
                            suggestedMax: 100
                        }
                    }
                }
            });
            break;
    }

    if (chart) {
        pipCharts[type] = chart;
        pipActive[type] = true;
        updatePipControlButtons();
    }
}

/** Distrugge un widget PiP e lo rimuove dal DOM */
function destroyPipChart(type) {
    if (pipCharts[type]) {
        pipCharts[type].destroy();
        pipCharts[type] = null;
    }
    const container = document.getElementById(PIP_CONTAINER_ID);
    if (container) {
        const wrapper = container.querySelector(`.pip-item[data-type="${type}"]`);
        if (wrapper) wrapper.remove();
    }
    pipActive[type] = false;
    updatePipControlButtons();
}

/** Attiva/disattiva un widget PiP */
function togglePip(type) {
    if (pipActive[type]) {
        destroyPipChart(type);
    } else {
        createPipChart(type);
    }
}

/** Aggiorna lo stato dei pulsanti di controllo PiP (attivo/inattivo) */
function updatePipControlButtons() {
    document.querySelectorAll('.pip-toggle-btn').forEach(btn => {
        const type = btn.dataset.type;
        btn.classList.toggle('active', pipActive[type]);
    });
}

/** Rende un widget PiP trascinabile */
function makeDraggable(element) {
    let isDragging = false;
    let startX, startY;

    function onMouseDown(e) {
        if (e.target.closest('.pip-close')) return;
        if (e.target.closest('.pip-resize-handle')) return;
        isDragging = true;
        const rect = element.getBoundingClientRect();
        startX = e.clientX - rect.left;
        startY = e.clientY - rect.top;
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        e.preventDefault();
    }

    function onMouseMove(e) {
        if (!isDragging) return;
        let newLeft = e.clientX - startX;
        let newTop = e.clientY - startY;
        const maxLeft = window.innerWidth - element.offsetWidth;
        const maxTop = window.innerHeight - element.offsetHeight;
        newLeft = Math.max(0, Math.min(maxLeft, newLeft));
        newTop = Math.max(0, Math.min(maxTop, newTop));
        element.style.left = newLeft + 'px';
        element.style.top = newTop + 'px';
    }

    function onMouseUp() {
        isDragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
    }

    element.addEventListener('mousedown', onMouseDown);
}

// =============================================================================
// 17. GRAFICI CHART.JS (MAIN) – Inizializzazione dei quattro grafici principali
// =============================================================================

/**
 * Inizializza i grafici principali (speed, acc, comparison, radar)
 * e li assegna alle variabili globali.
 */
function createCharts() {
    const labels = Array.from({ length: 50 }, (_, i) => i);

    // Helper per creare gradienti in modo sicuro (se il canvas non è ancora renderizzato)
    function safeGradient(ctx, canvas, color1, color2) {
        try {
            const w = canvas.width || 300;
            const h = canvas.height || 200;
            const grad = ctx.createLinearGradient(0, 0, 0, h);
            grad.addColorStop(0, color1);
            grad.addColorStop(0.5, color2);
            grad.addColorStop(1, 'rgba(0,0,0,0)');
            return grad;
        } catch (e) {
            return color1.replace('0.8', '0.3');
        }
    }

    // Grafico Speed
    const speedCanvas = document.getElementById('speedChart');
    const speedCtx = speedCanvas.getContext('2d');
    setTimeout(() => {
        const grad = safeGradient(speedCtx, speedCanvas, 'rgba(0, 255, 136, 0.8)', 'rgba(0, 200, 100, 0.4)');
        speedChart = new Chart(speedCanvas, {
            type: "line",
            data: {
                labels: labels,
                datasets: [{
                    label: "Speed km/h",
                    data: Array(50).fill(0),
                    borderColor: '#00ff88',
                    backgroundColor: grad,
                    borderWidth: 2,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0,
                    pointHoverRadius: 6,
                    pointHoverBackgroundColor: '#00ff88',
                    pointHoverBorderColor: '#fff',
                }]
            },
            options: {
                animation: { duration: 100, easing: 'easeOutQuart' },
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    datalabels: { display: false }
                },
                scales: {
                    x: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: 'rgba(255,255,255,0.3)', font: { size: 8 } } },
                    y: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: 'rgba(255,255,255,0.3)', font: { size: 8 } }, beginAtZero: true }
                }
            }
        });
    }, 50);

    // Grafico Accelerazione
    const accCanvas = document.getElementById('accChart');
    const accCtx = accCanvas.getContext('2d');
    setTimeout(() => {
        const grad = safeGradient(accCtx, accCanvas, 'rgba(255, 0, 76, 0.8)', 'rgba(200, 0, 50, 0.4)');
        accChart = new Chart(accCanvas, {
            type: "line",
            data: {
                labels: labels,
                datasets: [{
                    label: "AccX",
                    data: Array(50).fill(0),
                    borderColor: '#ff004c',
                    backgroundColor: grad,
                    borderWidth: 2,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0,
                    pointHoverRadius: 6,
                    pointHoverBackgroundColor: '#ff004c',
                    pointHoverBorderColor: '#fff',
                }]
            },
            options: {
                animation: { duration: 100, easing: 'easeOutQuart' },
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    datalabels: { display: false }
                },
                scales: {
                    x: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: 'rgba(255,255,255,0.3)', font: { size: 8 } } },
                    y: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: 'rgba(255,255,255,0.3)', font: { size: 8 } }, beginAtZero: true }
                }
            }
        });
    }, 50);

    // Grafico Comparison (barre orizzontali) – versione migliorata
    compareChart = new Chart(document.getElementById("compareChart"), {
        type: "bar",
        data: {
            labels: [],
            datasets: [{
                label: "Gap to Leader (m)",
                data: [],
                backgroundColor: [],
                borderColor: [],
                borderWidth: 2,
                borderRadius: 6,
                barPercentage: 0.7,
                categoryPercentage: 0.8,
            }]
        },
        options: {
            animation: {
                duration: 600,
                easing: 'easeOutQuart',
            },
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: 'rgba(18, 18, 18, 0.92)',
                    titleColor: '#fff',
                    bodyColor: '#e8e8ea',
                    borderColor: 'rgba(74, 158, 255, 0.15)',
                    borderWidth: 1,
                    cornerRadius: 10,
                    padding: 10,
                    titleFont: { family: 'Rajdhani', weight: '700', size: 13 },
                    bodyFont: { family: 'Rajdhani', size: 12 },
                    callbacks: {
                        label: function(context) {
                            const value = context.parsed.x;
                            if (value === 0) return '🏆 Leader';
                            return `${value.toFixed(1)} m`;
                        }
                    }
                },
                datalabels: {
                    display: true,
                    color: function(context) {
                        const value = context.dataset.data[context.dataIndex];
                        return value === 0 ? '#ffd700' : 'rgba(255,255,255,0.7)';
                    },
                    font: function(context) {
                        const value = context.dataset.data[context.dataIndex];
                        return {
                            weight: value === 0 ? '900' : '600',
                            size: value === 0 ? 14 : 12,
                            family: 'Rajdhani'
                        };
                    },
                    anchor: 'end',
                    align: 'end',
                    offset: 4,
                    formatter: function(value) {
                        if (value === 0) return '🏆 LEADER';
                        return `${Math.round(value)}m`;
                    },
                    backgroundColor: 'rgba(0,0,0,0.3)',
                    borderRadius: 4,
                    padding: { top: 2, bottom: 2, left: 6, right: 6 }
                }
            },
            scales: {
                x: {
                    grid: {
                        color: 'rgba(255,255,255,0.04)',
                        drawBorder: false,
                    },
                    ticks: {
                        color: 'rgba(255,255,255,0.4)',
                        font: { size: 9, family: 'Rajdhani' },
                        stepSize: 10,
                    },
                    title: {
                        display: true,
                        text: "Distanza dal leader (metri)",
                        color: 'rgba(255,255,255,0.4)',
                        font: { size: 10, family: 'Rajdhani', weight: '600' },
                    },
                    max: undefined,
                },
                y: {
                    grid: {
                        display: false
                    },
                    ticks: {
                        color: 'rgba(255,255,255,0.6)',
                        font: { size: 11, family: 'Rajdhani', weight: '600' },
                        padding: 8,
                    },
                    border: {
                        display: false
                    }
                }
            },
            hover: {
                mode: 'index',
                intersect: true,
                animationDuration: 200,
            },
            interaction: {
                mode: 'nearest',
                intersect: true,
            },
            layout: {
                padding: {
                    top: 20,
                    bottom: 10,
                    left: 5,
                    right: 70
                }
            }
        },
        plugins: [ChartDataLabels]
    });

    // Grafico Radar
    const ctxRadar = document.getElementById('radarChart').getContext('2d');
    radarChart = new Chart(ctxRadar, {
        type: 'radar',
        data: {
            labels: ['Driver Skill', 'Engine Power', 'Tyre Life', 'Top Speed', 'Brake Bias'],
            datasets: [{
                label: 'Car Spec Profile',
                data: [0, 0, 0, 0, 0],
                backgroundColor: 'rgba(255, 0, 80, 0.15)',
                borderColor: '#FF0050',
                borderWidth: 2,
                pointBackgroundColor: '#00ff88',
                pointBorderColor: '#fff',
                pointRadius: 4
            }]
        },
        options: {
            animation: { duration: 200, easing: 'easeOutQuart' },
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                datalabels: { display: false }
            },
            scales: {
                r: {
                    angleLines: { color: 'rgba(255, 255, 255, 0.1)' },
                    grid: { color: 'rgba(255, 255, 255, 0.1)' },
                    pointLabels: { color: '#eaeaea', font: { size: 11, family: 'Rajdhani' } },
                    ticks: { display: false },
                    suggestedMin: 0,
                    suggestedMax: 100
                }
            }
        }
    });
}

// =============================================================================
// 18. COMUNICAZIONE REST (Devices, Race, AI)
// =============================================================================

/**
 * Carica la lista dei dispositivi dal backend e popola la select.
 */
async function loadDevices() {
    try {
        const res = await fetch(`${BACKEND_URL}/devices`);
        const data = await res.json();
        const sel = document.getElementById("deviceSelect");
        sel.innerHTML = "";
        data.devices.forEach(d => {
            const opt = document.createElement("option");
            opt.value = d;
            opt.innerText = d;
            sel.appendChild(opt);
        });
        if (data.devices.length > 0) {
            selectedDevice = selectedDevice || data.devices[0];
            sel.value = selectedDevice;
        }
    } catch (e) {
        // Silenzioso – la select rimarrà vuota
    }
}

/** Cambia la vettura selezionata e resetta i buffer e il ghost */
function changeDevice() {
    selectedDevice = document.getElementById("deviceSelect").value;
    ghostLapProgress = 0.0;
    ghostWaiting = false;
    speedBuffer = [];
    accBuffer = [];
    updateChartsUI();
    updateRadar();
}

/**
 * Rimuove la vettura selezionata dal backend e dallo stato locale.
 */
async function removeSelectedDevice() {
    if (!selectedDevice) {
        alert("Nessuna vettura selezionata da eliminare.");
        return;
    }
    // Reset del delta time per evitare salti
    lastFrameTime = Date.now();

    const btn = document.querySelector(".topbar-btn.danger");
    if (btn) btn.classList.add("loading");
    try {
        const res = await fetch(`${BACKEND_URL}/remove_device`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ device_id: selectedDevice })
        });
        const data = await res.json();
        if (res.ok && data.ok) {
            const idToRemove = selectedDevice;
            delete serverCarStates[idToRemove];
            delete clientRenderStates[idToRemove];
            delete carTrails[idToRemove];
            if (fastestLapState.device === idToRemove) {
                fastestLapState.device = null;
                fastestLapState.lapTime = null;
                ghostLapProgress = 0.0;
                ghostWaiting = false;
            }
            selectedDevice = null;
            await loadDevices();
            updateCanvasSize();
        } else {
            alert("Errore durante l'eliminazione del dispositivo sul server.");
        }
    } catch (err) {
        alert("Impossibile raggiungere il backend per eliminare la vettura.");
    } finally {
        if (btn) btn.classList.remove("loading");
    }
}

/** Avvia o ferma la gara (start/stop) */
async function toggleRace() {
    const btn = document.getElementById("startStopBtn");
    if (!btn) return;
    btn.classList.add("loading");
    try {
        if (raceRunning) {
            const res = await fetch(`${BACKEND_URL}/race/stop`, { method: "POST" });
            const data = await res.json();
            if (data.ok) {
                raceRunning = false;
                updateStartButton();
            }
        } else {
            const res = await fetch(`${BACKEND_URL}/race/resume`, { method: "POST" });
            const data = await res.json();
            if (data.ok) {
                raceRunning = true;
                updateStartButton();
            }
        }
    } catch (e) {
        // Errore silenzioso
    } finally {
        btn.classList.remove("loading");
    }
}

/** Resetta la gara (restart e stop) */
async function resetRace() {
    const btn = document.getElementById("resetBtn");
    if (!btn) return;
    btn.classList.add("loading");
    try {
        // Resetta il backend
        await fetch(`${BACKEND_URL}/race/restart`, { method: "POST" });
        await fetch(`${BACKEND_URL}/race/stop`, { method: "POST" });

        // Aggiorna lo stato locale
        raceRunning = false;
        updateStartButton();

        // Resetta lo stato delle vetture
        fastestLapState.device = null;
        fastestLapState.lapTime = null;
        ghostLapProgress = 0.0;
        ghostWaiting = false;

        // Svuota completamente gli stati client e server
        clientRenderStates = {};
        carTrails = {};
        serverCarStates = {};
        speedBuffer = [];
        accBuffer = [];

        // Forza l'aggiornamento dei grafici e del timer
        updateChartsUI();
        updateLapTimerUI();

        // Forza il ridisegno del canvas
        trackNeedsRedraw = true;
        updateCanvasSize();

        // Resetta la posizione della camera (pan) e lo zoom
        panX = 0;
        panY = 0;
        trackZoom = 1.0;

    } catch (e) {
        // Errore silenzioso
    } finally {
        btn.classList.remove("loading");
    }
}

/** Aggiorna il testo e lo stato del pulsante start/stop */
function updateStartButton() {
    const btn = document.getElementById("startStopBtn");
    if (btn) {
        btn.innerText = raceRunning ? "STOP" : "START";
        btn.classList.toggle("active", raceRunning);
    }
}

/** Recupera lo stato della gara dal backend */
async function fetchRaceStatus() {
    try {
        const res = await fetch(`${BACKEND_URL}/race/status`);
        const data = await res.json();
        raceRunning = data.running;
        updateStartButton();
    } catch (e) {
        // Silenzioso
    }
}

/** Invia una domanda all'assistente AI e mostra la risposta */
async function askAI() {
    const input = document.getElementById("question");
    const q = input.value.trim();
    if (!q) return;
    const btn = document.querySelector(".ai-panel button");
    const aiBox = document.getElementById("aiBox");
    const msgText = aiBox.querySelector(".ai-msg-text");
    const msgIcon = aiBox.querySelector(".ai-msg-icon");

    input.value = "";
    btn.classList.add("sending");
    btn.disabled = true;

    aiBox.classList.add("thinking");
    msgIcon.textContent = "⚡";
    msgText.textContent = "Analyzing telemetry data";

    try {
        const res = await fetch(`${BACKEND_URL}/ask_ai`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question: q })
        });
        const data = await res.json();
        let answer = null;
        if (typeof data === "string") {
            answer = data;
        } else if (data) {
            answer = data.answer || data.result || data.message || data.response || data.output || data.text;
        }
        if (!answer) {
            aiBox.innerText = "❌ No valid response from AI";
            return;
        }
        aiBox.classList.remove("thinking");
        msgIcon.textContent = "🧠";
        msgText.textContent = answer;
    } catch (err) {
        aiBox.classList.remove("thinking");
        aiBox.innerText = "❌ AI error - backend not reachable";
    } finally {
        btn.classList.remove("sending");
        btn.disabled = false;
    }
}

// =============================================================================
// 19. UTILITY UI – Ridimensionamento canvas, pulsanti, ecc.
// =============================================================================

/** Variabili per evitare aggiornamenti troppo frequenti del canvas */
let lastCanvasWidth = 0;
let lastCanvasHeight = 0;
let canvasSizeUpdatePending = false;

/**
 * Ridimensiona il canvas della pista in base al contenitore.
 * Viene chiamata dopo il caricamento e in caso di resize.
 */
function updateCanvasSize() {
    if (canvasSizeUpdatePending) return;
    canvasSizeUpdatePending = true;
    requestAnimationFrame(() => {
        const container = trackCanvas.parentElement;
        if (!container) {
            canvasSizeUpdatePending = false;
            return;
        }
        const rect = container.getBoundingClientRect();
        const availableWidth = rect.width - 40;
        const availableHeight = rect.height - 60;
        const w = Math.max(400, availableWidth);
        const h = Math.max(400, availableHeight);

        // Se le dimensioni sono già corrette, esci
        if (Math.abs(trackCanvas.width - w) < 1 && Math.abs(trackCanvas.height - h) < 1) {
            canvasSizeUpdatePending = false;
            return;
        }

        const now = Date.now();
        if (now - lastCanvasResize > 100) {
            trackCanvas.width = w;
            trackCanvas.height = h;
            lastCanvasResize = now;
            lastFrameTime = now;
        }
        canvasSizeUpdatePending = false;
    });
}

/** Reindirizza alla pagina di login (se presente) */
function goLogin() {
    window.location.href = "login.html";
}

/** Attiva/disattiva lo stato "active" su un pulsante della topbar */
function setTopbarActive(btn) {
    document.querySelectorAll(".topbar-btn").forEach(b => b.classList.remove("active"));
    if (btn) btn.classList.add("active");
}

/** Imposta lo stato di caricamento (loading) su un pulsante */
function setControlLoading(btn, state) {
    btn.classList.toggle("loading", state);
    btn.disabled = state;
}

/** Rimuove la classe "active" da tutti i pulsanti dei controlli */
function setActiveControl(active) {
    document.querySelectorAll(".controls button").forEach(b => b.classList.remove("active"));
    if (active) active.classList.add("active");
}

// Funzione helper per resettare lo stato di rendering del tracciato
function resetTrackRenderState() {
    trackNeedsRedraw = true;
    layoutCache = {};
}

// =============================================================================
// 20. INIT – Inizializzazione all'avvio
// =============================================================================

document.addEventListener("DOMContentLoaded", () => {
    // Installazione dei controlli per l'editor del tracciato
    installTrackEditorControls();

    // Creazione dei grafici principali e del grafico storico
    createCharts();

    // Caricamento dei dispositivi e connessione WebSocket
    loadDevices();
    connectWebSocket();

    // Carica il tracciato dal backend (se disponibile)
    loadTrackFromBackend();

    // Avvio del ciclo di rendering e del ridimensionamento iniziale
    updateCanvasSize();
    renderLoop();

    // Aggiornamento periodico del radar (ogni 3 secondi)
    setInterval(updateRadar, 3000);

    // Pulsanti zoom
    document.getElementById("resetZoomBtn")?.addEventListener("click", () => {
        trackZoom = 1.0;
        panX = 0;
        panY = 0;
        trackNeedsRedraw = true;
        if (followMode) {
            followMode = false;
            const btn = document.getElementById("followBtn");
            if (btn) {
                btn.classList.remove("active");
                btn.innerText = "🎯 Follow";
            }
        }
    });

    // ============================================================
    // ZOOM CON ROTELLINA DEL MOUSE (centrato sul canvas)
    // ============================================================
    trackCanvas.addEventListener('wheel', function(e) {
        e.preventDefault();
        if (trackEditorEnabled) return;
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, trackZoom * factor));
        if (newZoom === trackZoom) return;
        trackZoom = newZoom;
        trackNeedsRedraw = true;
    }, { passive: false });

    // Pulsante Follow
    const followBtn = document.getElementById("followBtn");
    if (followBtn) {
        followBtn.addEventListener("click", () => {
            followMode = !followMode;
            followBtn.classList.toggle("active", followMode);
            followBtn.innerText = followMode ? "📍 Following" : "🎯 Follow";
            if (followMode) {
                panX = 0;
                panY = 0;
            }
        });
    }

    // Pulsante Espandi/Rimpicciolisci pista
    const expandBtn = document.getElementById("expandTrackBtn");
    const pipContainer = document.getElementById("pip-container");
    const pipControls = document.getElementById("pip-controls");
    if (expandBtn) {
        expandBtn.addEventListener("click", () => {
            trackExpanded = !trackExpanded;
            document.body.classList.toggle("track-expanded", trackExpanded);
            expandBtn.classList.toggle("active", trackExpanded);
            if (pipControls) pipControls.style.display = trackExpanded ? "flex" : "none";
            if (pipContainer) pipContainer.style.display = trackExpanded ? "flex" : "none";
            if (!trackExpanded) {
                ['speed', 'acc', 'compare', 'radar'].forEach(type => {
                    if (pipActive[type]) destroyPipChart(type);
                });
                document.querySelectorAll('.pip-toggle-btn').forEach(b => b.classList.remove('active'));
            }
            setTimeout(updateCanvasSize, 50);
        });
    }

    // Pulsanti per attivare i widget PiP
    document.querySelectorAll('.pip-toggle-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            togglePip(this.dataset.type);
        });
    });

    // Ridimensionamento della finestra
    window.addEventListener("resize", () => {
        if (trackExpanded) updateCanvasSize();
    });

    // Invio della domanda AI con tasto Enter
    const aiInput = document.getElementById("question");
    if (aiInput) {
        aiInput.addEventListener("keydown", function(e) {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                askAI();
            }
        });
    }

    let resizeDebounce = null;
    window.addEventListener("resize", () => {
        if (resizeDebounce) clearTimeout(resizeDebounce);
        resizeDebounce = setTimeout(() => {
            if (trackExpanded) {
                updateCanvasSize();
            }
            resizeDebounce = null;
        }, 100);
    });

    // Pulsante per caricare il tracciato da GPS (file)
    document.getElementById('loadGpsTrackBtn')?.addEventListener('click', () => {
        document.getElementById('gpsFileInput').click();
    });

    document.getElementById('gpsFileInput')?.addEventListener('change', async function(e) {
        const file = this.files[0];
        if (!file) return;
        try {
            const formData = new FormData();
            formData.append('file', file);

            const res = await fetch(`${BACKEND_URL}/upload_track`, {
                method: 'POST',
                body: formData
            });
            const data = await res.json();
            if (data.ok) {
                TRACK_POINTS = data.points;
                if (data.track_length_meters) {
                    trackLength = data.track_length_meters;
                }
                const normalized = data.points.map(p => [p[0]/TRACK_SCALE, p[1]/TRACK_SCALE]);
                localStorage.setItem(TRACK_STORAGE_KEY, JSON.stringify(normalized));
                localStorage.setItem('f1_track_length', String(trackLength));
                trackZoom = 1.0;
                panX = 0;
                panY = 0;
                updateCanvasSize();
                alert(data.message || 'Tracciato caricato con successo!');
            } else {
                alert('Errore: ' + (data.detail || 'Errore sconosciuto'));
            }
        } catch (err) {
            alert('Errore di connessione al backend.');
        }
        this.value = '';
    });

    // Pulsante per avviare/fermare la registrazione GPS
    document.getElementById('gpsRecordBtn')?.addEventListener('click', async () => {
        try {
            const response = await fetch(`${BACKEND_URL}/esp/record`, { method: 'POST' });
            const data = await response.json();
            if (data.ok) {
                const btn = document.getElementById('gpsRecordBtn');
                btn.classList.toggle('active');
                btn.textContent = btn.classList.contains('active') ? '⏹️ Ferma GPS' : '🔴 Registra GPS';
            } else {
                alert('Errore: ' + (data.error || 'Comando fallito'));
            }
        } catch (err) {
            alert('Impossibile connettersi al backend.');
        }
    });

    document.getElementById('gpsSendBtn')?.addEventListener('click', async () => {
        try {
            const response = await fetch(`${BACKEND_URL}/esp/send`, { method: 'POST' });
            const data = await response.json();
            if (data.ok) {
                await loadTrackFromBackend();
                alert('✅ Tracciato inviato e caricato!');
            } else {
                alert('Errore: ' + (data.error || 'Invio fallito'));
            }
        } catch (err) {
            alert('Errore di connessione al backend.');
        }
    });

    // Pulsante per caricare il tracciato dal backend
    document.getElementById('loadFromBackendBtn')?.addEventListener('click', async () => {
        try {
            const res = await fetch(`${BACKEND_URL}/get_track`);
            const data = await res.json();
            if (data.ok) {
                TRACK_POINTS = data.points;
                const normalized = data.points.map(p => [p[0]/TRACK_SCALE, p[1]/TRACK_SCALE]);
                localStorage.setItem(TRACK_STORAGE_KEY, JSON.stringify(normalized));
                trackZoom = 1.0;
                panX = 0;
                panY = 0;
                updateCanvasSize();
                alert(`Tracciato caricato dal backend (${data.track_length_meters.toFixed(1)}m)`);
            } else {
                alert('Nessun tracciato disponibile nel backend.');
            }
        } catch (err) {
            alert('Errore di connessione al backend.');
        }
    });

    // Input per caricare note rally
    document.getElementById('loadRallyNotesBtn')?.addEventListener('click', () => {
        document.getElementById('rallyNotesInput').click();
    });

    document.getElementById('rallyNotesInput')?.addEventListener('change', async function(e) {
        const file = this.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            const points = data.points || data;
            if (!points || points.length === 0) {
                alert('❌ File vuoto');
                return;
            }

            const w = trackCanvas.width;
            const h = trackCanvas.height;

            // Se il file ha coordinate pixel (x,y), usali solo per visualizzazione
            if ('x' in points[0] && 'y' in points[0]) {
                rallyNotes = points.map(p => ({
                    x: p.x,
                    y: p.y,
                    note: p.note || '',
                    speed: p.speed || 0,
                    danger: p.danger || 1,
                    fixed: true
                }));
                trackNeedsRedraw = true;
                alert(`✅ Note caricate (pixel): ${rallyNotes.length} punti`);
                this.value = '';
                return;
            }

            // Se ha 'position' o 't', invia al backend e aggiorna visualizzazione
            if (points.some(p => p.position !== undefined || p.t !== undefined)) {
                // Prepara i punti per il backend (converte position in t)
                const notesForBackend = points.map(p => ({
                    t: parseFloat(p.position !== undefined ? p.position : p.t) || 0,
                    note: p.note || '',
                    speed: p.speed || 0,
                    danger: p.danger || 1
                }));

                // Invia al backend
                const res = await fetch(`${BACKEND_URL}/upload_rally_notes`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ points: notesForBackend })
                });
                const result = await res.json();
                if (!result.ok) {
                    alert('❌ Errore: ' + (result.detail || 'Caricamento fallito'));
                    this.value = '';
                    return;
                }

                // Aggiorna la visualizzazione con i marker sul tracciato
                rallyNotes = points.map(p => {
                    const t = parseFloat(p.position !== undefined ? p.position : p.t) || 0;
                    const segment = getTrackSegment(t, w, h);
                    return {
                        x: segment.x,
                        y: segment.y,
                        note: p.note || '',
                        speed: p.speed || 0,
                        danger: p.danger || 1,
                        t: t
                    };
                });
                trackNeedsRedraw = true;
                alert(`✅ Note caricate (position): ${result.count} punti`);
                this.value = '';
                return;
            }

            // Altrimenti, distribuisci uniformemente in base all'indice
            rallyNotes = points.map((p, index) => {
                const t = index / (points.length - 1);
                const segment = getTrackSegment(t, w, h);
                return {
                    x: segment.x,
                    y: segment.y,
                    note: p.note || '',
                    speed: p.speed || 0,
                    danger: p.danger || 1,
                    t: t
                };
            });
            trackNeedsRedraw = true;
            alert(`✅ Note caricate (indice): ${rallyNotes.length} punti`);
            this.value = '';

        } catch (err) {
            console.error('Errore caricamento note:', err);
            alert('❌ File non valido o errore di connessione');
        }
        this.value = '';
    });

    // Funzione per proiettare le note sul tracciato (calcola la frazione di giro più vicina)
    async function projectNotesOnTrack(points) {
        // Per ogni punto GPS, trova il punto sul tracciato più vicino
        // Questo richiede di avere il tracciato in coordinate cartesiane (pixel)
        // Implementazione semplificata: usa la distanza lungo il tracciato
        const w = trackCanvas.width;
        const h = trackCanvas.height;
        const layout = getTrackLayout(w, h);
        const canvasPoints = TRACK_POINTS.map(p => toCanvasPoint(p, layout));

        const projectedNotes = [];
        for (const p of points) {
            // Converte lat/lon in coordinate canvas (approssimato con la proiezione del punto più vicino)
            // Per semplicità, assumiamo che le note siano in ordine lungo il tracciato
            // e calcoliamo la frazione di giro in base all'indice
            // (In una versione più avanzata, si potrebbe calcolare la distanza minima)
            const t = points.indexOf(p) / (points.length - 1); // 0..1
            const segment = getTrackSegment(t, w, h);
            projectedNotes.push({
                x: segment.x,
                y: segment.y,
                note: p.note || '',
                speed: p.speed || 0,
                danger: p.danger || 1
            });
        }
        return projectedNotes;
    }

    document.getElementById('toggleRallyNotesBtn')?.addEventListener('click', function() {
    // Inverti lo stato di visibilità (locale)
    showRallyNotes = !showRallyNotes;
    // Cambia il testo del pulsante
    this.textContent = showRallyNotes ? '📋 Nascondi Note' : '📋 Mostra Note';
    // Imposta lo stato nel backend in base alla visibilità
    fetch(`${BACKEND_URL}/rally_notes/set`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: showRallyNotes })
    }).catch(err => console.error('Errore impostazione note:', err));
    // Forza il ridisegno del canvas per aggiornare i marker
    trackNeedsRedraw = true;
});

    // ============================================================
    // METODO 2: SIMULA TRACCIATO (carica un tracciato di esempio)
    // ============================================================

    document.getElementById('simulateTrackBtn')?.addEventListener('click', async () => {
        // Tracciato di esempio (un percorso a forma di goccia intorno a Prato, Italia)
        const exampleTrack = {
            points: [
                [43.852186928329736, 11.121407055678462],
                [43.853687864171484, 11.122286820257989],
                [43.85344028972699, 11.128187680242624],
                [43.85183103078559, 11.131277585107307],
                [43.850175305592145, 11.130011582419694],
                [43.84943253543014, 11.125848793921442],
                [43.85192387382795, 11.125741505558084]
            ]
        };

        const btn = document.getElementById('simulateTrackBtn');
        const originalText = btn.textContent;
        btn.textContent = '⏳ Invio...';
        btn.disabled = true;

        try {
            // 1. Invia il tracciato al backend
            const response = await fetch(`${BACKEND_URL}/upload_track`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(exampleTrack)
            });
            const data = await response.json();

            if (!data.ok) {
                alert('❌ Errore: ' + (data.detail || 'Caricamento fallito'));
                return;
            }

            // 2. Carica il tracciato dalla dashboard
            const res = await fetch(`${BACKEND_URL}/get_track`);
            const trackData = await res.json();

            if (trackData.ok) {
                TRACK_POINTS = trackData.points;
                const normalized = trackData.points.map(p => [p[0]/TRACK_SCALE, p[1]/TRACK_SCALE]);
                localStorage.setItem(TRACK_STORAGE_KEY, JSON.stringify(normalized));
                trackZoom = 1.0;
                panX = 0;
                panY = 0;
                updateCanvasSize();

                // Mostra messaggio di successo
                alert(`✅ Tracciato simulato caricato!\nPunti inviati: ${exampleTrack.points.length}\nPunti finali: ${trackData.points.length}\nLunghezza: ${trackData.track_length_meters.toFixed(1)}m`);

                // Feedback visivo sul pulsante
                btn.textContent = '✅ Caricato!';
                btn.style.background = 'rgba(0, 255, 136, 0.15)';
                setTimeout(() => {
                    btn.textContent = originalText;
                    btn.style.background = '';
                }, 2000);
            } else {
                alert('❌ Errore nel caricamento del tracciato dalla dashboard');
            }
        } catch (err) {
            console.error('Errore:', err);
            alert('❌ Errore di connessione al backend.');
        } finally {
            btn.disabled = false;
            if (btn.textContent === '⏳ Invio...') {
                btn.textContent = originalText;
            }
        }
    });

    // Recupero lo stato iniziale della gara
    fetchRaceStatus();

    // Creazione del contatore FPS (posizionato in basso a destra)
    fpsDiv = document.createElement('div');
    fpsDiv.id = 'fps-counter';
    fpsDiv.className = 'fps-counter';  // Classe per gli stili CSS
    document.body.appendChild(fpsDiv);
});