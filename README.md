# 🏎️ F1 Telemetry & AI Race Dashboard

Benvenuto nella **F1 Multi‑Device Dashboard**, un sistema completo per il monitoraggio in tempo reale di vetture da competizione, con simulazione di gara, tracciato interattivo, grafici telemetrici, ghost car, assistente AI e tanto altro.

---

## 📌 Indice

- [Funzionalità principali](#-funzionalità-principali)
- [Tecnologie utilizzate](#-tecnologie-utilizzate)
- [Struttura dei file](#-struttura-dei-file)
- [Prerequisiti e installazione](#-prerequisiti-e-installazione)
- [Avvio del server](#-avvio-del-server)
- [Utilizzo dettagliato della dashboard](#-utilizzo-dettagliato-della-dashboard)
- [API principali (back‑end)](#-api-principali-back‑end)
- [Persistenza dei dati](#-persistenza-dei-dati)
- [Personalizzazione e ottimizzazioni](#-personalizzazione-e-ottimizzazioni)
- [Dispositivi hardware ESP32](#-dispositivi-hardware-esp32)
- [Note finali](#-note-finali)

---

## 🚀 Funzionalità principali

- **Monitoraggio live** – velocità, accelerazione, posizione in pista e classifica aggiornati ogni 50 ms (20 Hz) via WebSocket.
- **Tracciato interattivo** – disegna e modifica il circuito direttamente dal browser con:
  - **Zoom** (+ / – / reset) per ingrandire o rimpicciolire la vista.
  - **Modalità espansa** (⛶) che occupa l'intera finestra, nascondendo gli altri pannelli.
  - **Editor di tracciato** con aggiunta/rimozione punti, salvataggio e reset.
  - **Salvataggio normalizzato** – i tracciati personalizzati vengono salvati in `localStorage` con coordinate normalizzate per preservare le proporzioni.
- **Ghost Car** – confronta il giro del pilota selezionato con il miglior giro della sessione; il fantasma attende al traguardo se arriva prima dell'auto reale.
- **Follow Mode** – attiva il pulsante **🎯 Follow** per centrare automaticamente la pista sulla vettura selezionata, con movimento fluido.
- **Grafici telemetrici**:
  - Velocità istantanea (km/h)
  - Accelerazione longitudinale (AccX)
  - Profilo radar della vettura (abilità pilota, potenza motore, usura gomme, velocità massima, bias frenata)
  - **Grafico a barre orizzontali** per il gap dal leader (distanza in metri)
- **Picture‑in‑Picture (PiP)** – in modalità espansa, attiva widget flottanti per i grafici di velocità, accelerazione, gap e radar. I widget sono **trascinabili** e **ridimensionabili** (trascinando l'angolo inferiore destro).
- **AI Engineer** – interroga un modello AI locale (Ollama) per analisi strategiche e tecniche in tempo reale, utilizzando i dati live della classifica.
- **Controllo gara** – pulsanti **START/STOP** (toggle) e **RESET** per gestire la simulazione delle vetture virtuali.
- **Registrazione dispositivi** – aggiungi nuove vetture (hardware o simulate) tramite l'apposita pagina di login.
- **Classifica live** – leaderboard con:
  - Posizione (P1, P2, …) con colori per i primi tre.
  - Distanza percorsa (metri) e barra di progresso.
  - Miglior tempo sul giro (colorato in viola per il giro record, arancione per il personale best).
  - Velocità attuale e indicazione se ai box (🛑 PIT).
  - Barra di usura gomme con colore dinamico (verde → giallo → rosso).
  - **Indicatore di sorpasso** (↑ / ↓) persistente per 5 secondi con flash arancione sulla riga.
- **Note rally** – importa da file JSON un insieme di note (posizione, velocità consigliata, pericolosità) che influenzano il comportamento delle vetture simulate, con visualizzazione a punti colorati sul tracciato.
- **Gestione cache HTTP** ottimizzata: risorse statiche in cache 1 anno, API e HTML in no‑cache.
- **Persistenza opzionale su InfluxDB** – salva i dati di telemetria e i tempi sul giro per analisi storiche.

---

## 🧱 Tecnologie utilizzate

| Componente               | Tecnologia                               |
|--------------------------|------------------------------------------|
| **Backend**              | Python 3.9+ con FastAPI, Uvicorn         |
| **Database time‑series** | InfluxDB (opzionale)                     |
| **AI**                   | Ollama (modello `qwen2.5:1.5b` o simile) |
| **Frontend**             | HTML5, CSS3, JavaScript (ES6)            |
| **Grafici**              | Chart.js 4.x con plugin ChartDataLabels  |
| **Rendering tracciato**  | Canvas 2D nativo con animazione a 60 FPS |
| **Comunicazione**        | WebSocket (broadcast), HTTP/REST (fetch) |

---

## 📁 Struttura dei file

```
/
├── app.js              # Frontend JavaScript (dashboard, tracciato, zoom, ghost, editor, PiP, grafici)
├── index.html          # Pagina principale della dashboard
├── login.html          # Pagina di registrazione dispositivi
├── style.css           # Fogli di stile (tema scuro F1)
├── web_server.py       # Backend FastAPI (simulazione, API, InfluxDB, Ollama, WebSocket)
└── README.md           # Questo file
```

---

## ⚙️ Prerequisiti e installazione

### 1. Python e dipendenze

Assicurati di avere Python 3.9+ installato. Installa le librerie richieste:

```bash
pip install fastapi uvicorn httpx influxdb-client
```

### 2. InfluxDB (opzionale)

Se desideri salvare i dati storici di telemetria, puoi installare InfluxDB (2.x) localmente o usare un container Docker:

```bash
docker run -d --name influxdb -p 8086:8086 \
  -e INFLUXDB_DB=race_data \
  -e INFLUXDB_ADMIN_USER=admin \
  -e INFLUXDB_ADMIN_PASSWORD=password \
  influxdb:2.7
```

Crea un bucket (es. `race_data`) e un token di accesso, quindi aggiorna le variabili in `web_server.py`:

- `INFLUX_ENABLED = True`
- `INFLUX_URL`, `INFLUX_TOKEN`, `INFLUX_ORG`, `INFLUX_BUCKET`

Se non utilizzi InfluxDB, lascia `INFLUX_ENABLED = False` e il backend funzionerà comunque perfettamente.

### 3. Ollama (per l'AI)

Installa Ollama dal sito ufficiale e scarica il modello consigliato:

```bash
ollama pull qwen2.5:1.5b
```

Assicurati che Ollama sia in esecuzione su `http://localhost:11434`. Puoi cambiare il modello modificando la costante `MODEL` in `web_server.py`.

### 4. (Facoltativo) Dispositivi hardware ESP32

Se possiedi un ESP32 con sensore di accelerazione e velocità, puoi inviare dati all'endpoint `/api/telemetry` del backend. Il sistema riconosce i device con prefisso `ESP32` e li esclude dalla simulazione automatica. Per i pulsanti di registrazione/invio GPS, è previsto un proxy verso l'ESP32 (modifica `ESP_URL` in `web_server.py` se necessario).

---

## 🚀 Avvio del server

Lancia il backend FastAPI (che serve anche i file statici):

```bash
uvicorn web_server:app --host 0.0.0.0 --port 8000
```

Apri il browser su `http://192.168.1.70:8000` (o l'IP del tuo server) per visualizzare la dashboard.

> **Nota**: il frontend è configurato per puntare a `http://192.168.1.70:8000`. Se il server è su un altro IP, modifica la costante `BACKEND_URL` in `app.js` e l'URL in `login.html`.

---

## 🖥️ Utilizzo dettagliato della dashboard

### 🔐 Registrazione di un nuovo dispositivo

1. Clicca su **🔐 Login** nella topbar.
2. Inserisci un ID dispositivo (es. `car_1`, `esp32_01`) e premi **Register Device**.
3. Il dispositivo apparirà nella lista a tendina della topbar e inizierà a essere simulato (se virtuale) o riceverà dati via API.

### 🏁 Selezionare una vettura

Usa il menu a tendina al centro della topbar per scegliere la vettura da monitorare. I grafici, la classifica e la ghost car si aggiorneranno in tempo reale.

### 🎮 Controlli gara

- **START/STOP** – avvia o mette in pausa la simulazione delle vetture virtuali (le vetture hardware continuano a inviare dati).
- **RESET** – resetta tutte le vetture (distanza zero, gomme nuove, buffer azzerati) e ferma la simulazione.

### 🗺️ Editor del tracciato

1. Clicca su **Editor** per aprire i controlli.
2. Clicca su **EDIT TRACK** per entrare in modalità disegno.
3. **Clicca sul canvas** per aggiungere punti (in senso orario o antiorario). I punti vengono visualizzati in tempo reale.
4. Usa **UNDO POINT** per rimuovere l'ultimo punto.
5. Premi **SAVE TRACK** per salvare il circuito personalizzato:
   - Le coordinate vengono **normalizzate** (centrate e scalate) e salvate nel `localStorage`.
   - Al caricamento, vengono denormalizzate con una scala fissa (`TRACK_SCALE = 1000`) per preservare le proporzioni.
6. **RESET TRACK** ripristina il tracciato di default.

### 🔍 Zoom e visualizzazione

- **Rotellina del mouse** – zoom in/out centrato sul canvas.
- **⟲** – ripristina lo zoom a 1.0 e resetta il pan.
- **⛶** – **modalità espansa**: il tracciato occupa tutta la finestra, nascondendo grafici, controlli e leaderboard. Clicca di nuovo per tornare alla vista normale.
- **🎯 Follow** – attiva la modalità follow: la pista si centra automaticamente sulla vettura selezionata. Il movimento è fluido e graduale. Clicca di nuovo per disattivare.

### 📺 Picture‑in‑Picture (PiP)

In modalità espansa, nella barra del tracciato compaiono i pulsanti per attivare widget flottanti per i grafici:

- 📈 **Speed** – andamento della velocità
- 📉 **G‑Force** – accelerazione longitudinale
- 🏁 **Gap** – distanza dal leader (grafico a barre)
- 🎯 **Radar** – profilo della vettura

I widget sono **trascinabili** (cliccando sull'intestazione) e **ridimensionabili** trascinando l'angolo inferiore destro. Mostrano il valore corrente (es. velocità in km/h, gap in metri) nell'intestazione. Ogni widget può essere chiuso singolarmente con il pulsante ✕.

### 👻 Ghost Car

- Quando una vettura segna un nuovo **giro record** (best lap assoluto), appare un fantasma (pallino ciano) che segue il giro del leader.
- Il fantasma **attende al traguardo** se arriva prima dell'auto selezionata, e riparte quando quest'ultima taglia la linea.
- La ghost car è sincronizzata con il tempo del giro record e si adatta automaticamente quando un nuovo record viene stabilito.

### 📊 Grafici telemetrici

- **Real‑time Speed** – andamento della velocità negli ultimi 50 campioni.
- **G‑Force Acceleration (AccX)** – accelerazione longitudinale.
- **Driver & Car Profile** – grafico radar con 5 parametri della vettura selezionata (valori normalizzati).
- **Gap to Leader** – grafico a barre orizzontali che mostra la distanza (in metri) di ogni vettura dal leader.

### 🧠 Assistente AI (Race Control)

Nella sezione **Race Control**:

- Scrivi una domanda nel campo di input (es. "*Qual è la strategia migliore per la vettura car_1?*").
- Premi **Send Request** o premi `Invio`.
- L'AI risponderà utilizzando i dati telemetrici attuali (classifica, velocità, gomme, tempi) fornendo analisi tattiche e suggerimenti.

### 📋 Note rally

Carica un file JSON contenente note di percorrenza per influenzare il comportamento delle vetture simulate. Il formato atteso è un array di oggetti con:

- `position` (float, 0..1) – frazione di giro
- `speed` (number) – velocità consigliata in km/h
- `danger` (int, opzionale) – livello di pericolosità (1=verde, 2=arancione, 3=rosso)
- `note` (stringa, opzionale) – descrizione

Le note vengono visualizzate sul tracciato con cerchi colorati e influenzano la velocità target delle vetture simulate. Puoi attivarle/disattivarle con il pulsante **📋 Nascondi/Mostra Note**.

---

## 📡 API principali (back‑end)

| Endpoint             | Metodo | Descrizione |
|----------------------|--------|-------------|
| `/register_device`   | POST   | Registra un nuovo dispositivo |
| `/remove_device`     | POST   | Rimuove un dispositivo |
| `/devices`           | GET    | Lista di tutti i device attivi |
| `/telemetry`         | GET    | Dati telemetrici (speed, accX, profilo) per un device, ultimi n campioni |
| `/api/telemetry`     | POST   | Ingresso dati da ESP32 (hardware) |
| `/race/stop`         | POST   | Ferma la simulazione |
| `/race/resume`       | POST   | Riprende la simulazione |
| `/race/restart`      | POST   | Riavvia la gara |
| `/race/status`       | GET    | Restituisce lo stato corrente (running/fermo) |
| `/ask_ai`            | POST   | Interroga l'AI con una domanda strategica (contesto telemetrico) |
| `/upload_track`      | POST   | Carica un tracciato GPS (array di punti [lat, lon]) |
| `/get_track`         | GET    | Restituisce il tracciato corrente (punti scalati e lunghezza) |
| `/upload_rally_notes`| POST   | Carica le note rally (array di oggetti con position, speed, ...) |
| `/esp/record`        | POST   | Proxy per avviare/fermare la registrazione GPS sull'ESP32 |
| `/esp/send`          | POST   | Proxy per inviare il tracciato GPS dall'ESP32 al backend |
| `/ws`                | WS     | Connessione WebSocket per broadcast in tempo reale (20 Hz) |

---

## 🗃️ Persistenza dei dati

- **Tracciato personalizzato** – salvato nel `localStorage` del browser sotto la chiave `f1_custom_track_points`. I punti vengono memorizzati in **coordinate normalizzate** (centrate e scalate) per preservare le proporzioni al caricamento.
- **Dati di telemetria storica** – se InfluxDB è configurato, vengono salvati nei bucket:
  - `telemetry`: velocità, accelerazione, usura gomme (timestamp)
  - `lap_times`: numero del giro e durata (timestamp)
- **Stato in memoria** – tutti i dati live (velocità, posizione, buffer telemetrici) risiedono nel dizionario `devices` del backend e vengono persi al riavvio del server.

---

## ⚡ Personalizzazione e ottimizzazioni

- **Lunghezza del tracciato** – modificare `TRACK_LENGTH_METERS` in `web_server.py` (default 2000 m).
- **Scala di base** – `TRACK_SCALE` in `app.js` (default 1000) controlla la dimensione del tracciato normalizzato.
- **Numero di punti nei grafici** – modificare il parametro `n=50` nelle chiamate a `/telemetry` in `app.js`.
- **Frequenza di simulazione** – il thread di simulazione dorme `50 ms` (20 Hz); modificare `time.sleep(0.05)` in `simulate()`.
- **Frequenza WebSocket** – il broadcast invia dati ogni `50 ms`; modificare `await asyncio.sleep(0.05)` in `broadcast_telemetry()`.
- **Colori e stili** – personalizzare le variabili CSS in `style.css` (tema scuro F1).
- **Modello AI** – cambiare `MODEL` in `web_server.py` con un altro modello Ollama disponibile.
- **Dimensioni e posizione dei widget PiP** – modificare le dimensioni in `getPipCanvas()` e le regole CSS per `.pip-item`.
- **Cache HTTP** – il middleware nel backend gestisce la cache per statiche (1 anno) e API (nessuna cache). Modificare le estensioni o i percorsi nella funzione `cache_control_middleware`.

---

## 🔌 Dispositivi hardware ESP32

Il backend è progettato per ricevere dati telemetrici da un ESP32 (o qualsiasi dispositivo) tramite l'endpoint `/api/telemetry`. Il formato atteso è un JSON con:

```json
{
  "device_id": "ESP32_F1",
  "speed": 123.4,
  "accel": 2.5
}
```

Il campo `accel` può essere sostituito da `accX`. Il backend applica una compensazione di offset (+9.43) per adattarsi ai sensori comunemente usati.

I pulsanti nella dashboard per **Registra GPS** e **Invia GPS** utilizzano i proxy `/esp/record` e `/esp/send` che inviano richieste all'ESP32 all'indirizzo configurato (`ESP_URL`). Assicurati che l'ESP32 esponga gli endpoint `/button/gps_record_button/press` e `/button/gps_send_button/press`.

---

## 📧 Note finali

Questo progetto è stato sviluppato per scopi dimostrativi e didattici. Puoi modificarlo e adattarlo liberamente alle tue esigenze. Per qualsiasi problema, controlla i log del server (che ora utilizzano il modulo `logging`) e la console del browser.

**Buona gara!** 🏁
