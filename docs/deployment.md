# Deploying iamparis-assistant

How to put the IAMPARIS assistant on a server so the live site's **Ask AI** panel (i2amparis-frontend) can use it.

The examples use `chat.iamparis.eu` for the assistant and `https://i2amparis.encludeproject.eu` for the site (the frontend's `VITE_BASE_URL`). Replace both with your real hostnames.

## What runs

One Node process (`apps/server`, Hono, run with `tsx`, no compile step):

- `/api/*`: the assistant API the Ask AI panel calls.
- `/`: the standalone chat UI, built into `apps/web/dist`.
- `data/conversations.db`: SQLite (`node:sqlite`) holding conversations. This is the only state; keep it on persistent disk.
- The curated content in `data/*.json` ships with the repo.

It also needs a **classifier**: either a TypeSafe key (hosted Jev) or Ollama with `qwen3:4b` on the same machine. Without either, exact wording still works but more questions end in a list of choices.

Two things in the server shape the setup:

1. **It listens on `127.0.0.1` only** (`apps/server/src/index.ts`). A reverse proxy on the same machine must sit in front of it. That is the setup below. It will not work as-is inside a Docker or Dokku container, where the proxy is outside: see [Docker / Dokku](#docker--dokku).
2. **It rejects unknown Host and Origin headers** (`ALLOWED_HOSTS`, `ALLOWED_ORIGINS`). Most "403 This origin is not allowed" errors after deploying come from these two settings.

## 1. Server prerequisites

A small Linux VM is enough (1–2 vCPU and 2 GB RAM with TypeSafe; at least 4 vCPU and 8 GB RAM to run `qwen3:4b` on CPU).

- Node.js **24** or newer (`node:sqlite` needs it).
- pnpm 11: `corepack enable` (the repo pins `pnpm@11.25.0`).
- nginx and certbot for HTTPS.
- A DNS record pointing `chat.iamparis.eu` to the server.
- Git access to this repository. It has no remote yet, so push it somewhere the server can clone from first.

## 2. Install

```bash
sudo useradd --system --create-home --home-dir /srv/iamparis-assistant iamparis
sudo -u iamparis git clone <repo-url> /srv/iamparis-assistant/app
cd /srv/iamparis-assistant/app
sudo -u iamparis pnpm install --frozen-lockfile   # all deps: the server runs with tsx, a devDependency
sudo -u iamparis pnpm build                       # builds apps/web/dist
sudo -u iamparis pnpm test                        # optional, needs no network or keys
```

Check out the branch you want to deploy. The fix that stops the assistant opening pages without asking is on `curated-query-policy`.

## 3. Configure `.env`

Create `/srv/iamparis-assistant/app/.env` (the server reads it from the repo root):

```ini
# Classifier: pick one explicitly in production.
IAM_CLASSIFIER_PROVIDER=typesafe
TYPESAFE_API_KEY=<key>
TYPESAFE_MODEL=jev-latest
# ...or local Qwen:
# IAM_CLASSIFIER_PROVIDER=ollama
# OLLAMA_MODEL=qwen3:4b
# OLLAMA_BASE_URL=http://127.0.0.1:11434

IAM_RESULTS_URL=https://api.iamparis.eu
PORT=8788
DATABASE_PATH=../../data/conversations.db

# Host header values accepted. Setting this replaces the default, so keep the loopback names
# for checks run on the server itself.
ALLOWED_HOSTS=chat.iamparis.eu,127.0.0.1,localhost

# Browser origins allowed to call the API: the IAMPARIS site, plus the assistant's own HTTPS
# origin. The server sees plain http behind the proxy, so its own https:// origin must be listed
# or the standalone chat UI gets 403 on every message.
ALLOWED_ORIGINS=https://i2amparis.encludeproject.eu,https://chat.iamparis.eu
```

Add any other origin the site is served from (for example `https://iamparis.eu`, or a staging host). An origin is scheme + host + port, with no trailing slash.

```bash
sudo chmod 600 /srv/iamparis-assistant/app/.env && sudo chown iamparis /srv/iamparis-assistant/app/.env
```

### If you use Ollama

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3:4b
```

Ollama has no authentication, so keep it on `127.0.0.1:11434` (its default) and never open that port. Set `OLLAMA_KEEP_ALIVE=24h` in its service environment (`sudo systemctl edit ollama`) so the model stays loaded. Otherwise the first question after an idle spell waits tens of seconds while the model loads.

## 4. Run it as a service

`/etc/systemd/system/iamparis-assistant.service`:

```ini
[Unit]
Description=IAMPARIS assistant (iamparis-assistant)
After=network-online.target
Wants=network-online.target

[Service]
User=iamparis
# The static root (../web/dist) and DATABASE_PATH are relative to this directory.
WorkingDirectory=/srv/iamparis-assistant/app/apps/server
# Same command as `pnpm start`, without depending on pnpm being on systemd's PATH.
ExecStart=/srv/iamparis-assistant/app/apps/server/node_modules/.bin/tsx --env-file-if-exists=../../.env src/index.ts
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now iamparis-assistant
journalctl -u iamparis-assistant -f        # expect: IAMPARIS Chat: http://127.0.0.1:8788
```

## 5. Reverse proxy and HTTPS

`/etc/nginx/sites-available/iamparis-assistant`:

```nginx
# The assistant has no login. Limit each IP's turns so one client cannot use up the classifier.
limit_req_zone $binary_remote_addr zone=assistant:10m rate=30r/m;

server {
    listen 80;
    server_name chat.iamparis.eu;

    location /api/conversations/ {
        limit_req zone=assistant burst=20 nodelay;
        proxy_pass http://127.0.0.1:8788;
        proxy_set_header Host $host;
        proxy_read_timeout 60s;   # a turn can wait up to 20 s on api.iamparis.eu
    }

    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_set_header Host $host;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/iamparis-assistant /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d chat.iamparis.eu
```

`proxy_set_header Host $host` passes the public hostname through, which is why it is in `ALLOWED_HOSTS`.

## 6. Point the IAMPARIS site at it

The Ask AI panel reads the assistant's address at **build time** from `VITE_ASSISTANT_URL` (`i2amparis-frontend/src/lib/utils/api/assistant.js`). Without it the panel falls back to `http://127.0.0.1:8788` and shows "The assistant is not reachable right now" in production.

In `i2amparis-frontend/Dockerfile`, next to the other `ENV` lines:

```dockerfile
ENV VITE_ASSISTANT_URL="https://chat.iamparis.eu"
```

Add the same line to `i2amparis-frontend/.env` for local production builds, then rebuild and redeploy the frontend as usual.

## 7. Check it

On the server:

```bash
curl -s http://127.0.0.1:8788/api/status
```

Expect `"available":true` for your classifier provider and `"results":"live"`.

From your machine, through the proxy, as the site would call it:

```bash
S=$(uuidgen)
ID=$(curl -s -X POST https://chat.iamparis.eu/api/conversations -H "X-IAMPARIS-Session: $S" -H "Origin: https://i2amparis.encludeproject.eu" -H "Content-Type: application/json" -d '{}' | jq -r .id)
curl -s -X POST "https://chat.iamparis.eu/api/conversations/$ID/turn" -H "X-IAMPARIS-Session: $S" -H "Origin: https://i2amparis.encludeproject.eu" -H "Content-Type: application/json" -d '{"text":"Where can I find the model catalogue?"}' | jq '.messages[-1].reply | {kind, actions}'
```

Expect `"kind": "navigation"` and a `navigate` action. Then open the live site, press **Ask AI** (Ctrl+I), and ask the same question. You should get a **Go to page** button, and the page should only change when you click it.

| Symptom | Cause |
| --- | --- |
| `403 This origin is not allowed` | The page's origin is missing from `ALLOWED_ORIGINS`, or the hostname is missing from `ALLOWED_HOSTS`. |
| Panel says "not reachable" | `VITE_ASSISTANT_URL` was not set when the frontend was built, or there is a TLS or DNS problem on the chat host. |
| `502` from nginx | The service is down: `journalctl -u iamparis-assistant`. |
| First answer takes tens of seconds | Ollama is loading the model. Set `OLLAMA_KEEP_ALIVE`. |
| `429 The assistant is busy` | Eight turns are already running (server limit), or the nginx rate limit was hit. |

## Updating

```bash
cd /srv/iamparis-assistant/app
sudo -u iamparis git pull
sudo -u iamparis pnpm install --frozen-lockfile
sudo -u iamparis pnpm build
sudo systemctl restart iamparis-assistant
```

Conversations survive restarts. To roll back, check out the previous commit and run the same steps.

When `data/curation.json` changes, run the consistency check on the server against the running service. It sends `Origin: http://127.0.0.1:5174`, so that origin must be in `ALLOWED_ORIGINS` while you run it:

```bash
node scripts/curation-check.mjs
```

## Backups

Back up the conversation database while the service runs:

```bash
sqlite3 /srv/iamparis-assistant/app/data/conversations.db ".backup /var/backups/iamparis-assistant/conversations-$(date +%F).db"
```

Run it daily from cron. Do not copy the `.db` file directly: the `-wal` file next to it holds recent writes.

## Before it is public

The README calls this a local, single-user app. On the internet, this is what protects it:

- Each browser gets a random session id, and a conversation can only be read or continued with its id. There are no accounts, so anyone can use the assistant.
- Only the listed origins can call it from a browser. Scripts can still call it directly, so the nginx rate limit is what caps the load.
- Replies only contain actions from a fixed set (open a site page, change the open chart), and the panel now runs them only when the user clicks.

If the assistant must be limited to signed-in IAMPARIS users, that needs real authentication in front of `/api`, which is not built yet.

## Docker / Dokku

The old `iam-data-chatbot` runs on Dokku. To run this one the same way, the server first needs to listen on all interfaces inside the container. Today `hostname: "127.0.0.1"` is hard-coded in `apps/server/src/index.ts`, so it needs to come from an env var (for example `HOST=0.0.0.0`). It also needs a Dockerfile on Node 24 that runs `pnpm install --frozen-lockfile && pnpm build` and starts with `pnpm start`, and a persistent volume mounted at `data/` (or `DATABASE_PATH` pointed into one). `ALLOWED_HOSTS` and `ALLOWED_ORIGINS` work as above. If Ollama runs on the host, read the container notes in the `iam-data-chatbot` README.
