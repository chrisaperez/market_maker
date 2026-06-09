# Deploying Market Maker to Fly.io

The whole app (API + WebSocket + the built web UI) runs as **one always-on container**
with a **persistent volume** for the SQLite database. This keeps it simple and is a great
fit for a friends-scale market.

> One-time tools: install the Fly CLI — `brew install flyctl` (macOS) or
> `curl -L https://fly.io/install.sh | sh`. Then `fly auth signup` (or `fly auth login`).

## First deploy

Run these from the repo root (`/Users/chris/market_maker`):

```bash
# 1. Create the app from the included fly.toml (pick a unique name + a region).
#    --no-deploy so we can set up the volume + secret first.
fly launch --no-deploy

# 2. Create the persistent volume IN THE SAME REGION you picked above
#    (this is where the SQLite DB lives). 1 GB is plenty.
fly volumes create data --size 1 --region <your-region>

# 3. Set a stable signing secret for login sessions (keep it private).
fly secrets set MM_JWT_SECRET=$(openssl rand -hex 48)

# 4. Ship it.
fly deploy

# 5. Open it and grab the URL to share with friends.
fly open
```

Your app will live at `https://<app-name>.fly.dev`. Share that link — friends open it,
request to join, and you approve them (you'll get the live ping in-app).

## Updating

```bash
fly deploy        # after any code change
fly logs          # tail server logs
fly status        # machine + volume status
```

## Important notes

- **Keep it to one machine.** SQLite lives on a single volume, so don't scale to multiple
  machines (`min_machines_running = 1`, `auto_stop_machines = false` are already set to keep
  exactly one always-on machine — needed so live WebSocket connections aren't dropped).
- **Secrets:** `MM_JWT_SECRET` is set as a Fly secret so sessions survive deploys. If you ever
  rotate it, everyone is logged out (they just pick their username again on next visit).
- **Backups:** the DB is the file at `/data/market_maker.db` on the volume. `fly ssh console`
  then copy it out if you want a backup.

## Test the production build locally first (optional)

```bash
npm run build -w @mm/web                          # build the SPA → packages/web/dist
NODE_ENV=production MM_SERVER_PORT=8080 \
  npm run start -w @mm/server                      # server now also serves the built UI
# open http://localhost:8080
```
