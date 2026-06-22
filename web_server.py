# =============================================================================
# F1 TELEMETRY & AI RACE SERVER - BACKEND COMPLETO (CON WEBSOCKET)
# =============================================================================
#
# Questo modulo implementa il backend per una dashboard di simulazione F1.
# Offre:
# - Registrazione e gestione dei dispositivi (vetture)
# - Simulazione fisica semplificata (velocità, accelerazione, usura gomme,
#   pit stop, sorpassi)
# - API REST per telemetria, classifica e controllo gara
# - Integrazione opzionale con InfluxDB per dati storici
# - Interfaccia AI tramite Ollama per analisi strategiche
# - WebSocket per trasmissione in tempo reale dei dati
# - Tracciato dinamico caricato da GPS (ESP32) con geometria e zone calcolate
#
# Tecnologie: FastAPI, InfluxDB Client, httpx, threading, asyncio, random.
# =============================================================================

import asyncio
import json
import logging
import math
import random
import threading
import time
from collections import defaultdict, deque
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple, Set

import httpx
from fastapi import FastAPI, Request, HTTPException, BackgroundTasks, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.websockets import WebSocketState

# -----------------------------------------------------------------------------
# Configurazione del logging
# -----------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("f1_server")

# =============================================================================
# 1. CONFIGURAZIONI GENERALI E COSTANTI
# =============================================================================

# URL di Ollama per l'AI
OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL = "qwen2.5:1.5b"

# Parametri del tracciato
TRACK_WIDTH = 12.0          # larghezza pista in metri
TRACK_EDGE = TRACK_WIDTH / 2

# URL dell'ESP32 (per i pulsanti GPS)
ESP_URL = "http://192.168.1.44"

# Variabili globali per il tracciato (verranno popolate dinamicamente)
TRACK_POINTS: List[List[float]] = []          # punti normalizzati [-1,1] per rendering
TRACK_LENGTH_METERS: float = 2000.0           # lunghezza reale in metri
TRACK_CUMULATIVE_LENGTH: List[float] = []     # distanza cumulativa per segmento (metri)
TRACK_TANGENTS: List[Tuple[float, float]] = []
TRACK_NORMALS: List[Tuple[float, float]] = []
TRACK_CURVATURE: List[float] = []
TRACK_ZONES_DYNAMIC: List[Dict[str, Any]] = []  # zone (curve/rettilinei) calcolate
TRACK_VERSION: int = 0                         # incrementato ad ogni aggiornamento
TRACK_CLOSED: bool = True

# Note rally (lista di dizionari con position, speed, danger, note)
RALLY_NOTES: List[Dict[str, Any]] = []
RALLY_NOTES_ENABLED: bool = True

# Riferimenti per conversione GPS (inizializzati al caricamento del tracciato)
TRACK_REF_LAT: Optional[float] = None
TRACK_REF_LON: Optional[float] = None
TRACK_CART_CX: float = 0.0
TRACK_CART_CY: float = 0.0
TRACK_CART_MAX_HALF: float = 1.0
TRACK_SCALE: int = 1000

# =============================================================================
# 2. CONFIGURAZIONE INFLUXDB (disabilitata di default)
# =============================================================================

INFLUX_ENABLED: bool = False
if INFLUX_ENABLED:
    from influxdb_client import InfluxDBClient, Point, WritePrecision
    from influxdb_client.client.write_api import SYNCHRONOUS

    INFLUX_URL = "http://localhost:8086"
    INFLUX_TOKEN = "Ueos4lpOgN2nvxowq2Hy_3ghoS7v9CyznT8uBZKyeYeTXXPjSx41GZw0Aq2cqf2pj-ag3pZZ7uJhdi8x_HZg1A=="
    INFLUX_ORG = "F1_Telemetry"
    INFLUX_BUCKET = "race_data"

    influx_client = InfluxDBClient(url=INFLUX_URL, token=INFLUX_TOKEN, org=INFLUX_ORG)
    write_api = influx_client.write_api(write_options=SYNCHRONOUS)
else:
    influx_client = None
    write_api = None

# =============================================================================
# 3. STATO GLOBALE E LOCK
# =============================================================================

race_running: bool = False
lock = threading.Lock()
active_websockets: Set[WebSocket] = set()
ws_lock = threading.Lock()

# Dizionario dei dispositivi (vetture): ogni entry ha i campi descritti in default_factory
devices: Dict[str, Dict[str, Any]] = defaultdict(lambda: {
    "speed": 0.0,
    "accX": 0.0,
    "distance": 0.0,
    "last_update": time.time(),
    "attack_mode": 0.0,
    "overtakes": 0,
    "defending": False,
    "last_overtake_time": 0,
    "speed_buffer": deque(maxlen=200),
    "acc_buffer": deque(maxlen=200),
    "tyre": 100.0,
    "compound": random.choice(["soft", "medium", "hard"]),
    "pit_time": 0.0,
    "in_pit": False,
    "pending_pit": False,
    "drs": False,
    "engine_power": random.uniform(24, 38),
    "driver_skill": random.uniform(0.8, 1.2),
    "brake_bias": random.uniform(0.1, 0.4),
    "current_lap_start_time": time.time(),
    "best_lap_time": float('inf'),
    "last_lap_count": 0,
    "last_lap_is_personal_best": False,
    "lateral_pos": 0.0,
    "target_lateral_pos": 0.0,
    "cornering_efficiency": random.uniform(0.9, 1.1),
})

# =============================================================================
# 4. APPLICAZIONE FASTAPI E MIDDLEWARE
# =============================================================================

app = FastAPI(
    title="F1 Telemetry & AI Race Server",
    description="Backend di telemetria e calcolo predittivo per simulazioni F1",
    version="2.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_charset_to_json(request: Request, call_next):
    """
    Aggiunge charset=utf-8 alle risposte JSON per garantire la corretta codifica.
    """
    response = await call_next(request)
    content_type = response.headers.get("content-type", "")
    if "application/json" in content_type and "charset" not in content_type:
        response.headers["content-type"] = "application/json; charset=utf-8"
    return response


@app.middleware("http")
async def cache_control_middleware(request: Request, call_next):
    """
    Imposta intestazioni di cache appropriate per API dinamiche e file statici.
    """
    response = await call_next(request)
    path = request.url.path

    # Endpoint dinamici → no-cache
    if path in ("/telemetry", "/leaderboard", "/devices", "/ask_ai") or path.startswith("/race/"):
        response.headers["Cache-Control"] = "no-cache"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response

    # File statici → cache lunga
    static_extensions = ('.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg',
                         '.ico', '.woff', '.woff2', '.ttf', '.eot', '.webp')
    if path.endswith(static_extensions):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response

    # Pagine HTML → no-cache
    if path.endswith('.html') or path in ('/', ''):
        response.headers["Cache-Control"] = "no-cache"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"

    return response

# =============================================================================
# 5. FUNZIONI PER LA GEOMETRIA DEL TRACCIATO
# =============================================================================

def compute_track_geometry(points: List[List[float]]) -> Tuple[List[float], List[Tuple[float, float]], List[Tuple[float, float]], List[float]]:
    """
    Calcola lunghezze cumulative, tangenti, normali e curvatura per ogni segmento.

    Args:
        points: lista di punti [x, y] in coordinate normalizzate.

    Returns:
        cum_len: distanza cumulativa per ogni punto
        tangents: vettori tangenti (dx, dy) per ogni segmento
        normals: vettori normali (-dy, dx) per ogni segmento
        curvature: curvatura approssimativa per ogni segmento (rad/m)
    """
    n = len(points)
    if n < 2:
        return [], [], [], []

    cum_len = [0.0]
    tangents = []
    normals = []
    curvature = []
    total = 0.0

    for i in range(n - 1):
        dx = points[i+1][0] - points[i][0]
        dy = points[i+1][1] - points[i][1]
        seg_len = math.hypot(dx, dy)
        total += seg_len
        cum_len.append(total)
        if seg_len > 0:
            tx = dx / seg_len
            ty = dy / seg_len
        else:
            tx, ty = 1.0, 0.0
        tangents.append((tx, ty))
        normals.append((-ty, tx))

    for i in range(len(tangents) - 1):
        angle1 = math.atan2(tangents[i][1], tangents[i][0])
        angle2 = math.atan2(tangents[i+1][1], tangents[i+1][0])
        diff = angle2 - angle1
        diff = (diff + math.pi) % (2 * math.pi) - math.pi
        seg_len = cum_len[i+1] - cum_len[i] if i+1 < len(cum_len) else 1.0
        curvature.append(abs(diff) / seg_len if seg_len > 0 else 0.0)

    if curvature:
        curvature.append(curvature[-1])
    else:
        curvature.append(0.0)

    return cum_len, tangents, normals, curvature


def compute_dynamic_zones(curvature: List[float], cum_len: List[float], total_length: float, threshold: float = 0.02) -> List[Dict[str, Any]]:
    """
    Divide il tracciato in zone (rettilineo/curva) in base alla curvatura.

    Args:
        curvature: lista di curvature per segmento
        cum_len: distanze cumulative
        total_length: lunghezza totale del tracciato in metri
        threshold: valore soglia per distinguere curva da rettilineo

    Returns:
        Lista di zone, ognuna con start, end (frazione 0..1), type, drs, radius, direction.
    """
    zones = []
    n = len(curvature)
    if n == 0:
        return zones

    i = 0
    while i < n:
        start_len = cum_len[i] if i < len(cum_len) else total_length
        start_fraction = start_len / total_length if total_length > 0 else 0.0
        is_curve = curvature[i] > threshold

        j = i
        while j < n and (curvature[j] > threshold) == is_curve:
            j += 1

        end_len = cum_len[min(j, len(cum_len)-1)] if j < len(cum_len) else total_length
        end_fraction = end_len / total_length if total_length > 0 else 1.0

        zone = {
            "start": start_fraction,
            "end": end_fraction,
            "type": "corner" if is_curve else "straight",
            "drs": not is_curve,
            "radius": 0.5 if is_curve else 1.0,
            "direction": "right" if is_curve and curvature[i] > 0 else "left"
        }
        zones.append(zone)
        i = j

    if zones and zones[-1]["end"] < 1.0:
        zones[-1]["end"] = 1.0

    return zones


def get_track_zone_dynamic(lap_fraction: float) -> Dict[str, Any]:
    """
    Restituisce la zona corrispondente alla frazione di giro.

    Args:
        lap_fraction: frazione di giro [0,1)

    Returns:
        Dizionario con i dati della zona.
    """
    f = lap_fraction % 1.0
    for zone in TRACK_ZONES_DYNAMIC:
        if zone["start"] <= f < zone["end"]:
            return zone
    return TRACK_ZONES_DYNAMIC[-1] if TRACK_ZONES_DYNAMIC else {"type": "straight", "drs": True}


def ideal_racing_line_dynamic(lap_fraction: float, car_data: Dict[str, Any], pressure: float = 0.0) -> Tuple[float, Dict[str, Any]]:
    """
    Calcola la traiettoria ideale in base alla zona e alla pressione dall'auto dietro.

    Args:
        lap_fraction: frazione di giro
        car_data: dati della vettura (per difesa)
        pressure: pressione dalla vettura dietro (0-35)

    Returns:
        (lateral_target, zone)
    """
    zone = get_track_zone_dynamic(lap_fraction)
    if zone["type"] == "straight":
        target = 0.0
    else:
        target = 4.8   # offset verso l'interno

    if car_data.get("defending", False):
        target = -4.8
    elif pressure > 0:
        target += min(1.2, pressure * 0.06)

    return max(-TRACK_EDGE, min(TRACK_EDGE, target)), zone


def is_straight(speed: float) -> bool:
    """Determina se la velocità indica un tratto rettilineo."""
    return speed > 170


def try_overtake(car_a: Dict[str, Any], car_b: Dict[str, Any]) -> bool:
    """
    Valuta la probabilità che car_a sorpassi car_b in base a distanza, velocità e posizione laterale.

    Returns:
        True se il sorpasso ha successo (probabilistico).
    """
    gap = car_b["distance"] - car_a["distance"]
    speed_diff = car_a["speed"] - car_b["speed"]
    if gap > 24 or speed_diff < 6:
        return False

    lateral_delta = abs(car_a.get("lateral_pos", 0.0) - car_b.get("lateral_pos", 0.0))
    has_line_overlap = lateral_delta > 2.2

    probability = (0.012 +
                   (0.055 if car_a["drs"] else 0) +
                   (0.035 if has_line_overlap else -0.01) +
                   car_a["driver_skill"] * 0.025)
    return random.random() < probability

# =============================================================================
# 6. CONVERSIONE GPS → CARTESIANE
# =============================================================================

def gps_to_cartesian(points: List[Tuple[float, float]], ref_lat: Optional[float] = None, ref_lon: Optional[float] = None) -> List[List[float]]:
    """
    Converte una lista di punti (lat, lon) in coordinate cartesiane (metri) rispetto a un riferimento.

    Args:
        points: lista di tuple (lat, lon)
        ref_lat, ref_lon: coordinate di riferimento (se None, si usa il primo punto)

    Returns:
        Lista di [x, y] in metri.
    """
    if not points:
        return []
    if ref_lat is None:
        ref_lat = points[0][0]
    if ref_lon is None:
        ref_lon = points[0][1]

    R = 6371000  # raggio terrestre in metri
    lat_rad = math.radians(ref_lat)
    cos_lat = math.cos(lat_rad)

    cartesian = []
    for lat, lon in points:
        dx = (lon - ref_lon) * math.radians(1) * R * cos_lat
        dy = (lat - ref_lat) * math.radians(1) * R
        cartesian.append([dx, dy])
    return cartesian

# =============================================================================
# 7. WEBSOCKET – BROADCAST IN TEMPO REALE
# =============================================================================

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    Endpoint WebSocket per la trasmissione live dei dati di telemetria.
    Mantiene la connessione aperta e invia aggiornamenti periodici tramite il task broadcast_telemetry.
    """
    await websocket.accept()
    with ws_lock:
        active_websockets.add(websocket)
    try:
        while True:
            await websocket.receive_text()   # manteniamo la connessione aperta
    except WebSocketDisconnect:
        with ws_lock:
            active_websockets.discard(websocket)


async def broadcast_telemetry():
    """
    Task asincrono che invia lo stato corrente a tutti i client WebSocket ogni 50 ms.
    """
    while True:
        if active_websockets:
            payload = build_broadcast_payload()
            with ws_lock:
                for ws in list(active_websockets):
                    try:
                        if ws.client_state == WebSocketState.CONNECTED:
                            await ws.send_json(payload)
                    except Exception:
                        active_websockets.discard(ws)
        await asyncio.sleep(0.05)


def build_broadcast_payload() -> Dict[str, Any]:
    """
    Costruisce il payload JSON da inviare via WebSocket contenente:
    - classifica aggiornata
    - informazioni sul tracciato

    Returns:
        Dizionario con i dati da inviare.
    """
    with lock:
        cars_list = []
        global_fastest = min((d["best_lap_time"] for d in devices.values() if d["best_lap_time"] != float('inf')),
                             default=float('inf'))
        fastest_device = next((dev for dev, d in devices.items() if d["best_lap_time"] == global_fastest), None)

        for device_id, d in devices.items():
            if not TRACK_CLOSED and d["distance"] >= TRACK_LENGTH_METERS:
                lap = 1.0
            else:
                lap = (d["distance"] % TRACK_LENGTH_METERS) / TRACK_LENGTH_METERS if TRACK_LENGTH_METERS > 0 else 0

            cars_list.append({
                "device": device_id,
                "speed": round(d["speed"], 1),
                "accX": round(d["accX"], 1),
                "distance": round(d["distance"], 1),
                "lap": round(lap, 6),
                "lateral_pos": round(d.get("lateral_pos", 0.0), 2),
                "tyre": round(d.get("tyre", 100), 1),
                "best_lap": round(d["best_lap_time"], 3) if d["best_lap_time"] != float('inf') else "--.--",
                "is_fastest_lap": (device_id == fastest_device) and (global_fastest != float('inf')),
                "fastest_lap_time": round(global_fastest * 1000, 0) if global_fastest != float('inf') else None,
                "in_pit": d.get("in_pit", False),
                "laps": int(d["distance"] // TRACK_LENGTH_METERS),
                "closed": TRACK_CLOSED
            })

        # Ordina per distanza decrescente e assegna posizioni
        cars_list.sort(key=lambda x: x["distance"], reverse=True)
        for i, car in enumerate(cars_list, 1):
            car["position"] = i
            car["position_label"] = f"P{i}"

        # Tracciato
        scaled_points = [[p[0]*TRACK_SCALE, p[1]*TRACK_SCALE] for p in TRACK_POINTS] if TRACK_POINTS else []
        track_info = {
            "points": scaled_points,
            "length_meters": TRACK_LENGTH_METERS,
            "version": TRACK_VERSION,
            "closed": TRACK_CLOSED
        }

        return {"type": "state", "cars": cars_list, "track": track_info}

# =============================================================================
# 8. INTEGRAZIONE CON INFLUXDB
# =============================================================================

def save_to_influxdb(device_id: str, speed: float, accel: float, tyre: float):
    """
    Salva un punto di telemetria in InfluxDB (se abilitato).

    Args:
        device_id: identificativo della vettura
        speed: velocità (km/h)
        accel: accelerazione (m/s²)
        tyre: usura gomme (%)
    """
    if not INFLUX_ENABLED or write_api is None:
        return
    try:
        point = Point("telemetry") \
            .tag("car_name", device_id) \
            .field("speed", speed) \
            .field("acceleration", accel) \
            .field("tyre_wear", float(tyre)) \
            .time(datetime.utcnow())
        write_api.write(bucket=INFLUX_BUCKET, org=INFLUX_ORG, record=point)
    except Exception as e:
        logger.error(f"Errore scrittura InfluxDB: {e}")


def check_lap_time(device_id: str, current_distance: float):
    """
    Controlla se la vettura ha completato un giro e aggiorna il miglior tempo.
    Se InfluxDB è abilitato, salva il tempo sul giro.

    Args:
        device_id: identificativo della vettura
        current_distance: distanza percorsa (metri)
    """
    try:
        trigger_influx_write = False
        lap_number_to_write = 0
        lap_time_to_write = 0.0

        with lock:
            if device_id not in devices:
                return
            d = devices[device_id]
            track_len = TRACK_LENGTH_METERS if TRACK_LENGTH_METERS > 0 else 2000.0
            current_laps = int(current_distance // track_len)

            if current_laps > d["last_lap_count"]:
                now = time.time()
                lap_time = now - d["current_lap_start_time"]
                d["current_lap_start_time"] = now
                d["last_lap_count"] = current_laps

                if lap_time < d["best_lap_time"]:
                    d["best_lap_time"] = lap_time
                    d["last_lap_is_personal_best"] = True
                else:
                    d["last_lap_is_personal_best"] = False

                logger.info(f"🏎️ {device_id} ha completato il giro {current_laps} in {round(lap_time, 3)}s | Best: {round(d['best_lap_time'], 3)}s")

                trigger_influx_write = True
                lap_number_to_write = current_laps
                lap_time_to_write = lap_time

        if trigger_influx_write and INFLUX_ENABLED and write_api is not None:
            point = Point("lap_times") \
                .tag("car_name", device_id) \
                .field("lap_number", lap_number_to_write) \
                .field("duration", lap_time_to_write) \
                .time(datetime.utcnow())
            write_api.write(bucket=INFLUX_BUCKET, org=INFLUX_ORG, record=point)

    except Exception as e:
        logger.error(f"Errore calcolo tempo sul giro per {device_id}: {e}")

# =============================================================================
# 9. FUNZIONI PER RALLY NOTES E MODULAZIONE VELOCITÀ
# =============================================================================

def get_target_speed_from_notes(lap_fraction: float) -> Optional[float]:
    """
    Restituisce la velocità target (km/h) in base alle note rally (interpolazione lineare).

    Args:
        lap_fraction: frazione di giro [0,1)

    Returns:
        velocità target o None se le note non sono attive.
    """
    if not RALLY_NOTES_ENABLED or not RALLY_NOTES:
        return None

    notes = RALLY_NOTES
    n = len(notes)
    if n == 0:
        return None

    f = lap_fraction % 1.0

    if n == 1:
        return notes[0]["speed"]

    i = 0
    while i < n and notes[i]["position"] <= f:
        i += 1

    if i == 0:
        if TRACK_CLOSED:
            prev = notes[-1]
            next_ = notes[0]
            total_dist = (1.0 - prev["position"]) + next_["position"]
            frac = (f - prev["position"]) / total_dist if total_dist > 0 else 0
            return prev["speed"] + (next_["speed"] - prev["speed"]) * frac
        else:
            return notes[0]["speed"]

    elif i == n:
        if TRACK_CLOSED:
            prev = notes[-1]
            next_ = notes[0]
            total_dist = (1.0 - prev["position"]) + next_["position"]
            frac = (f - prev["position"]) / total_dist if total_dist > 0 else 0
            return prev["speed"] + (next_["speed"] - prev["speed"]) * frac
        else:
            return notes[-1]["speed"]

    else:
        prev = notes[i-1]
        next_ = notes[i]
        dist = next_["position"] - prev["position"]
        frac = (f - prev["position"]) / dist if dist > 0 else 0
        return prev["speed"] + (next_["speed"] - prev["speed"]) * frac


def modulate_speed_by_stats(target_speed: float, device_data: Dict[str, Any]) -> float:
    """
    Modula la velocità target in base alle statistiche della vettura (pilota, motore, gomme).

    Args:
        target_speed: velocità base (km/h)
        device_data: dati della vettura

    Returns:
        velocità target effettiva (km/h).
    """
    # Fattore pilota
    skill_factor = 0.85 + 0.15 * (device_data["driver_skill"] - 0.8) / (1.2 - 0.8)
    # Fattore motore
    power_factor = 1.0 + 0.12 * (device_data["engine_power"] - 24) / (38 - 24)
    # Fattore gomme
    tyre_factor = max(0.5, device_data["tyre"] / 100.0)

    combined = skill_factor * power_factor * tyre_factor
    combined = max(0.6, min(1.25, combined))

    return target_speed * combined

# =============================================================================
# 10. THREAD DI SIMULAZIONE (ENGINE CORE)
# =============================================================================

def simulate():
    """
    Thread principale della simulazione: aggiorna lo stato di tutte le vetture
    secondo un modello fisico semplificato.
    """
    global race_running

    while True:
        if not race_running:
            time.sleep(0.2)
            continue

        lap_checks = []

        with lock:
            cars = sorted(devices.items(), key=lambda x: x[1]["distance"], reverse=True)
            track_len = TRACK_LENGTH_METERS if TRACK_LENGTH_METERS > 0 else 2000.0

            for name, d in cars:
                # Le vetture ESP32 sono guidate da dati esterni, non simulate
                if name == "ESP32_F1" or name.lower().startswith("esp32"):
                    continue

                try:
                    now = time.time()
                    dt = max(0.01, min(0.06, now - d["last_update"]))
                    d["last_update"] = now

                    # Se il tracciato è aperto e la vettura ha finito, fermala
                    if not TRACK_CLOSED and d["distance"] >= TRACK_LENGTH_METERS:
                        d["speed"] = 0
                        d["accX"] = 0
                        d["distance"] = TRACK_LENGTH_METERS
                        d["speed_buffer"].append(0)
                        d["acc_buffer"].append(0)
                        continue

                    lap_t = (d["distance"] % track_len) / track_len if track_len > 0 else 0.0
                    zone = get_track_zone_dynamic(lap_t)

                    # --- RALLY NOTES: velocità target ---
                    target_speed_raw = get_target_speed_from_notes(lap_t)
                    target_speed = None
                    if target_speed_raw is not None:
                        target_speed = modulate_speed_by_stats(target_speed_raw, d)

                    correction = 0.0
                    if target_speed is not None:
                        speed_error_kmh = target_speed - d["speed"]
                        time_constant = 0.15 if zone["type"] == "corner" else 0.6
                        desired_acc = speed_error_kmh / (3.6 * time_constant)
                        correction = max(-35.0, min(15.0, desired_acc))

                    # --- Gestione pit stop ---
                    needs_pit = d["tyre"] <= 5.0 or d.get("pending_pit", False)
                    if needs_pit and not d["in_pit"]:
                        d["pending_pit"] = True
                        d["speed"] = max(0.0, d["speed"] - 45 * dt)
                        d["accX"] = -45.0
                        d["speed_buffer"].append(d["speed"])
                        d["acc_buffer"].append(d["accX"])
                        d["distance"] += (d["speed"] / 3.6) * dt
                        if d["speed"] <= 5.0:
                            d["pending_pit"] = False
                            d["in_pit"] = True
                            d["pit_time"] = 0.0
                        continue

                    if d["in_pit"]:
                        d["speed"] = 0.0
                        d["accX"] = -60.0
                        d["pit_time"] += dt
                        d["speed_buffer"].append(0.0)
                        d["acc_buffer"].append(-60.0)
                        if d["pit_time"] > 4.0:
                            d["tyre"] = 100.0
                            d["pit_time"] = 0.0
                            d["in_pit"] = False
                            d["compound"] = random.choice(["soft", "medium", "hard"])
                        continue

                    # --- Rilevamento vetture vicine ---
                    nearby_front = None
                    nearby_back = None
                    for other_name, other in cars:
                        if other_name == name:
                            continue
                        gap_front = other["distance"] - d["distance"]
                        if 0 < gap_front < 35 and nearby_front is None:
                            nearby_front = other
                        gap_back = d["distance"] - other["distance"]
                        if 0 < gap_back < 22 and nearby_back is None:
                            nearby_back = other

                    pressure = 0.0 if nearby_front is None else max(0.0, 35 - (nearby_front["distance"] - d["distance"]))
                    d["defending"] = nearby_back is not None and zone["type"] != "straight"

                    # --- Traiettoria ideale e penalità in curva ---
                    curve_speed_penalty = 0.0
                    target_lateral, active_zone = ideal_racing_line_dynamic(lap_t, d, pressure)

                    if active_zone["type"] != "straight":
                        lateral_error = abs(d["lateral_pos"] - target_lateral)
                        radius_factor = active_zone.get("radius", 0.7)
                        apex_bonus = max(0.0, 1.0 - lateral_error / TRACK_EDGE) * (0.45 + radius_factor)
                        curve_speed_penalty = (0.010 + (1.0 - radius_factor) * 0.010) * (d["speed"] ** 1.32)
                        curve_speed_penalty *= max(0.20, 1.15 - apex_bonus)

                    # --- Sterzata (lateral_pos) ---
                    steering_rate = (4.2 + d["driver_skill"] * 2.4) * dt
                    if d["lateral_pos"] < target_lateral:
                        d["lateral_pos"] = min(target_lateral, d["lateral_pos"] + steering_rate)
                    elif d["lateral_pos"] > target_lateral:
                        d["lateral_pos"] = max(target_lateral, d["lateral_pos"] - steering_rate)
                    d["lateral_pos"] = max(-TRACK_EDGE, min(TRACK_EDGE, d["lateral_pos"]))

                    # --- DRS ---
                    d["drs"] = active_zone.get("drs", False) and is_straight(d["speed"])
                    drs_boost = 10 if d["drs"] else 0

                    # --- Calcolo accelerazione ---
                    grip = max(0.10, d["tyre"] / 100.0)
                    wear_factor = 1.2 if d["compound"] == "soft" else 1.0
                    engine = d["engine_power"] * d["driver_skill"]
                    drag = -0.00016 * d["speed"] ** 2
                    noise = random.uniform(-0.25, 0.25)

                    acc = (engine * grip) + drs_boost + drag + noise - (curve_speed_penalty * 0.08) + correction

                    # Limite velocità in curva
                    if active_zone["type"] != "straight":
                        corner_cap = 255 + active_zone.get("radius", 0.7) * 85 + d["driver_skill"] * 24
                        if d["speed"] > corner_cap:
                            acc -= (d["speed"] - corner_cap) * 0.12

                    if d["speed"] < 15.0:
                        acc = max(6.0, engine * 0.4)

                    v = max(0.0, min(380.0, d["speed"] + acc))

                    # --- Aggiorna distanza (solo se non ha finito) ---
                    if not TRACK_CLOSED and d["distance"] >= TRACK_LENGTH_METERS:
                        v = 0.0
                        d["speed"] = 0.0
                        d["accX"] = 0.0
                    else:
                        d["distance"] += (v / 3.6) * dt

                    # --- Usura gomme ---
                    lateral_stress = abs(d["lateral_pos"] - target_lateral) * 0.08
                    if active_zone["type"] != "straight":
                        lateral_stress += (v / 300) * (1.2 - active_zone.get("radius", 0.7)) * 0.08

                    d["tyre"] -= (abs(acc) * 0.02 + v * 0.0004 + lateral_stress) * wear_factor
                    d["tyre"] = max(0.0, d["tyre"])

                    d["speed"] = v
                    d["accX"] = acc
                    d["speed_buffer"].append(v)
                    d["acc_buffer"].append(acc)

                except Exception as car_error:
                    logger.error(f"Errore ripristinato sulla vettura {name}: {car_error}")
                    d["speed"] = 0.0
                    d["accX"] = 0.0
                    d["speed_buffer"].append(0.0)
                    d["acc_buffer"].append(0.0)

            # --- Gestione sorpassi ---
            for i in range(len(cars) - 1):
                try:
                    a_name, a = cars[i + 1]
                    b_name, b = cars[i]
                    if (b["distance"] - a["distance"]) < 25 and (a["speed"] - b["speed"]) > 8 and try_overtake(a, b):
                        attacker_side = 1 if a.get("lateral_pos", 0) <= b.get("lateral_pos", 0) else -1
                        a["lateral_pos"] = max(-TRACK_EDGE, min(TRACK_EDGE, b.get("lateral_pos", 0) + attacker_side * 3.0))
                        a["distance"], b["distance"] = b["distance"] - 2, a["distance"] + 2
                        a["overtakes"] += 1
                        a["last_overtake_time"] = time.time()
                except Exception:
                    pass

            lap_checks = [(name, d["distance"]) for name, d in cars]

        # Controlla i tempi sul giro (fuori dal lock)
        for name, dist in lap_checks:
            check_lap_time(name, dist)

        time.sleep(0.05)

# =============================================================================
# 11. AVVIO DEI THREAD E TASK ASINCRONI
# =============================================================================

@app.on_event("startup")
def startup():
    """Avvia il thread di simulazione e il task di broadcast WebSocket."""
    threading.Thread(target=simulate, daemon=True).start()
    asyncio.create_task(broadcast_telemetry())

# =============================================================================
# 12. ENDPOINT DI REGISTRAZIONE E RIMOZIONE DISPOSITIVI
# =============================================================================

@app.post("/register_device")
async def register_device(req: Request):
    """
    Registra un nuovo dispositivo (vettura) nel sistema.

    Corpo richiesta: {"device_id": "nome_vettura"}
    """
    try:
        data = await req.json()
        device_id = data.get("device_id", "").strip()
        if not device_id:
            raise HTTPException(status_code=400, detail="Inserire un ID dispositivo valido")

        with lock:
            if device_id in devices:
                raise HTTPException(status_code=400, detail=f"La vettura '{device_id}' è già registrata")
            devices[device_id] = devices.default_factory()
            devices[device_id]["speed"] = 0
            devices[device_id]["distance"] = 0
            devices[device_id]["lateral_pos"] = 0.0
            devices[device_id]["target_lateral_pos"] = 0.0
            devices[device_id]["position_label"] = "P?"

        logger.info(f"✅ Dispositivo registrato: {device_id}")
        return {"ok": True, "device_id": device_id, "status": "registered"}

    except HTTPException as he:
        raise he
    except Exception as e:
        logger.error(f"Errore registrazione: {e}")
        raise HTTPException(status_code=500, detail="Errore interno del server")


@app.post("/remove_device")
async def remove_device(req: Request):
    """
    Rimuove un dispositivo dal sistema.

    Corpo richiesta: {"device_id": "nome_vettura"}
    """
    data = await req.json()
    device_id = data.get("device_id")
    with lock:
        if device_id in devices:
            del devices[device_id]
            logger.info(f"❌ Dispositivo rimosso: {device_id}")
    return {"ok": True}


@app.get("/devices")
def get_devices():
    """Restituisce l'elenco dei dispositivi registrati."""
    with lock:
        return {"devices": list(devices.keys())}

# =============================================================================
# 13. ENDPOINT PER LA RICEZIONE DEI DATI TELEMETRICI DA ESP32
# =============================================================================

@app.post("/api/telemetry")
async def esp32_data(req: Request, background_tasks: BackgroundTasks):
    """
    Riceve i dati telemetrici da un ESP32 (o dispositivo esterno) e li integra nella simulazione.

    Corpo richiesta: {"device_id": "...", "speed": ..., "accel": ...}
    """
    global race_running
    if not race_running:
        return {"ok": False, "race": "paused"}

    data = await req.json()
    device_id = data.get("device_id", "ESP32_F1")
    speed = float(data.get("speed", 0))
    raw_accel = float(data.get("accel", data.get("accX", 0)))
    accX = raw_accel + 9.43  # compensazione offset (calibrazione)

    with lock:
        d = devices[device_id]
        now = time.time()
        dt = max(0.01, min(0.5, now - d["last_update"]))
        d["last_update"] = now
        speed_mps = speed / 3.6
        d["distance"] += speed_mps * dt
        d["speed"] = speed
        d["accX"] = accX
        d["speed_buffer"].append(speed)
        d["acc_buffer"].append(accX)
        current_tyre = d["tyre"]
        current_distance = d["distance"]

    background_tasks.add_task(save_to_influxdb, device_id, speed, accX, current_tyre)
    background_tasks.add_task(check_lap_time, device_id, current_distance)
    return {"ok": True}

# =============================================================================
# 14. ENDPOINT TELEMETRIA (REST) – mantenuto per compatibilità
# =============================================================================

@app.get("/telemetry")
def telemetry(device_id: str = "car_1", n: int = 50, last_only: bool = False):
    """
    Restituisce i dati di telemetria di una vettura (buffer di velocità, accelerazione e profilo).

    Parametri:
        device_id: identificativo della vettura
        n: numero di campioni da restituire
        last_only: se True, restituisce solo l'ultimo valore
    """
    with lock:
        if device_id not in devices:
            return {"speed": [], "accX": [], "profile": {}}

        d = devices[device_id]
        if last_only:
            return {
                "speed": [d["speed"]],
                "accX": [d["accX"]],
                "profile": {}
            }

        speed_list = list(d["speed_buffer"])[-n:]
        acc_list = list(d["acc_buffer"])[-n:]
        top_speed = max(d["speed_buffer"]) if d["speed_buffer"] else d["speed"]

        profile = {
            "driver_skill": round((d["driver_skill"] - 0.8) / (1.2 - 0.8) * 100, 1),
            "engine_power": round((d["engine_power"] - 24) / (38 - 24) * 100, 1),
            "tyre_life": round(d["tyre"], 1),
            "top_speed": round((top_speed / 380) * 100, 1),
            "brake_bias": round((d["brake_bias"] - 0.1) / (0.4 - 0.1) * 100, 1)
        }

        return {
            "speed": speed_list,
            "accX": acc_list,
            "distance": round(d["distance"], 1),
            "profile": profile
        }

# =============================================================================
# 15. ENDPOINT UPLOAD E GET TRACCIATO GPS
# =============================================================================

@app.post("/upload_track")
async def upload_track(request: Request):
    """
    Riceve un tracciato GPS (array di punti [lat, lon]) dall'ESP32,
    lo converte in coordinate cartesiane e calcola geometria e zone.

    Corpo richiesta: array di [lat, lon] o {"points": [[lat,lon], ...]}
    """
    global TRACK_POINTS, TRACK_LENGTH_METERS, TRACK_CUMULATIVE_LENGTH, TRACK_TANGENTS
    global TRACK_NORMALS, TRACK_CURVATURE, TRACK_ZONES_DYNAMIC, TRACK_VERSION, TRACK_CLOSED
    global TRACK_REF_LAT, TRACK_REF_LON, TRACK_CART_CX, TRACK_CART_CY, TRACK_CART_MAX_HALF

    try:
        raw_body = await request.body()
        body_str = raw_body.decode('utf-8')
        data = json.loads(body_str)
    except json.JSONDecodeError as e:
        logger.error(f"JSON invalido: {e}")
        raise HTTPException(status_code=400, detail=f"JSON invalido: {str(e)}")

    if isinstance(data, list):
        raw_points = data
    elif isinstance(data, dict) and "points" in data:
        raw_points = data["points"]
    else:
        raise HTTPException(status_code=400, detail="Formato non supportato. Atteso array o oggetto con 'points'")

    if len(raw_points) < 3:
        raise HTTPException(status_code=400, detail="Servono almeno 3 punti GPS")

    # 1. Converti GPS → coordinate cartesiane (metri)
    cartesian = gps_to_cartesian(raw_points)

    # Memorizza riferimento
    TRACK_REF_LAT = raw_points[0][0]
    TRACK_REF_LON = raw_points[0][1]

    # Calcola centro e max_half per normalizzazione
    min_x = min(p[0] for p in cartesian)
    max_x = max(p[0] for p in cartesian)
    min_y = min(p[1] for p in cartesian)
    max_y = max(p[1] for p in cartesian)
    TRACK_CART_CX = (min_x + max_x) / 2
    TRACK_CART_CY = (min_y + max_y) / 2
    TRACK_CART_MAX_HALF = max((max_x - min_x) / 2, (max_y - min_y) / 2)

    # 2. Calcola lunghezza reale (metri)
    first = cartesian[0]
    last = cartesian[-1]
    dist_end_to_start = math.hypot(first[0]-last[0], first[1]-last[1])
    closed = dist_end_to_start < 10.0

    track_length_m = 0.0
    for i in range(len(cartesian)-1):
        dx = cartesian[i+1][0] - cartesian[i][0]
        dy = cartesian[i+1][1] - cartesian[i][1]
        track_length_m += math.hypot(dx, dy)
    if closed:
        dx = first[0] - last[0]
        dy = first[1] - last[1]
        track_length_m += math.hypot(dx, dy)

    logger.info(f"📏 Lunghezza reale calcolata: {track_length_m:.1f} m")

    # 3. Normalizza punti per rendering [-1,1]
    def normalize(points):
        if not points:
            return []
        min_x = min(p[0] for p in points)
        max_x = max(p[0] for p in points)
        min_y = min(p[1] for p in points)
        max_y = max(p[1] for p in points)
        cx = (min_x + max_x) / 2
        cy = (min_y + max_y) / 2
        half_w = (max_x - min_x) / 2
        half_h = (max_y - min_y) / 2
        max_half = max(half_w, half_h)
        if max_half == 0:
            return [[0, 0] for _ in points]
        return [[(p[0] - cx) / max_half, (p[1] - cy) / max_half] for p in points]

    normalized = normalize(cartesian)

    # 4. Chiudi il circuito per il rendering
    if closed and len(normalized) > 1:
        if math.hypot(normalized[0][0]-normalized[-1][0], normalized[0][1]-normalized[-1][1]) > 0.001:
            normalized_for_rendering = normalized + [normalized[0]]
        else:
            normalized_for_rendering = normalized
    else:
        normalized_for_rendering = normalized

    # 5. Aggiorna variabili globali
    TRACK_POINTS = normalized_for_rendering
    TRACK_LENGTH_METERS = track_length_m
    TRACK_CLOSED = closed
    TRACK_VERSION += 1

    # 6. Calcola geometria e zone
    cum_len, tangents, normals, curvature = compute_track_geometry(normalized)
    TRACK_CUMULATIVE_LENGTH = cum_len
    TRACK_TANGENTS = tangents
    TRACK_NORMALS = normals
    TRACK_CURVATURE = curvature
    TRACK_ZONES_DYNAMIC = compute_dynamic_zones(curvature, cum_len, track_length_m)

    logger.info(f"✅ Tracciato caricato: {len(normalized)} punti, {track_length_m:.1f}m, {len(TRACK_ZONES_DYNAMIC)} zone")

    # 7. Prepara punti scalati per il front-end
    scaled_points = [[p[0]*TRACK_SCALE, p[1]*TRACK_SCALE] for p in normalized]

    return {
        "ok": True,
        "points": scaled_points,
        "track_length_meters": track_length_m,
        "zones": TRACK_ZONES_DYNAMIC,
        "closed": TRACK_CLOSED,
        "message": f"Tracciato caricato: {len(normalized)} punti, lunghezza {track_length_m:.1f}m"
    }


@app.get("/get_track")
def get_track():
    """Restituisce il tracciato corrente (punti normalizzati e lunghezza)."""
    if not TRACK_POINTS:
        return {"ok": False, "message": "Nessun tracciato caricato"}

    scaled_points = [[p[0]*TRACK_SCALE, p[1]*TRACK_SCALE] for p in TRACK_POINTS]
    return {
        "ok": True,
        "points": scaled_points,
        "track_length_meters": TRACK_LENGTH_METERS,
        "zones": TRACK_ZONES_DYNAMIC,
        "version": TRACK_VERSION,
        "closed": TRACK_CLOSED
    }


def ensure_track_references():
    """
    Se il tracciato è caricato ma i riferimenti non sono impostati, li calcola (fallback).
    """
    global TRACK_REF_LAT, TRACK_REF_LON, TRACK_CART_CX, TRACK_CART_CY, TRACK_CART_MAX_HALF
    if TRACK_POINTS and TRACK_REF_LAT is None:
        min_x = min(p[0] for p in TRACK_POINTS)
        max_x = max(p[0] for p in TRACK_POINTS)
        min_y = min(p[1] for p in TRACK_POINTS)
        max_y = max(p[1] for p in TRACK_POINTS)
        TRACK_CART_CX = (min_x + max_x) / 2
        TRACK_CART_CY = (min_y + max_y) / 2
        TRACK_CART_MAX_HALF = max((max_x - min_x) / 2, (max_y - min_y) / 2)
        TRACK_REF_LAT = 0.0
        TRACK_REF_LON = 0.0
        logger.info("ℹ️ Riferimenti tracciato calcolati automaticamente (non GPS)")

# =============================================================================
# 16. ENDPOINT PER NOTE RALLY
# =============================================================================

@app.post("/upload_rally_notes")
async def upload_rally_notes(request: Request):
    """
    Riceve note rally in formato GPS (lat,lon) o con position (t).
    Ogni nota deve contenere 'position' (frazione 0-1), 'speed' (km/h), 'danger' (opzionale).
    """
    global RALLY_NOTES

    if not TRACK_POINTS:
        raise HTTPException(status_code=400, detail="Carica prima un tracciato.")

    data = await request.json()
    raw_points = data.get("points", [])
    if not raw_points:
        raise HTTPException(status_code=400, detail="Nessun punto note fornito.")

    rally_notes = []
    for p in raw_points:
        t = p.get("t") if "t" in p else p.get("position")
        if t is not None:
            t = float(t)
            t = max(0.0, min(1.0, t))
            rally_notes.append({
                "position": t,
                "note": p.get("note", ""),
                "speed": p.get("speed", 0),
                "danger": p.get("danger", 1)
            })
        else:
            # Se non c'è position, possiamo ignorare o gestire con lat/lon (ma non supportato)
            logger.warning(f"Nota senza position/t ignorata: {p}")

    RALLY_NOTES = rally_notes
    logger.info(f"📌 Note caricate: {len(RALLY_NOTES)}")
    for i, n in enumerate(RALLY_NOTES):
        logger.debug(f"  {i}: position={n['position']:.3f}, speed={n['speed']}")

    return {"ok": True, "count": len(rally_notes)}


@app.post("/rally_notes/toggle")
async def toggle_rally_notes():
    """Attiva o disattiva l'effetto delle note rally sulle macchine."""
    global RALLY_NOTES_ENABLED
    RALLY_NOTES_ENABLED = not RALLY_NOTES_ENABLED
    state = "abilitate" if RALLY_NOTES_ENABLED else "disabilitate"
    logger.info(f"📌 Note rally {state}")
    return {"ok": True, "enabled": RALLY_NOTES_ENABLED}

@app.post("/rally_notes/set")
async def set_rally_notes(request: Request):
    """Imposta esplicitamente lo stato delle note rally (abilitate o disabilitate)."""
    global RALLY_NOTES_ENABLED
    data = await request.json()
    enabled = data.get("enabled", True)
    RALLY_NOTES_ENABLED = bool(enabled)
    state = "abilitate" if RALLY_NOTES_ENABLED else "disabilitate"
    logger.info(f"📌 Note rally impostate a {state}")
    return {"ok": True, "enabled": RALLY_NOTES_ENABLED}

# =============================================================================
# 17. CONTROLLI DI GARA (STOP, RESUME, RESTART)
# =============================================================================

@app.post("/race/stop")
def stop_race():
    """Mette in pausa la simulazione di gara."""
    global race_running
    race_running = False
    logger.info("⏸️ Gara messa in pausa")
    return {"ok": True}


@app.post("/race/resume")
def resume_race():
    """Riprende la simulazione di gara."""
    global race_running
    race_running = True
    logger.info("▶️ Gara ripresa")
    return {"ok": True}


@app.post("/race/restart")
def restart_race():
    """Riavvia la gara: reset di posizioni e stato di tutte le vetture."""
    global race_running
    race_running = True
    with lock:
        for d in devices.values():
            d["speed"] = 0
            d["accX"] = 0
            d["distance"] = 0
            d["tyre"] = 100
            d["pit_time"] = 0
            d["in_pit"] = False
            d["last_update"] = time.time()
            d["speed_buffer"].clear()
            d["acc_buffer"].clear()
            d["current_lap_start_time"] = time.time()
            d["best_lap_time"] = float('inf')
            d["last_lap_count"] = 0
    logger.info("🔄 Gara riavviata")
    return {"ok": True}


@app.get("/race/status")
def race_status():
    """Restituisce lo stato corrente della gara."""
    return {"running": race_running}

# =============================================================================
# 18. PROXY PER I PULSANTI GPS DELL'ESP32
# =============================================================================

@app.post("/esp/record")
async def esp_record():
    """Proxy per attivare la registrazione GPS sull'ESP32."""
    async with httpx.AsyncClient(timeout=2.0) as client:
        try:
            resp = await client.post(
                f"{ESP_URL}/button/gps_record_button/press",
                headers={"Content-Length": "0"}
            )
            return {"ok": True, "status": resp.status_code}
        except Exception as e:
            logger.error(f"Errore proxy record: {e}")
            return {"ok": False, "error": str(e)}


@app.post("/esp/send")
async def esp_send():
    """Proxy per inviare il tracciato GPS al backend."""
    async with httpx.AsyncClient(timeout=5.0) as client:
        try:
            resp = await client.post(
                f"{ESP_URL}/button/gps_send_button/press",
                headers={"Content-Length": "0"}
            )
            return {"ok": True, "status": resp.status_code}
        except Exception as e:
            logger.error(f"Errore proxy send: {e}")
            return {"ok": False, "error": str(e)}

# =============================================================================
# 19. INTERFACCIA AI (OLLAMA ENGINE SYSTEM)
# =============================================================================

@app.post("/ask_ai")
async def ask_ai(req: Request):
    """
    Interroga il modello Ollama con un contesto di telemetria live.
    Se viene fornito un device_id, la risposta è focalizzata su quella vettura.

    Corpo richiesta: {"question": "...", "device_id": "..."} (device_id opzionale)
    """
    try:
        data = await req.json()
        q = data.get("question", "")
        selected_device = data.get("device_id", None)

        # Prepara snapshot delle vetture
        snapshot_cars = []
        with lock:
            if not devices:
                return {"answer": "Non ci sono vetture in pista al momento, Signore."}

            sorted_items = sorted(devices.items(), key=lambda x: x[1]["distance"], reverse=True)
            for pos, (name, d) in enumerate(sorted_items, 1):
                snapshot_cars.append({
                    "pos": pos,
                    "name": name,
                    "in_pit": bool(d.get("in_pit", False)),
                    "speed": float(d.get("speed", 0.0)),
                    "distance": float(d.get("distance", 0.0)),
                    "compound": str(d.get("compound", "unknown")).upper(),
                    "tyre": float(d.get("tyre", 100.0)),
                    "best_lap_time": float(d.get("best_lap_time", float('inf')))
                })

        telemetry_context = ""
        target_car = None
        track_len = TRACK_LENGTH_METERS if TRACK_LENGTH_METERS > 0 else 2000.0

        if selected_device:
            for c in snapshot_cars:
                if c["name"] == selected_device:
                    target_car = c
                    break

        if target_car:
            best_lap_str = f"{round(target_car['best_lap_time'], 3)}s" if target_car["best_lap_time"] != float('inf') else "Nessuno"
            status = "AI BOX" if target_car["in_pit"] else "IN PISTA"
            telemetry_context = f"""
Vettura selezionata: {target_car['name']}
Posizione: P{target_car['pos']} ({status})
- Velocità attuale: {round(target_car['speed'], 1)} km/h
- Distanza totale: {round(target_car['distance'], 1)} metri (Giri: {int(target_car['distance'] // track_len)})
- Integrità Gomme ({target_car['compound']}): {round(target_car['tyre'], 1)}%
- Miglior tempo sul giro (Best Lap): {best_lap_str}
"""
            telemetry_context += "\n\nAltre vetture in pista (per contesto):\n"
            for c in snapshot_cars:
                if c["name"] != selected_device:
                    best_lap_str2 = f"{round(c['best_lap_time'], 3)}s" if c["best_lap_time"] != float('inf') else "Nessuno"
                    status2 = "AI BOX" if c["in_pit"] else "IN PISTA"
                    telemetry_context += f"- P{c['pos']} {c['name']} ({status2}) | Vel: {round(c['speed'],1)} km/h | Gomme: {round(c['tyre'],1)}% | Best: {best_lap_str2}\n"
        else:
            for c in snapshot_cars:
                best_lap_str = f"{round(c['best_lap_time'], 3)}s" if c["best_lap_time"] != float('inf') else "Nessuno"
                status = "AI BOX" if c["in_pit"] else "IN PISTA"
                telemetry_context += f"""
Posizione P{c['pos']} -> Vettura: {c['name']} ({status})
  - Velocità attuale: {round(c['speed'], 1)} km/h
  - Distanza totale: {round(c['distance'], 1)} metri (Giri: {int(c['distance'] // track_len)})
  - Integrità Gomme ({c['compound']}): {round(c['tyre'], 1)}%
  - Miglior tempo sul giro (Best Lap): {best_lap_str}
------------------------------------"""

        # Costruzione del prompt
        if target_car:
            prompt = f"""
Sei un Ingegnere di Pista della Formula 1 esperto, cinico, ironico e focalizzato sulla strategia.
Rispondi in italiano al pilota o al team manager usando i dati della telemetria live forniti qui sotto.

Il pilota sta chiedendo informazioni specifiche sulla vettura "{selected_device}".
Concentrati SOLO su questa vettura e rispondi esclusivamente in base ai suoi dati.
Ignora le altre vetture a meno che non servano per fare un confronto utile (es. gap dal leader).

=== TELEMETRIA COMPLETA LIVE (CONFIGURAZIONE CIRCUITO: {track_len:.1f}m per giro) ===
{telemetry_context}

Domanda del muretto box / pilota (riferita alla vettura "{selected_device}"):
"{q}"

Risposta tecnica e concisa dell'Ingegnere di Pista:
"""
        else:
            prompt = f"""
Sei un Ingegnere di Pista della Formula 1 esperto, cinico, ironico e focalizzato sulla strategia.
Rispondi in italiano al pilota o al team manager usando i dati della telemetria live forniti qui sotto.

=== TELEMETRIA COMPLETA LIVE (CONFIGURAZIONE CIRCUITO: {track_len:.1f}m per giro) ===
{telemetry_context}

Domanda del muretto box / pilota:
"{q}"

Risposta tecnica e concisa dell'Ingegnere di Pista:
"""

        # Chiamata a Ollama
        async with httpx.AsyncClient(timeout=180.0) as client:
            r = await client.post(
                OLLAMA_URL,
                json={"model": MODEL, "prompt": prompt, "stream": False}
            )
            r_data = r.json()
            answer = r_data.get("response", "")

        return {"answer": answer or "Nessun segnale radio dall'AI."}

    except Exception as e:
        logger.error(f"Errore comunicazione con Ollama: {e}")
        return {"answer": f"Errore di comunicazione radio (Ollama): {str(e)}"}

# =============================================================================
# 20. SERVIZIO STATICO (per servire i file HTML/CSS/JS)
# =============================================================================

app.mount("/", StaticFiles(directory="."), name="static")