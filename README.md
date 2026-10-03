# Imposter: Dead Air

> **An online social-deduction party game for 4–10 players.**  
> Built with authoritative Node.js, WebSockets, and text-first gameplay (with optional browser-native WebRTC peer voice). Zero build step, single dependency (`ws`).

---

## 🎮 How to Play (V1 Rules)

1. **Create or Join a Room:** Enter your nickname and join using a 6-character room code (4–10 players).
2. **The Secret Word:** Crew members receive the secret word and category. The Imposter receives **only the category**.
3. **Clues Phase:** Each player takes one timed turn (25s max) to submit exactly one single-word clue.
4. **Discussion Phase:** Timed discussion via text comms (with optional voice). Players can ready up to advance early.
5. **Vote:** Plurality voting with hidden choices.
   - If tied: Tied candidates enter a 15s **Defense** phase followed by a 20s **Revote** between tied players. A second tie is an Imposter win.
   - If all players abstain: Imposter wins.
6. **Final Guess:** If the Imposter is caught by vote, they enter a 30s **Final Guess** phase. If they guess the secret word (or an accepted alias), the Imposter steals the win; otherwise, Crew wins!
7. **Play Again:** The host can start a new round or return to lobby.

---

## 🚀 Quick Start (Local Development)

### Prerequisites
- Node.js >= 18.0.0
- npm

### Installation & Run

```bash
# Clone the repository
git clone https://github.com/your-username/imposter-dead-air.git
cd imposter-dead-air

# Install dependencies (only 'ws')
npm install

# Start the server (runs on http://localhost:3000)
npm start
```

### Running Tests

```bash
# Run unit tests (state machine, secret isolation, vote rules)
npm test

# Run multi-client WebSocket integration test suite
npm run test:integration

# Validate word database (categories, word counts, fuzzy collisions)
npm run validate:words
```

> **Note on Mobile Testing:** WebRTC microphone access requires HTTPS or `localhost`. When testing with mobile phones on the same local network, use a local tunnel:
> ```bash
> npx cloudflared tunnel --url http://localhost:3000
> ```

---

## 🌐 Production Deployment

The project is pre-configured for one-click deployment on persistent Node.js platforms:

### Option 1: Render (Recommended)
1. Push this repository to GitHub.
2. In [Render Dashboard](https://dashboard.render.com), click **New +** → **Blueprint**.
3. Select your repository. Render automatically reads [`render.yaml`](./render.yaml).

### Option 2: Railway
1. Go to [Railway](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
2. Railway detects [`Procfile`](./Procfile) and [`package.json`](./package.json) and launches automatically.

### Option 3: Docker / Fly.io / Self-Hosted VPS
A multi-stage, secure Alpine Docker image is provided:

```bash
# Build Docker image
docker build -t imposter-dead-air .

# Run container
docker run -p 3000:3000 imposter-dead-air
```

---

## ⚙️ Environment Variables

Copy [`.env.example`](./.env.example) to `.env` to customize settings:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | Port for the HTTP & WebSocket server. |
| `PUBLIC_URL` | `""` | Optional external URL for links / reverse proxies. |
| `TURN_URL` | `""` | TURN server URL for voice relay behind strict symmetric NAT / firewalls. |
| `TURN_USERNAME` | `""` | TURN authentication username. |
| `TURN_CREDENTIAL` | `""` | TURN authentication credential. |

---

## 🏗️ Architecture

```
┌────────────────────────────────────────────────────────┐
│                   Web Browser Client                   │
│   • public/index.html (Vanilla JS, CSS, SVG avatars)   │
│   • WebRTC Mesh Voice + AudioContext Metering          │
│   • Automatic Reconnect with 128-bit Session Tokens    │
└──────────────────────────┬─────────────────────────────┘
                           │
             WebSocket (State) & WebRTC (Signaling)
                           │
┌──────────────────────────▼─────────────────────────────┐
│                 Node.js Game Server                    │
│   • server.js: HTTP static server + WebSocket relay    │
│   • game.js: Authoritative state machine               │
│   • words.js: Curated categorized word library         │
│   • Zero data leaks: viewFor() filters secrets         │
└────────────────────────────────────────────────────────┘
```

### Security & Integrity Highlights
- **Authoritative State:** Clients cannot modify turn timers, inject votes, or force game starts without host permissions.
- **Strict Secret Isolation:** `viewFor(room, pid)` strips the secret word for the impostor and hides vote targets until round resolution.
- **DoS & Spam Protection:** Per-connection rate limiting (20 msg/sec) and payload ceiling (8 KB).
- **Session Continuity:** 128-bit session tokens stored in `localStorage` permit seamless reconnects during network drops.

---

## 📂 Repository Structure

```
├── .dockerignore        # Excluded files for container builds
├── .env.example         # Environment template
├── .gitignore           # Git ignore rules
├── Dockerfile           # Production container definition
├── LICENSE              # MIT License
├── Procfile             # Heroku/Railway process file
├── README.md            # Documentation & deployment guide
├── game.js              # Authoritative game state machine & rules
├── index.html           # Standalone client (root mirror)
├── package.json         # Package configuration & scripts
├── public/
│   └── index.html       # Primary static frontend client
├── render.yaml          # Render.com Blueprint configuration
├── server.js            # Node HTTP server & WebSocket handler
├── test-integration.js  # Live multi-client WebSocket test suite
├── test.js              # Offline unit test suite
└── words.js             # Categorized word database
```

---

## 📄 License

This project is licensed under the [MIT License](./LICENSE).
