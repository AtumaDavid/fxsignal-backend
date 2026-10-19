# Deploy the backend

Quick reference. The full setup story is in [README.md](README.md) (AWS EC2 deployment guide).

## 1. Push from the laptop

```bash
cd ~/new-saass/fxsignal/backend
npm test                 # don't push a broken build
git add -A && git commit -m "..."
git push origin main
```

## 2. Open the server

```bash
ssh -i /home/atuma-david/Downloads/fxsignal.pem ec2-user@fxsignal.duckdns.org
```

If it times out, your IP ch~/deploy.shanged. Check it with `curl -s ifconfig.me`, then in AWS go to **EC2 → Security groups → sg-02a75fee224a4a99b → Edit inbound rules**, set the SSH rule to **My IP**, and save.

## 3. Deploy

On the server:

```bash
~/deploy.sh
```

The script pulls, runs `npm install` and `prisma generate`, runs the tests (a failure stops the deploy), and restarts PM2.

## 4. If `prisma/schema.prisma` changed

`deploy.sh` does not touch the database tables. Push them yourself and read the warnings first, because `db push` can drop data.

If you skip this step, the API starts and `/health` says OK, but login and other pages return **500**. The logs show `The column ... does not exist in the current database` (Prisma error P2022).

Run on the server, from `~/fxsignal-backend`. These lines build the direct Neon URL from `.env` by removing `-pooler`, so you don't paste the password:

```bash
cd ~/fxsignal-backend
DIRECT_URL=$(grep '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"' | sed 's/-pooler//')
echo "$DIRECT_URL" | sed 's/:[^:@]*@/:***@/'     # check: the host must NOT contain -pooler
DATABASE_URL="$DIRECT_URL" npx prisma db push
pm2 restart fxsignal --update-env
pm2 logs fxsignal --lines 20 --nostream          # the "column does not exist" errors should be gone
```

- Success prints `Your database is now in sync with your Prisma schema.` If it warns about data loss instead, stop and check before accepting.
- Keep the quotes around `"$DIRECT_URL"`. The URL contains `&`, and unquoted the shell cuts the command at that point.
- Don't start the line with `#`. That makes it a comment, and nothing runs.

## 5. If `.env.example` changed

Compare it with the server's `.env` and add any new variables:

```bash
cd ~/fxsignal-backend
git diff HEAD@{1} HEAD -- .env.example   # what the last pull changed
nano .env
pm2 restart fxsignal --update-env
```

## 6. Check it's running

```bash
pm2 status
pm2 logs fxsignal --lines 30 --nostream
curl -i localhost:4004/health                      # on the server
curl -i https://fxsignal.duckdns.org/health        # from anywhere
```

`/health` should return `{"ok":true,...,"database":"connected"}`.

## Pending for the current release

- [ ] **`prisma db push`** (step 4): this release adds the `PaperSignal` table. If the previous release's push (the `alertTargets` / `entryTrigger` columns, `SpreadSample`) never succeeded, the same push covers that too.
- [ ] Optional `.env` additions (defaults are fine; leave them empty):
  - `SIGNAL_SCANS`: empty = `rearm`. `hourly` backtested worse, so keep it off.
  - `PAPER_LEVEL_MODEL`: empty = `zones`. Set `off` to stop paper trading.
  - `COMMISSION_PIPS`: only for a raw-spread account, e.g. `0.7`.
  - From the last release: `SIGNAL_LEVEL_MODEL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `OANDA_API_TOKEN`.
- [ ] MT5 users: download the sync add-on again (v1.1), compile it once in MetaEditor, and reattach it (if not done last release).

What changes for subscribers: calls now need Daily and H4 to agree, and stand aside at extreme volatility. That means fewer signals, and stand-asides show the reason. The same setup is not republished within 6 hours.

Tick these off and clear the list after each release.

## Everyday commands

| Task                         | Command                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| SSH in (laptop)              | `ssh -i /home/atuma-david/Downloads/fxsignal.pem ec2-user@fxsignal.duckdns.org`           |
| Deploy (server)              | `~/deploy.sh`                                                                             |
| Status                       | `pm2 status`                                                                              |
| Live logs (Ctrl+C to leave)  | `pm2 logs fxsignal`                                                                       |
| Restart after editing `.env` | `pm2 restart fxsignal --update-env`                                                       |
| Roll back one commit         | `cd ~/fxsignal-backend && git reset --hard HEAD~1 && npm install && pm2 restart fxsignal` |
| Leave the server             | `exit`                                                                                    |
