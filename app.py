import os
import threading
import time
from datetime import datetime, timedelta, timezone
from urllib import error, request
from urllib.parse import urlparse
from urllib.parse import quote_plus

from flask import Flask, jsonify, request as flask_request, send_from_directory
import psycopg
from psycopg.rows import dict_row


MONITOR_POLL_SECONDS = int(os.getenv("MONITOR_POLL_SECONDS", "5"))
DEFAULT_INTERVAL_SECONDS = int(os.getenv("DEFAULT_INTERVAL_SECONDS", "60"))
DEFAULT_TIMEOUT_SECONDS = int(os.getenv("DEFAULT_TIMEOUT_SECONDS", "8"))
MAX_HISTORY_LIMIT = 500

app = Flask(__name__, static_folder="static")
monitor_started = False


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def to_iso(value):
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def resolve_database_url() -> str:
    candidates = [
        os.getenv("DATABASE_URL", "").strip(),
        os.getenv("DATABASE_URI", "").strip(),
        os.getenv("POSTGRES_URL", "").strip(),
        os.getenv("POSTGRESQL_URL", "").strip(),
        os.getenv("POSTGRES_CONNECTION_STRING", "").strip(),
        os.getenv("DB_URL", "").strip(),
    ]
    for value in candidates:
        if value:
            return value

    host = os.getenv("DB_HOST") or os.getenv("POSTGRES_HOST")
    port = os.getenv("DB_PORT") or os.getenv("POSTGRES_PORT") or "5432"
    user = os.getenv("DB_USER") or os.getenv("POSTGRES_USER")
    password = os.getenv("DB_PASSWORD") or os.getenv("POSTGRES_PASSWORD")
    name = os.getenv("DB_NAME") or os.getenv("POSTGRES_DB") or os.getenv("DB_DATABASE")
    sslmode = os.getenv("DB_SSLMODE") or os.getenv("PGSSLMODE") or "disable"

    if host and user and password and name:
        user_enc = quote_plus(user)
        pass_enc = quote_plus(password)
        name_enc = quote_plus(name)
        return f"postgres://{user_enc}:{pass_enc}@{host}:{port}/{name_enc}?sslmode={sslmode}"

    return ""


def get_db_connection():
    database_url = resolve_database_url()
    if not database_url:
        raise RuntimeError(
            "Banco nao configurado. Defina DATABASE_URL (ou POSTGRES_URL/DB_URL) "
            "ou as variaveis DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME."
        )
    return psycopg.connect(database_url, row_factory=dict_row)


def init_db() -> None:
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS targets (
                    id BIGSERIAL PRIMARY KEY,
                    name TEXT NOT NULL,
                    url TEXT NOT NULL UNIQUE,
                    interval_seconds INTEGER NOT NULL DEFAULT 60,
                    timeout_seconds INTEGER NOT NULL DEFAULT 8,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );

                CREATE TABLE IF NOT EXISTS checks (
                    id BIGSERIAL PRIMARY KEY,
                    target_id BIGINT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
                    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    status_code INTEGER,
                    latency_ms INTEGER,
                    is_up BOOLEAN NOT NULL,
                    error_message TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_checks_target_time ON checks(target_id, checked_at DESC);
                CREATE INDEX IF NOT EXISTS idx_checks_checked_at ON checks(checked_at DESC);
                """
            )
        conn.commit()
    finally:
        conn.close()


def is_valid_http_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
        return parsed.scheme in {"http", "https"} and bool(parsed.netloc)
    except Exception:
        return False


def normalize_target_payload(payload: dict) -> tuple[str, str, int, int]:
    name = (payload.get("name") or "").strip()
    url = (payload.get("url") or "").strip()

    if not name:
        raise ValueError("Nome e obrigatorio.")
    if not url:
        raise ValueError("URL e obrigatoria.")
    if not is_valid_http_url(url):
        raise ValueError("URL invalida. Use http:// ou https://")

    interval_seconds = int(payload.get("interval_seconds", DEFAULT_INTERVAL_SECONDS))
    timeout_seconds = int(payload.get("timeout_seconds", DEFAULT_TIMEOUT_SECONDS))

    if interval_seconds < 15:
        raise ValueError("interval_seconds deve ser >= 15 segundos.")
    if timeout_seconds < 1 or timeout_seconds > 60:
        raise ValueError("timeout_seconds deve estar entre 1 e 60 segundos.")

    return name, url, interval_seconds, timeout_seconds


def run_single_check(conn, target: dict) -> dict:
    started = time.perf_counter()
    checked_at = utc_now()
    status_code = None
    latency_ms = None
    is_up = False
    error_message = None

    req = request.Request(
        target["url"],
        method="GET",
        headers={"User-Agent": "GenTrack/1.0", "Accept": "*/*"},
    )

    try:
        with request.urlopen(req, timeout=target["timeout_seconds"]) as resp:
            status_code = int(resp.getcode())
            latency_ms = int((time.perf_counter() - started) * 1000)
            is_up = 200 <= status_code < 400
    except error.HTTPError as exc:
        status_code = int(exc.code)
        latency_ms = int((time.perf_counter() - started) * 1000)
        is_up = False
        error_message = f"HTTPError {exc.code}"
    except Exception as exc:
        latency_ms = int((time.perf_counter() - started) * 1000)
        is_up = False
        error_message = str(exc)

    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO checks (target_id, checked_at, status_code, latency_ms, is_up, error_message)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (target["id"], checked_at, status_code, latency_ms, is_up, error_message),
        )
    conn.commit()

    return {
        "target_id": target["id"],
        "checked_at": checked_at.isoformat(),
        "status_code": status_code,
        "latency_ms": latency_ms,
        "is_up": bool(is_up),
        "error_message": error_message,
    }


def get_due_targets(conn) -> list[dict]:
    now = utc_now()
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT t.*,
                   (
                       SELECT c.checked_at
                       FROM checks c
                       WHERE c.target_id = t.id
                       ORDER BY c.checked_at DESC
                       LIMIT 1
                   ) AS last_checked_at
            FROM targets t
            ORDER BY t.id ASC
            """
        )
        rows = cur.fetchall()

    due = []
    for row in rows:
        last_checked_at = row["last_checked_at"]
        if not last_checked_at:
            due.append(row)
            continue

        if now - last_checked_at >= timedelta(seconds=row["interval_seconds"]):
            due.append(row)
    return due


def monitor_loop() -> None:
    while True:
        conn = None
        try:
            conn = get_db_connection()
            for target in get_due_targets(conn):
                run_single_check(conn, target)
        except Exception as exc:
            if conn:
                conn.rollback()
            print(f"[monitor] erro: {exc}")
        finally:
            if conn:
                conn.close()

        time.sleep(MONITOR_POLL_SECONDS)


def start_monitor_thread() -> None:
    global monitor_started
    if monitor_started:
        return

    monitor_started = True
    worker = threading.Thread(target=monitor_loop, daemon=True, name="gentrack-monitor")
    worker.start()


def target_row_to_dict(row: dict) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "url": row["url"],
        "interval_seconds": row["interval_seconds"],
        "timeout_seconds": row["timeout_seconds"],
        "created_at": to_iso(row["created_at"]),
        "last_checked_at": to_iso(row["last_checked_at"]),
        "last_status_code": row["last_status_code"],
        "last_latency_ms": int(row["last_latency_ms"]) if row["last_latency_ms"] is not None else None,
        "last_is_up": bool(row["last_is_up"]) if row["last_is_up"] is not None else None,
        "last_error_message": row["last_error_message"],
        "uptime_24h": float(row["uptime_24h"]) if row["uptime_24h"] is not None else None,
    }


def fetch_targets_with_summary(conn) -> list[dict]:
    one_day_ago = utc_now() - timedelta(hours=24)
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT t.*,
                   (
                       SELECT c.checked_at
                       FROM checks c
                       WHERE c.target_id = t.id
                       ORDER BY c.checked_at DESC
                       LIMIT 1
                   ) AS last_checked_at,
                   (
                       SELECT c.status_code
                       FROM checks c
                       WHERE c.target_id = t.id
                       ORDER BY c.checked_at DESC
                       LIMIT 1
                   ) AS last_status_code,
                   (
                       SELECT c.latency_ms
                       FROM checks c
                       WHERE c.target_id = t.id
                       ORDER BY c.checked_at DESC
                       LIMIT 1
                   ) AS last_latency_ms,
                   (
                       SELECT c.is_up
                       FROM checks c
                       WHERE c.target_id = t.id
                       ORDER BY c.checked_at DESC
                       LIMIT 1
                   ) AS last_is_up,
                   (
                       SELECT c.error_message
                       FROM checks c
                       WHERE c.target_id = t.id
                       ORDER BY c.checked_at DESC
                       LIMIT 1
                   ) AS last_error_message,
                   (
                       SELECT ROUND(100.0 * AVG(CASE WHEN c.is_up THEN 1.0 ELSE 0.0 END), 2)
                       FROM checks c
                       WHERE c.target_id = t.id
                         AND c.checked_at >= %s
                   ) AS uptime_24h
            FROM targets t
            ORDER BY t.id ASC
            """,
            (one_day_ago,),
        )
        rows = cur.fetchall()
    return [target_row_to_dict(row) for row in rows]


@app.route("/")
def root():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/health", methods=["GET"])
def health():
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
            cur.fetchone()
        return jsonify({"ok": True}), 200
    finally:
        conn.close()


@app.route("/api/targets", methods=["GET"])
def list_targets():
    conn = get_db_connection()
    try:
        return jsonify(fetch_targets_with_summary(conn))
    finally:
        conn.close()


@app.route("/api/targets", methods=["POST"])
def create_target():
    payload = flask_request.get_json(silent=True) or {}
    try:
        name, url, interval_seconds, timeout_seconds = normalize_target_payload(payload)
    except (ValueError, TypeError) as exc:
        return jsonify({"error": str(exc)}), 400

    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO targets (name, url, interval_seconds, timeout_seconds, created_at)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING id
                """,
                (name, url, interval_seconds, timeout_seconds, utc_now()),
            )
            target_id = cur.fetchone()["id"]
        conn.commit()

        with conn.cursor() as cur:
            cur.execute("SELECT * FROM targets WHERE id = %s", (target_id,))
            row = cur.fetchone()
        run_single_check(conn, row)

        result = fetch_targets_with_summary(conn)
        for item in result:
            if item["id"] == target_id:
                return jsonify(item), 201

        return jsonify({"error": "Falha ao criar alvo."}), 500
    except psycopg.IntegrityError:
        conn.rollback()
        return jsonify({"error": "Essa URL ja esta cadastrada."}), 409
    finally:
        conn.close()


@app.route("/api/targets/<int:target_id>", methods=["DELETE"])
def delete_target(target_id: int):
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM targets WHERE id = %s", (target_id,))
            affected = cur.rowcount
        conn.commit()
        if affected == 0:
            return jsonify({"error": "Alvo nao encontrado."}), 404
        return jsonify({"ok": True})
    finally:
        conn.close()


@app.route("/api/targets/<int:target_id>/check", methods=["POST"])
def manual_check(target_id: int):
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM targets WHERE id = %s", (target_id,))
            target = cur.fetchone()
        if not target:
            return jsonify({"error": "Alvo nao encontrado."}), 404

        result = run_single_check(conn, target)
        return jsonify(result)
    finally:
        conn.close()


@app.route("/api/targets/<int:target_id>/history", methods=["GET"])
def target_history(target_id: int):
    limit_raw = flask_request.args.get("limit", "100")
    try:
        limit = max(1, min(MAX_HISTORY_LIMIT, int(limit_raw)))
    except ValueError:
        return jsonify({"error": "Parametro 'limit' invalido."}), 400

    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM targets WHERE id = %s", (target_id,))
            exists = cur.fetchone()
            if not exists:
                return jsonify({"error": "Alvo nao encontrado."}), 404

            cur.execute(
                """
                SELECT id, target_id, checked_at, status_code, latency_ms, is_up, error_message
                FROM checks
                WHERE target_id = %s
                ORDER BY checked_at DESC
                LIMIT %s
                """,
                (target_id, limit),
            )
            rows = cur.fetchall()

        history = [
            {
                "id": row["id"],
                "target_id": row["target_id"],
                "checked_at": to_iso(row["checked_at"]),
                "status_code": row["status_code"],
                "latency_ms": row["latency_ms"],
                "is_up": bool(row["is_up"]),
                "error_message": row["error_message"],
            }
            for row in rows
        ]
        return jsonify(history)
    finally:
        conn.close()


@app.route("/api/dashboard", methods=["GET"])
def dashboard():
    conn = get_db_connection()
    try:
        targets = fetch_targets_with_summary(conn)
        total = len(targets)
        up_now = sum(1 for t in targets if t["last_is_up"] is True)
        down_now = sum(1 for t in targets if t["last_is_up"] is False)
        unknown = total - up_now - down_now

        uptime_values = [t["uptime_24h"] for t in targets if t["uptime_24h"] is not None]
        avg_uptime = round(sum(uptime_values) / len(uptime_values), 2) if uptime_values else None

        return jsonify(
            {
                "total_targets": total,
                "up_now": up_now,
                "down_now": down_now,
                "unknown_now": unknown,
                "avg_uptime_24h": avg_uptime,
                "targets": targets,
            }
        )
    finally:
        conn.close()


def create_app() -> Flask:
    if not resolve_database_url():
        raise RuntimeError(
            "Defina DATABASE_URL (ou POSTGRES_URL/DB_URL) para iniciar o GenTrack."
        )
    init_db()
    start_monitor_thread()
    return app


if __name__ == "__main__":
    create_app()
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False)
