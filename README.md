# FlashScope

Developed by Ayanna Norfleet during a Penn State faculty internship supervised by Professor Kaamran Raahemifar.

FlashScope combines company news, a Finviz screener, momentum, TradingView charts, saved price/social charts, and public social discussion.

Live website: https://flashscope-production.up.railway.app

Repository: https://github.com/ayanna-n/flashscope

## Project folders

- `app/`: dashboard components and server API routes in `app/api/`.
- `lib/`: PostgreSQL connection, database schema, filters, formatting, and shared logic.
- `public/`: static website assets.
- `worker/`: Python collection service, its dependencies, and news collection helpers. Keep the entire folder together.
- `package.json` and `package-lock.json`: website commands and dependency versions.

## Requirements

Recommended setup: Node.js 24 with npm, Python 3.11 with pip and venv, Git, and a running PostgreSQL database. These are setup targets, not a claim that every older version has been tested.

Live Finviz features require a valid Finviz API token and authorized access. External feeds require internet access and may reject or rate-limit requests. The public source code does not include private credentials or the deployed database.

## Run on another computer

### 1. Download the source

```bash
git clone https://github.com/ayanna-n/flashscope.git
cd flashscope
```

### 2. Prepare PostgreSQL

Use your own local PostgreSQL installation or a hosted PostgreSQL database. For a local installation with PostgreSQL command-line tools configured, create a new empty database:

```bash
createdb flashscope
```

Use a database account with permission to create tables and indexes. The application schema helpers and worker create their tables as needed; the worker initializes its tables when it starts. A fresh database has no historical posts, quotes, or price snapshots. It will not contain the history shown on the deployed website.

### 3. Configure private settings

Create `.env.local` in the repository root. Enter your own database details and Finviz API token using this template:

```dotenv
DATABASE_URL=postgresql://YOUR_USER:YOUR_PASSWORD@localhost:5432/flashscope
FINVIZ_API_TOKEN=YOUR_FINVIZ_TOKEN
APP_URL=http://localhost:3000
TRACK_SCREENER=1
WATCHLIST=AAPL,TSLA,NVDA,AMD,SPY
MAX_TICKERS=30
SCRAPE_INTERVAL_SECONDS=300
NEWS_INTERVAL_SECONDS=300
```

For a hosted database, use its connection string and any required SSL parameters. URL-encode special characters in database passwords. Never commit `.env.local` or real tokens. The existing `.gitignore` excludes `.env*` files.

### 4. Install and run the website

```bash
npm ci
npm run build
npm run dev
```

Open http://localhost:3000 and keep this terminal running. Next.js reads `.env.local`. Open Settings to review collection settings. For a production-style local run, stop the development server and run `npm run start` after a successful build.

### 5. Install and run the worker in a second terminal

From the same repository root:

```bash
python3 -m venv .venv
```

On macOS/Linux:

```bash
.venv/bin/python -m pip install -r worker/requirements.txt
node --env-file=.env.local -e 'const p=require("node:child_process").spawn(".venv/bin/python",["worker/social_worker.py"],{stdio:"inherit",env:process.env});p.on("exit",c=>process.exit(c??1))'
```

On Windows PowerShell, use this instead:

```powershell
.venv\Scripts\python.exe -m pip install -r worker/requirements.txt
node --env-file=.env.local -e 'const p=require("node:child_process").spawn(".venv/Scripts/python.exe",["worker/social_worker.py"],{stdio:"inherit",env:process.env});p.on("exit",c=>process.exit(c??1))'
```

The Node launch command passes `.env.local` settings to Python. Running Python directly does not load that file. Stop the worker with Ctrl+C. To collect only your WATCHLIST instead of screener tickers, set `TRACK_SCREENER=0`.

### 6. Verify the setup

- Confirm `npm run build` completes successfully.
- Confirm the website opens and the screener receives data with your Finviz token.
- Confirm worker logs show collection attempts without database connection errors.
- Check Social after a collection cycle. External provider failures can leave it empty.
- Saved charts and correlation require collected history; missing historical values should remain blank rather than be invented.

The worker must keep running for background collection. Opening the website does not start it. Both services must use the same database. The website can render even when a data provider is unavailable; a successful build alone does not verify all live feeds.

## Data interpretation and troubleshooting

Finviz snapshots and TradingView charts can use different data sources and update times. Cached data is not a streaming quote. Finviz rate limits can cause the last stored quote to be shown; allow the cooldown to finish rather than repeatedly requesting fresh data.

Social sentiment and message counts describe the posts collected by this project and the selected window. They are not guaranteed to match Stocktwits' own sentiment or message-volume scores. Watcher lines need actual saved watcher samples. A new database cannot reconstruct history that was never collected.

If Python reports `DATABASE_URL` is missing, use the environment-loading launch command above. If imports fail, install requirements inside `.venv` and keep `worker/public_news.py` beside `social_worker.py`. If PostgreSQL refuses the connection, check that the server is running and the connection string is correct.

## News sources

PR Newswire, GlobeNewswire, SEC, and FDA are collected directly. The following
sources accept RSS/Atom links produced by an approved website-to-RSS converter:

- `ACCESSWIRE_FEED_URL`
- `MT_NEWSWIRES_FEED_URL`
- `DOW_JONES_FEED_URL`
- `BENZINGA_FEED_URL`
- `TRADINGVIEW_REUTERS_FEED_URL`

Only use public or authorized feeds. A converter cannot provide access to
subscription-only content.

## Social worker

The Python worker collects public Stocktwits messages through `curl_cffi`,
reads public Reddit RSS feeds, and can read optional X converter feeds. It
deduplicates posts in PostgreSQL, extracts tracked tickers, and calculates a
basic keyword-based sentiment label.

Use the virtual environment and environment-loading commands above. The optional `--check` argument tests feeds without requiring a database; it is not a complete website or database test.

Important variables:

- `DATABASE_URL`: the same PostgreSQL database used by the website
- `APP_URL`: the website URL used to obtain the current Finviz ticker list
- `SCRAPE_INTERVAL_SECONDS`: use `300` for five-minute collection
- `WATCHLIST`: optional comma-separated fallback ticker list
- `REDDIT_SUBREDDITS`: comma-separated public subreddits
- `X_FEED_URLS`: optional comma-separated RSS/Atom converter feeds

The Social page reads posts already saved by this worker. It does not launch
the worker itself.

## Railway layout

Use three Railway services in the same project:

1. **FlashScope web service**: the Next.js application, started with
   `npm run start`.
2. **Postgres service**: provides `DATABASE_URL`.
3. **Social worker service**: set its root directory to `/worker` and its
   start command to `python social_worker.py`.

Give both the web and worker services the same `DATABASE_URL`. Set the
worker's `APP_URL` to the public FlashScope Railway URL and use a five-minute
interval to avoid excessive requests.
