#!/usr/bin/env bash
#
# A throwaway Postgres for the machine you are sitting at.
#
# Why this exists: until now the only two ways to reach a database were the
# shared Supabase project (real credentials, real append-only history) and
# PGlite inside `vitest` (in-process, test-only). Anyone who wanted to click
# through the actual app — QA above all — had neither. `.env.example` pointed at
# `localhost:5432` and nothing was listening there, so `POST /api/events` and
# every verdict write answered 503 and the behaviour pipe had never once been
# watched end to end through a browser. See ADR 0009.
#
# What you get: PostgreSQL 17 from the `embedded-postgres` npm package — real
# server binaries, not WebAssembly — on port 55432, with all migrations applied,
# the event registry seeded, and partitions created. It holds nothing but what
# you put in it, and `reset` throws it away.
#
# NOT PGlite: PGlite serves one connection at a time. A QA pass that mashes the
# submit button would queue behind itself and produce timeouts that look like
# product bugs and are not. `src/lib/db/test-database.ts` keeps using PGlite,
# which is the right tool for a unit test.
#
# Usage:
#   npm run db:local          # start (idempotent) and print the URL to paste
#   npm run db:local:stop     # stop, keep the data
#   npm run db:local:reset    # stop and delete the data directory
#   bash scripts/local-postgres.sh status
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$REPO_ROOT/.local-postgres"
DATA_DIR="$STATE_DIR/data"
LOG_FILE="$STATE_DIR/postgres.log"
PORT="${LOCAL_PG_PORT:-55432}"
DB_NAME="steamkid"
DB_USER="steamkid"
DB_PASSWORD="steamkid"

# `sslmode=disable` is load-bearing, not tidy-up. `src/lib/db/pg-connection.ts`
# treats an absent `sslmode` the way the deployed URLs need it treated —
# encrypt, do not verify — so a URL without it makes every `pg` caller demand
# TLS from a local server that does not speak it and die with "The server does
# not support SSL connections". The Prisma CLI is more forgiving, so migrations
# apply and the app still cannot connect: the same split that cost PRO-68 a day.
LOCAL_URL="postgresql://$DB_USER:$DB_PASSWORD@127.0.0.1:$PORT/$DB_NAME?sslmode=disable"

case "$(uname -s)" in
  Linux) PLATFORM=linux ;;
  Darwin) PLATFORM=darwin ;;
  *) echo "local-postgres.sh: unsupported OS $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  arm64 | aarch64) ARCH=arm64 ;;
  *) echo "local-postgres.sh: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

NATIVE_DIR="$REPO_ROOT/node_modules/@embedded-postgres/$PLATFORM-$ARCH/native"
PG_BIN="$NATIVE_DIR/bin"

export LD_LIBRARY_PATH="$NATIVE_DIR/lib:${LD_LIBRARY_PATH:-}"
export DYLD_LIBRARY_PATH="$NATIVE_DIR/lib:${DYLD_LIBRARY_PATH:-}"

ensure_binaries() {
  if [ ! -d "$NATIVE_DIR" ]; then
    echo "local-postgres.sh: @embedded-postgres/$PLATFORM-$ARCH is not installed." >&2
    echo "Run \`npm install\` first." >&2
    exit 1
  fi

  # The package ships its binaries as entries in `native/pg-symlinks.json` and
  # materialises them in a postinstall hook. npm 11 defers install scripts
  # unless they are approved (`npm install-scripts approve`), and a runner that
  # has not approved them gets a `native/` tree with no `bin/postgres` in it.
  # Running the hydrator ourselves is idempotent and removes that trap.
  if [ ! -x "$PG_BIN/postgres" ]; then
    echo "Materialising Postgres binaries..."
    node "$REPO_ROOT/node_modules/@embedded-postgres/$PLATFORM-$ARCH/scripts/hydrate-symlinks.js"
  fi

  if [ ! -x "$PG_BIN/postgres" ]; then
    echo "local-postgres.sh: still no postgres binary at $PG_BIN" >&2
    exit 1
  fi
}

is_running() {
  [ -d "$DATA_DIR" ] && "$PG_BIN/pg_ctl" -D "$DATA_DIR" status >/dev/null 2>&1
}

# The server binaries are all we get — this package ships no `psql` and no
# `createdb` — so anything that needs to talk SQL goes through `pg`, which is
# already a dependency of the app.
psql_node() {
  node -e '
    const { Client } = require("pg");
    const [url, sql] = process.argv.slice(1);
    (async () => {
      const client = new Client({ connectionString: url, ssl: false });
      await client.connect();
      try {
        const result = await client.query(sql);
        if (result.rows?.length) console.log(JSON.stringify(result.rows));
      } finally {
        await client.end();
      }
    })().catch((error) => {
      console.error(String(error.message ?? error));
      process.exit(1);
    });
  ' "$1" "$2"
}

start() {
  ensure_binaries
  mkdir -p "$STATE_DIR"

  if is_running; then
    echo "Already running on port $PORT."
  else
    if [ ! -s "$DATA_DIR/PG_VERSION" ]; then
      echo "Initialising a new cluster in $DATA_DIR ..."
      rm -rf "$DATA_DIR"
      mkdir -p "$DATA_DIR"
      printf '%s' "$DB_PASSWORD" > "$STATE_DIR/.initpw"
      "$PG_BIN/initdb" -D "$DATA_DIR" -U "$DB_USER" \
        --pwfile="$STATE_DIR/.initpw" -A md5 -E UTF8 >/dev/null
      rm -f "$STATE_DIR/.initpw"
    fi

    echo "Starting Postgres on 127.0.0.1:$PORT ..."
    # No Unix socket, TCP only. `-k "$STATE_DIR"` was the obvious choice and it
    # is unusable here: a Unix socket path is capped at 107 bytes by the kernel,
    # and a Paperclip workspace checkout is already ~121 bytes before
    # `/.local-postgres/.s.PGSQL.55432` is appended. Postgres then refuses to
    # start at all — "could not create any Unix-domain sockets" — and `pg_ctl`
    # reports only "could not start server. Examine the log output." Nothing
    # here talks over the socket anyway: `psql_node`, Prisma and the app all
    # dial 127.0.0.1:$PORT. `pg_ctl -w` waits over TCP when there is no socket,
    # the same path it takes on Windows.
    if ! "$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" -w \
      -o "-p $PORT -c unix_socket_directories='' -c listen_addresses=127.0.0.1" \
      start >/dev/null; then
      echo "local-postgres.sh: Postgres did not start. Last lines of $LOG_FILE:" >&2
      tail -n 20 "$LOG_FILE" >&2 || true
      exit 1
    fi
  fi

  local admin_url="postgresql://$DB_USER:$DB_PASSWORD@127.0.0.1:$PORT/postgres?sslmode=disable"
  local exists
  exists="$(psql_node "$admin_url" "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'")"
  if [ -z "$exists" ]; then
    echo "Creating database $DB_NAME ..."
    psql_node "$admin_url" "CREATE DATABASE $DB_NAME" >/dev/null
  fi

  # One role here, not the two of ADR 0005. The split exists so that the
  # deployed app cannot drop a table; a database you can delete with `reset`
  # has nothing to protect, and pretending otherwise would mean QA testing a
  # grant matrix that is not the one production runs. `npm run verify:roles`
  # is the check that covers the real thing, and it needs the real database.
  echo "Applying migrations, registry and partitions ..."
  (
    cd "$REPO_ROOT"
    export MIGRATE_DATABASE_URL="$LOCAL_URL"
    export RUNTIME_DATABASE_URL="$LOCAL_URL"
    export DATABASE_URL="$LOCAL_URL"
    export DIRECT_URL="$LOCAL_URL"
    export APP_ENV=local
    npx prisma migrate deploy
    npm run --silent db:seed:registry
    npm run --silent db:partitions
  )

  cat <<EOF

Local Postgres is up. Put these in .env.local:

  APP_ENV=local
  DATABASE_URL=$LOCAL_URL
  DIRECT_URL=$LOCAL_URL

Then \`npm run dev\`. Logs: $LOG_FILE
This database is disposable — \`npm run db:local:reset\` deletes it.
EOF
}

stop() {
  ensure_binaries
  if is_running; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -w -m fast stop >/dev/null
    echo "Stopped."
  else
    echo "Not running."
  fi
}

status() {
  ensure_binaries
  if is_running; then
    echo "Running on 127.0.0.1:$PORT ($DATA_DIR)"
  else
    echo "Not running."
    exit 1
  fi
}

reset() {
  ensure_binaries
  if is_running; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -w -m immediate stop >/dev/null || true
  fi
  rm -rf "$DATA_DIR" "$LOG_FILE"
  echo "Deleted $DATA_DIR. Run \`npm run db:local\` for a clean one."
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  reset) reset ;;
  url) echo "$LOCAL_URL" ;;
  *) echo "usage: local-postgres.sh [start|stop|status|reset|url]" >&2; exit 1 ;;
esac
