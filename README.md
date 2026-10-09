# FXSignal API

Express + TypeScript + Prisma backend for FXSignal: intraday EUR/USD and USD/JPY signals (Daily + H4 context, H1 execution, M15 confirmation, minimum 1:2 reward:risk), the weekend outlook, settlement against the price path, the personal trade journal and the public track record.

- Production: **https://fxsignal.duckdns.org** (API under `/api`, health at `/health`)
- Frontend: https://fxsignal-frontend.vercel.app ([fxsignal-frontend](https://github.com/AtumaDavid/fxsignal-frontend))
- Deployment: [AWS EC2 deployment guide](#aws-ec2-deployment-guide) below

## Run locally

```bash
cp .env.example .env      # fill in DATABASE_URL and the provider keys
npm install
npm run db:init           # create tables + seed the demo account
npm run dev               # http://localhost:4004
```

Local Postgres: `docker compose up -d postgres` from the parent project (or any Postgres 16). Demo account: `demo@fxsignal.dev` / `fxsignal123`.

| Script | What it does |
| --- | --- |
| `npm run dev` | Watch mode (`tsx watch`) |
| `npm start` | Run once (`tsx src/index.ts`); used by PM2 in production |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:generate` | Generate the Prisma client |
| `npm run db:push` | Push `prisma/schema.prisma` to the database |
| `npm run db:init` | Push the schema and seed the demo user |
| `npm run db:resettle` | Re-score every expired signal with the current settlement rules (rewrites outcome rows; back up first) |

## Environment

| Variable | Purpose |
| --- | --- |
| `PORT` | API port (4004) |
| `DATABASE_URL` | Postgres connection string |
| `JWT_SECRET` | Token signing key. **Required** when `NODE_ENV=production`; generate with `openssl rand -hex 32` |
| `FRONTEND_URL` | Optional extra CORS origins, comma-separated. `https://fxsignal-frontend.vercel.app` and localhost are always allowed |
| `TWELVE_DATA_API_KEY` | Prices and candles |
| `TRADING_ECONOMICS_API_KEY` | Economic calendar (`client:secret` format) |
| `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL` | Optional model review of signals |
| `DEEPSEEK_TIMEOUT_MS`, `DEEPSEEK_MAX_TOKENS` | Model request limits (defaults 150000 / 12000) |
| `TWELVE_DATA_CREDITS_PER_MINUTE` | Credit budget per rolling minute (default 6; Basic plan cap is 8) |
| `LIVE_PROGRESS_REFRESH_MINUTES` | How often M15 candles refresh while a signal is open (default 30, 1 credit per pair; `0` disables) |
| `LIVE_DATA_ENABLED`, `AI_ANALYSIS_ENABLED` | Feature switches (`true` / `false`) |
| `MARKET_CACHE_FILE` | Optional path for the restart-safe provider cache (default `.cache/market-cache.json`) |

## API

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | — | API and database status |
| `POST` | `/api/auth/register`, `/api/auth/login`, `/api/auth/logout` | — | Accounts (20 requests/min per IP) |
| `GET` / `PATCH` | `/api/auth/me` | ✓ | Current user / update name |
| `POST` | `/api/auth/password` | ✓ | Change password |
| `GET` | `/api/dashboard` | ✓ | Signals (with live progress), outlook, events, prices, stats |
| `GET` | `/api/predictions?pair=` | ✓ | Current signal for one pair |
| `GET` | `/api/outlook/weekly?weekKey=` | ✓ | Week-ahead outlook |
| `GET` | `/api/events` | ✓ | Upcoming economic events |
| `GET` | `/api/history?days=&pair=&session=&limit=` | ✓ | Settled signals (plan-capped: Free 7 days, Pro 365) |
| `GET` | `/api/history/performance?days=` | ✓ | Hit rate, net pips, breakdowns, pips curve |
| `GET` | `/api/candles?pair=&timeframe=` | ✓ | Cached candles for charts (never calls the provider) |
| `GET` / `PUT` / `DELETE` | `/api/journal`, `/api/journal/:predictionId` | ✓ | Personal trade journal |
| `GET` / `PUT` | `/api/notifications`, `/api/notifications/settings` | ✓ | Alert bell feed / alert channels and events |
| `POST` | `/api/notifications/read`, `/push/subscribe`, `/push/unsubscribe`, `/test` | ✓ | Mark read, browser push devices, send a test alert |
| `GET` | `/api/public/track-record?days=30\|90\|365` | — | Public track record (60/min per IP, cached 5 min) |
| `GET` | `/api/billing/plans`, `/api/billing/account` | –/✓ | Plans and usage |
| `POST` | `/api/billing/checkout` | ✓ | Change plan (simulated; connect Stripe before taking payments) |

`?refresh=1` on the dashboard and outlook forces a provider pass: limited to 4 per 10 minutes per IP and one forced pass per 5 minutes server-wide.

## How the engine works

- **Market hours & windows:** spot FX trades Sunday 22:00 → Friday 22:00 UTC. Signals are published per session window: Asia 00–07 UTC (lighter: only fully aligned setups, 70%+), London 07–12, New York 12–17. Nothing new 17:00–24:00 UTC or at weekends.
- **Early re-checks:** when a trade hits target or stop during London or New York, the pair is re-read at the next H1 close (after a stop, H1 must clearly agree with the context). Max 2 trades per pair per window, one re-check per H1 candle, none in the last 45 minutes of a window. Each re-check costs ~2 Twelve Data credits (H1 + M15; Daily/H4 cached) plus one DeepSeek call.
- **Model:** Daily + H4 set the direction; H1 executes (it must not oppose the context, and its ATR and last 10 bars of structure place the zone and stop); M15 only adjusts confidence. Every signal is at least 2R from the zone midpoint, or it stands aside.
- **Model review:** DeepSeek may keep or downgrade the direction, never flip it; its levels are pushed to 2R or replaced by the engine's.
- **Trade management:** three targets, a third of the position at each: TP1 = +1R (derived), TP2 = the published 2R target (`targetPrice`), TP3 = one more R (`target3Price`, stored in the `target2Price` column). The stop trails to entry after TP1 and to TP1 after TP2, from the next candle. Scored for the whole position: −1R stop, +⅓R TP1-then-entry, +1⅓R TP2-then-TP1, +2R all three. Every step (entry, TP1, TP2, TP3, stop, trailed-stop close) is a separate alert (bell, email, push). Signals published before this keep their single target; `BREAKEVEN` remains only for rows scored under the earlier two-target rule. Schema changes are applied by the startup patch; no manual migration.
- **Settlement:** each signal is replayed on M15 candles (H1 fallback). No fill in its window means no trade. A filled trade is followed after its window, even when newer signals appear, until target or stop trades (stop first if both share a candle), or the Friday close, where it is marked to the last price. Neutral calls are never scored.
- **H1 checkpoint:** on every closed H1 candle, open signals and trades are re-checked (no model calls, ~1 Twelve Data credit per pair per hour while something is open). Before entry, a broken setup (H1 against the context, context flipped, or a close beyond the stop) is `CANCELLED` and not scored; the pair is re-read at a later H1 close with H1 required to agree again. After entry, a trade is `CLOSED_EARLY` only when the same H1 close is back through the far side of the entry zone and H1 or H4 points against it; early exits count in net pips but not the hit rate.
- **Candle-close loop & alerts:** a per-minute loop acts once per closed M15 candle (and runs the H1 checkpoint once per H1 close), only while something is open. It announces new signals, entry fills, targets/stops, cancellations and early exits once each (`SignalEvent` dedupe), and closes users' journal trades at their own stop/target. Alerts go to the in-app bell (always), email (`SMTP_*`) and browser push (`VAPID_*`) per user preferences; events older than 2 hours are logged without alerting.
- **Holds:** if a new window points the same way as a trade still open on that pair, it is published as a hold (`continuesId` → the open trade): no second entry, not scored separately. An opposite call carries a warning to close or reduce the open trade.
- **Provider budget:** all provider calls go through a restart-safe cache with single-flight requests, failure back-off and a per-minute credit budget. Web requests read the database only.

---

# AWS EC2 deployment guide

_Oct 5, 2026 — David Atuma_

The backend runs on one AWS EC2 instance in eu-north-1 behind Nginx and HTTPS at **https://fxsignal.duckdns.org**. It uses a Neon Postgres database, is kept alive by PM2, and deploys from GitHub.

Traffic: browser (Vercel frontend) → HTTPS 443 → Nginx → API on `localhost:4004` → Neon Postgres.

## Overview

| Item | Value |
| --- | --- |
| Instance name | `fxsignal` |
| Instance ID | `i-0c5ebe599981884e5` |
| Region | eu-north-1 (Stockholm) |
| AMI and type | Amazon Linux 2023, t3.micro, 8 GiB gp3 |
| Public IP | Changes if the instance is stopped and started (see [Step 7](#step-7-duckdns-domain-and-https)) |
| Security group | `sg-02a75fee224a4a99b` (launch-wizard-1) |
| Backend URL | https://fxsignal.duckdns.org |
| App port | 4004 (internal only, behind Nginx) |
| Process manager | PM2, process name `fxsignal` |
| Database | Neon Postgres, through Prisma 6 |
| Repo | github.com/AtumaDavid/fxsignal-backend |
| Key file | `fxsignal.pem` (keep it in `~/.ssh/`, `chmod 400`, never commit it) |

## Step 1: Launch the EC2 instance

Launch a t3.micro with a key pair and a security group that opens only SSH (your IP), HTTP and HTTPS. In the AWS console: **EC2 → Instances → Launch instance**.

1. Name: `fxsignal`.
2. AMI: Amazon Linux 2023.
3. Instance type: t3.micro (free-tier eligible).
4. Key pair: create a new RSA `.pem` key and download it. It cannot be downloaded again.
5. Network settings: default VPC, auto-assign public IP enabled, create a new security group.
6. SSH rule: change the source from Anywhere to **My IP**.
7. Tick **Allow HTTP** and **Allow HTTPS** from the internet.
8. Storage: 8 GiB gp3 is enough to start (20 GiB gives more room for dependencies and logs).
9. Click **Launch instance**.

Final inbound rules on `sg-02a75fee224a4a99b`:

| Type | Port | Source | Purpose |
| --- | --- | --- | --- |
| SSH | 22 | Your current IP (/32) | Admin access only |
| HTTP | 80 | 0.0.0.0/0 | Nginx, and Certbot validation |
| HTTPS | 443 | 0.0.0.0/0 | Public API traffic |

Do not open port 4004 or 3000; Nginx reaches the app internally. A temporary rule for port 3000 was added during setup and should be deleted.

**Why SSH is limited to My IP:** port 22 is the front door to the server's command line. Open to the world, bots try logins within minutes, and a leaked `.pem` would work from anywhere. The trade-off: if your IP changes you are locked out until you update the rule.

## Step 2: Connect over SSH

Connect from your own terminal with the `.pem` key. The browser **Connect** button (EC2 Instance Connect) fails here because it connects from AWS's servers, which the My IP rule blocks.

```bash
chmod 400 ~/.ssh/fxsignal.pem
ssh -i ~/.ssh/fxsignal.pem ec2-user@fxsignal.duckdns.org
```

On my laptop the key is in Downloads, so I connect with:

```bash
ssh -i /home/atuma-david/Downloads/fxsignal.pem ec2-user@fxsignal.duckdns.org
```

Use `ec2-user@<public-ip>` if the domain does not resolve from your machine. The username is `ec2-user` on Amazon Linux (`ubuntu` only on Ubuntu AMIs). A prompt like `[ec2-user@ip-172-31-33-92 ~]$` means you are in.

Optional shortcut: add this to `~/.ssh/config` on your laptop, then connect with `ssh fxsignal`.

```
Host fxsignal
    HostName fxsignal.duckdns.org
    User ec2-user
    IdentityFile ~/.ssh/fxsignal.pem
```

Two harmless messages may appear: `ksshaskpass: Unable to parse phrase` (a KDE password helper reading SSH prompts) and the post-quantum key exchange warning (informational). Don't click the **Run in CloudShell** buttons in AWS guides: CloudShell is a different machine from your server.

**If SSH times out:** your IP changed. In the security group, edit the SSH rule, choose **My IP**, and save. Check your IP with `curl -s ifconfig.me`.

## Step 3: Install Node.js and clone the repo

Run every command in the SSH terminal on the server.

```bash
sudo dnf update -y
sudo dnf install -y git
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs
node -v && npm -v

git clone https://github.com/AtumaDavid/fxsignal-backend.git
cd fxsignal-backend
npm install
```

- `cd` only moves between folders: clone first, then `cd fxsignal-backend`.
- The start script runs `tsx src/index.ts`, so no build step is needed.
- Lines like `node app.js  # or whatever your entry file is` in generic guides are placeholders; running them gives `Cannot find module`. Use `npm start`.
- If the repo is private, Git asks for your GitHub username and a personal access token as the password (or use a [deploy key](#step-9-deploying-updates)).
- `npm install` reported 6 vulnerabilities. Don't run `npm audit fix --force`: it can upgrade packages and break the app.

## Step 4: Configure `.env` and the Neon database

Create a server-only `.env`, point `DATABASE_URL` at Neon (not localhost), generate the Prisma client, and create the tables once. `.env` is never committed, so pulls don't overwrite it.

```bash
nano .env
chmod 600 .env
```

Server values (never paste real secrets into chats, tickets or docs):

| Variable | Server value |
| --- | --- |
| `PORT` | `4004` |
| `NODE_ENV` | `production` (makes `JWT_SECRET` mandatory) |
| `DATABASE_URL` | Neon connection string (below) |
| `JWT_SECRET` | Output of `openssl rand -hex 32` (not the dev secret) |
| `FRONTEND_URL` | Optional. The Vercel origin is built in; add other origins here, comma-separated, no trailing slash |
| `TWELVE_DATA_API_KEY` | Your rotated key |
| `TRADING_ECONOMICS_API_KEY` | Your rotated key, in the format the provider expects |
| `DEEPSEEK_API_KEY` | Your rotated key |
| `DEEPSEEK_MODEL` | `deepseek-v4-flash` |
| `LIVE_DATA_ENABLED` | `true` |
| `AI_ANALYSIS_ENABLED` | `true` |
| `LIVE_PROGRESS_REFRESH_MINUTES` | `30` (or `0` to save credits) |

**`DATABASE_URL`.** The laptop value `localhost:5432` doesn't exist on EC2. Use the pooled string from **Neon Console → Connect**:

```
DATABASE_URL=postgresql://neondb_owner:<PASSWORD>@<NEON_HOST>-pooler.<REGION>.aws.neon.tech/neondb?sslmode=require
```

Paste the real password in place of `<PASSWORD>`, without the angle brackets. Keep the whole value on one line with no quotes or spaces. Leaving the literal `<password>` placeholder in the file was one cause of failed logins.

**Create the tables** (once, on an empty database). Use the **direct** host (no `-pooler`), because schema pushes don't work well through the pooler. The `DATABASE_URL=...` prefix sets the variable for that one command only; don't put it in `.env`.

```bash
npm run db:generate
DATABASE_URL='postgresql://neondb_owner:<PASSWORD>@<NEON_HOST>.<REGION>.aws.neon.tech/neondb?sslmode=require' npm run db:init
npm start
```

A healthy start prints `Postgres connected and schema verified.` and `FXSignal API listening on http://localhost:4004`. Press Ctrl+C to stop it.

**Test the login outside Prisma.** Prisma reports a wrong password as "Can't reach database server", which is misleading.

```bash
sudo dnf install -y postgresql15
URL=$(grep '^DATABASE_URL=' .env | cut -d= -f2-)
psql "$URL" -c "select 1"
```

`1` and `(1 row)` mean the credentials are good; `password authentication failed` means the string in `.env` is wrong. Check what's saved without printing the password: `grep DATABASE_URL .env | sed 's/:[^:@]*@/:***@/'`.

Trading Economics returned `401 You must provide valid credentials`. It isn't fatal (signals publish without calendar context), but the key needs fixing in their dashboard.

## Step 5: Run the API with PM2

PM2 keeps the API running after you close the terminal, restarts it on crashes, and brings it back after a reboot. Run from the `fxsignal-backend` folder.

```bash
sudo npm install -g pm2
pm2 start npm --name fxsignal -- start
pm2 status
pm2 startup
```

`pm2 startup` only prints a command. Copy that exact line and run it, then save the process list:

```bash
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u ec2-user --hp /home/ec2-user
pm2 save
```

The output should end with `systemctl enable pm2-ec2-user` succeeding, which confirms the boot service exists.

Checks:

```bash
pm2 logs fxsignal --lines 30
curl -i localhost:4004/health
```

The logs should show `Postgres connected and schema verified.`, and `/health` returns `{"ok":true,...,"database":"connected"}`. (`curl localhost:4004` returns a 404: there is no route at `/`.) Press Ctrl+C to leave `pm2 logs`; the app keeps running.

## Step 6: Nginx reverse proxy

Nginx listens on 80 and 443 and forwards to the API on `localhost:4004`, so the app port never needs to be public.

```bash
sudo dnf install -y nginx
sudo systemctl enable nginx
sudo systemctl start nginx
sudo nano /etc/nginx/conf.d/fxsignal.conf
```

Config (port **4004**; generic AWS examples show 3000, which is wrong for this app):

```nginx
server {
    listen 80;
    server_name fxsignal.duckdns.org;

    location / {
        proxy_pass http://localhost:4004;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Test and reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
curl -i localhost/health
grep proxy_pass /etc/nginx/conf.d/fxsignal.conf
```

`nginx -t` must say the syntax is ok, and `proxy_pass` must show `localhost:4004`. If it shows 3000: `sudo sed -i 's/localhost:3000/localhost:4004/' /etc/nginx/conf.d/fxsignal.conf` and reload.

The API sets `trust proxy`, so rate limits see the real client IP from `X-Forwarded-For`.

## Step 7: DuckDNS domain and HTTPS

Browsers block an HTTPS site (Vercel) from calling a plain `http://` API, and Let's Encrypt won't issue a certificate for a bare IP. A free DuckDNS name plus Certbot solves both.

1. Sign in at duckdns.org and add the subdomain `fxsignal`.
2. In the **current ip** box, enter the server's public IP and click **update ip**. DuckDNS pre-fills the IP of the browser you're using (your home IP), which is wrong.
3. Verify from the server: `getent hosts fxsignal.duckdns.org` must print the server's public IP.
4. Confirm ports 80 and 443 are open in the security group.
5. Point Nginx at the domain, then get the certificate:

```bash
sudo sed -i 's/server_name .*;/server_name fxsignal.duckdns.org;/' /etc/nginx/conf.d/fxsignal.conf
sudo nginx -t && sudo systemctl reload nginx
sudo dnf install -y certbot python3-certbot-nginx
sudo certbot --nginx -d fxsignal.duckdns.org
```

Enter your email, `Y` to accept the terms, `N` for EFF emails, and choose to redirect HTTP to HTTPS. Then test:

```bash
curl -i https://fxsignal.duckdns.org/health
sudo certbot certificates
```

Certbot renews the certificate automatically.

The DuckDNS token is shown on the DuckDNS page. Don't share it: anyone holding it can change your domain's IP.

**If the IP changes:** the public IP changes when the instance is stopped and started (not on a plain reboot). Update it on duckdns.org each time, or attach an Elastic IP.

## Step 8: CORS and the Vercel frontend

The backend URL is `https://fxsignal.duckdns.org` (no trailing slash); the API lives under `/api`.

- **CORS:** `https://fxsignal-frontend.vercel.app` and localhost are allowed in code (`src/index.ts`). To allow more origins (a custom domain, Vercel preview URLs), add them to `FRONTEND_URL` in `.env`, comma-separated, then `pm2 restart fxsignal --update-env`.
- **Frontend:** production builds already call `https://fxsignal.duckdns.org/api`; no Vercel environment variable is needed. See the [frontend README](https://github.com/AtumaDavid/fxsignal-frontend#deploying-on-vercel).

Test CORS from a terminal; the response must include `Access-Control-Allow-Origin: https://fxsignal-frontend.vercel.app`:

```bash
curl -i -X OPTIONS https://fxsignal.duckdns.org/api/auth/login \
  -H "Origin: https://fxsignal-frontend.vercel.app" \
  -H "Access-Control-Request-Method: POST"
```

After any pull, compare `.env.example` with the server's `.env` for new variables: `git diff HEAD~1 HEAD -- .env.example`.

## Step 9: Deploying updates

Pushing to GitHub doesn't update the server. The server keeps running old code until it pulls and restarts. Three ways to deploy, simplest first; the manual script is in use.

### Option 1: deploy script (in use)

Create `~/deploy.sh` on the server, make it executable, and run it after each push.

```bash
#!/bin/bash
set -e
cd ~/fxsignal-backend
git pull
npm install
npm run db:generate
pm2 restart fxsignal --update-env
pm2 status
```

```bash
chmod +x ~/deploy.sh
~/deploy.sh
```

**When `prisma/schema.prisma` changes, update the tables separately** with `npx prisma db push` using the direct Neon URL, after reading its warnings (it can drop data). Don't automate this. Example: the personal trade journal added a `UserTrade` table; until it is pushed, `/api/journal` returns errors.

```bash
DATABASE_URL='<direct Neon URL>' npx prisma db push
```

A 100% CPU reading in `pm2 status` right after a restart is normal startup.

### Option 2: cron polling

The server checks GitHub every minute and runs the script when there's a new commit. A broken push goes live within a minute, so keep `main` stable.

```bash
crontab -e
```

```
* * * * * cd ~/fxsignal-backend && git fetch -q && [ "$(git rev-parse HEAD)" != "$(git rev-parse @{u})" ] && ~/deploy.sh >> ~/deploy.log 2>&1
```

If `crontab` is missing: `sudo dnf install -y cronie && sudo systemctl enable --now crond`.

### Option 3: GitHub Actions with AWS Systems Manager (SSM)

GitHub's servers can't reach port 22 (it's limited to your IP), so Actions uses SSM to run `deploy.sh` on the instance: no SSH, no stored AWS keys, no extra cost. Setup, in order:

1. Create the IAM role `fxsignal-ec2-ssm` with the policy `AmazonSSMManagedInstanceCore` and attach it to the instance (**Actions → Security → Modify IAM role**). Wait about 5 minutes and confirm the instance shows in **Systems Manager → Fleet Manager**.
2. Add the identity provider `https://token.actions.githubusercontent.com` with audience `sts.amazonaws.com` in IAM.
3. Create the role `github-deploy-fxsignal` with a web-identity trust limited to `repo:AtumaDavid/fxsignal-backend:ref:refs/heads/main`, plus an inline policy allowing `ssm:SendCommand` on the instance and the `AWS-RunShellScript` document, and `ssm:GetCommandInvocation`.
4. Add `.github/workflows/deploy.yml` (below). It runs `npm ci`, `prisma generate` and `npm run typecheck` first, then assumes the role and runs `deploy.sh` through `aws ssm send-command`.

Trust policy (replace `<ACCOUNT_ID>`):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": "repo:AtumaDavid/fxsignal-backend:ref:refs/heads/main" }
    }
  }]
}
```

Workflow:

```yaml
name: Deploy
on:
  push:
    branches: [main]
permissions:
  id-token: write
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx prisma generate
      - run: npm run typecheck
  deploy:
    needs: check
    runs-on: ubuntu-latest
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::<ACCOUNT_ID>:role/github-deploy-fxsignal
          aws-region: eu-north-1
      - name: Run deploy script on EC2
        run: |
          CMD_ID=$(aws ssm send-command \
            --instance-ids i-0c5ebe599981884e5 \
            --document-name AWS-RunShellScript \
            --parameters 'commands=["su - ec2-user -c /home/ec2-user/deploy.sh"]' \
            --query Command.CommandId --output text)
          aws ssm wait command-executed --command-id "$CMD_ID" --instance-id i-0c5ebe599981884e5 || true
          STATUS=$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id i-0c5ebe599981884e5 --query Status --output text)
          [ "$STATUS" = "Success" ]
```

If the repo is private, give the server a read-only GitHub deploy key so `git pull` works without a password. A t3.micro has 1 GB of RAM, so `npm install` can run out of memory during deploys; add a swap file if that happens.

**Rollback:** revert the commit and push, or run `git checkout <old-commit>` then `pm2 restart fxsignal`.

## Security checklist

Several secrets were pasted into an AI chat during setup, so treat them as exposed and rotate them. Never paste real keys, passwords or connection strings into chats, tickets or docs; share variable names, or replace values with `xxx`.

- [ ] Reset the Neon password (**Neon Console → Roles → neondb_owner → Reset password**), update `DATABASE_URL` in the server `.env`, then `pm2 restart fxsignal --update-env`.
- [ ] Rotate the Twelve Data, Trading Economics and DeepSeek API keys, update `.env`, and restart PM2. DeepSeek matters most: a leak can run up a bill.
- [ ] Set a strong `JWT_SECRET` with `openssl rand -hex 32`, and `NODE_ENV=production`. Changing the secret logs out existing sessions.
- [ ] Fix the Trading Economics key (it returned 401; check the exact format in their dashboard).
- [ ] Keep `.env` at `chmod 600` and out of Git.
- [ ] Delete the unused port 3000 rule from the security group.
- [ ] Keep SSH limited to My IP. Keep the `.pem` in `~/.ssh/` with `chmod 400`, and never commit it.
- [ ] Optionally regenerate the DuckDNS token (it was visible in a screenshot).
- [ ] Don't run `npm audit fix --force` blindly; review the reported vulnerabilities separately.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Browser **Connect** fails: Error establishing SSH connection | SSH rule allows only your IP; Instance Connect comes from AWS servers | SSH from your terminal with the `.pem`, or temporarily allow the Instance Connect range |
| `ssh: Connection timed out` | Your IP changed since you set the My IP rule | Security group → edit SSH rule → My IP → Save |
| `ssh: Could not resolve hostname` | Local DNS cache or no internet; domain created recently | Check `ping -c 2 8.8.8.8`, run `sudo resolvectl flush-caches`, or SSH to the IP |
| `cd https://github.com/...: No such file` | `cd` can't enter a URL | `git clone` first, then `cd fxsignal-backend` |
| `Cannot find module '.../app.js'` | Placeholder `node app.js` copied from a guide | Use `npm start` |
| `Can't reach database server at localhost:5432` | `.env` still points at the laptop database | Set `DATABASE_URL` to the Neon string |
| `Can't reach database server` at the Neon host, but the network is open | Wrong password in `.env` (a `<password>` placeholder was saved); Prisma hides auth errors behind this message | Test with `psql "$URL" -c "select 1"`; rewrite the line with the real password |
| `The table public.CurrencyPair does not exist` | Database is empty | `DATABASE_URL=<direct string> npm run db:init` once |
| `/api/journal` errors after a deploy | `UserTrade` table not created yet | `DATABASE_URL=<direct string> npx prisma db push` |
| `Trading Economics ... 401 You must provide valid credentials` | API key rejected | Check the key format in their dashboard; not fatal |
| `JWT_SECRET must be set in production` | `NODE_ENV=production` without a secret | Add `JWT_SECRET` to `.env`, restart PM2 |
| `ksshaskpass: Unable to parse phrase` | KDE password helper reading SSH prompts | Harmless; `unset SSH_ASKPASS` hides it |
| `curl localhost:4004` returns `Cannot GET /` | No route at `/` | Normal; use `/health` |
| Certbot fails | DNS still points to the wrong IP, or port 80 is closed | Fix the DuckDNS IP, open 80 and 443, retry |
| Vercel site shows a CORS error | Origin not allowed | Add it to `FRONTEND_URL`, then `pm2 restart fxsignal --update-env` |
| Deploy fails or the process is killed during `npm install` | 1 GB RAM on t3.micro | Add a swap file, or retry |

## Costs on the free tier

This setup is free or close to it. The one charge to watch is the public IPv4 address. Check **Billing → Free Tier** for your plan and remaining allowance.

| Item | Cost |
| --- | --- |
| t3.micro instance and 8 GiB disk | Free-tier eligible |
| Nginx, PM2, Certbot (Let's Encrypt), DuckDNS | Free |
| Neon Postgres | Neon's free plan |
| Public IPv4 address on a running EC2 instance | $0.005/hour, covered by the 750 hours/month EC2 free tier (first 12 months on older free-tier accounts) |
| Idle or second Elastic IP | $0.005/hour (about $3.60/month), not covered |
| Load balancer, NAT gateway, RDS | Not free; don't add them by accident |

An Elastic IP is optional. Without one, the public IP stays the same through reboots but changes after a stop and start, and you update it on duckdns.org. If you attach an Elastic IP, release it when you delete the instance. Create a zero-spend or $5 budget under **Billing → Budgets** to get an email alert.

## Command cheat sheet

| Task | Command |
| --- | --- |
| SSH in (laptop) | `ssh -i /home/atuma-david/Downloads/fxsignal.pem ec2-user@fxsignal.duckdns.org` |
| Deploy latest code (server) | `~/deploy.sh` |
| Push a schema change (server) | `DATABASE_URL='<direct Neon URL>' npx prisma db push` |
| App status | `pm2 status` |
| Live logs | `pm2 logs fxsignal` |
| Last 30 log lines, no follow | `pm2 logs fxsignal --lines 30 --nostream` |
| Restart after editing `.env` | `pm2 restart fxsignal --update-env` |
| Stop or start the app | `pm2 stop fxsignal` / `pm2 start fxsignal` |
| Health check (server) | `curl -i localhost:4004/health` |
| Health check (public) | `curl -i https://fxsignal.duckdns.org/health` |
| Test Nginx config | `sudo nginx -t && sudo systemctl reload nginx` |
| Check the certificate | `sudo certbot certificates` |
| Check DNS | `getent hosts fxsignal.duckdns.org` |
| Show the DB URL without the password | `grep DATABASE_URL .env \| sed 's/:[^:@]*@/:***@/'` |
| Test the DB login | `psql "$(grep '^DATABASE_URL=' .env \| cut -d= -f2-)" -c "select 1"` |
| Find your current IP (laptop) | `curl -s ifconfig.me` |
| Free disk / memory | `df -h /` / `free -m` |
