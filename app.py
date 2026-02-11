import json
import os
import socket
import ssl
import threading
import time
from datetime import datetime, timedelta, timezone
from urllib import error, request
from urllib.parse import quote_plus, urlparse

import psycopg
from flask import Flask, jsonify, request as flask_request, send_from_directory
from psycopg.rows import dict_row


MONITOR_POLL_SECONDS = int(os.getenv("MONITOR_POLL_SECONDS", "5"))
DEFAULT_INTERVAL_SECONDS = int(os.getenv("DEFAULT_INTERVAL_SECONDS", "60"))
DEFAULT_TIMEOUT_SECONDS = int(os.getenv("DEFAULT_TIMEOUT_SECONDS", "8"))
MAX_HISTORY_LIMIT = 500
MAX_BODY_BYTES = 1_000_000

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
                    expected_substring TEXT,
                    expected_json_keys TEXT,
                    max_latency_ms INTEGER,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );

                ALTER TABLE targets ADD COLUMN IF NOT EXISTS expected_substring TEXT;
                ALTER TABLE targets ADD COLUMN IF NOT EXISTS expected_json_keys TEXT;
                ALTER TABLE targets ADD COLUMN IF NOT EXISTS max_latency_ms INTEGER;

                CREATE TABLE IF NOT EXISTS checks (
                    id BIGSERIAL PRIMARY KEY,
                    target_id BIGINT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
                    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    status_code INTEGER,
                    latency_ms INTEGER,
                    is_up BOOLEAN NOT NULL,
                    reason_code TEXT,
                    error_message TEXT
                );

                ALTER TABLE checks ADD COLUMN IF NOT EXISTS reason_code TEXT;

                CREATE TABLE IF NOT EXISTS incidents (
                    id BIGSERIAL PRIMARY KEY,
                    target_id BIGINT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
                    started_at TIMESTAMPTZ NOT NULL,
                    ended_at TIMESTAMPTZ,
                    duration_seconds INTEGER,
                    is_resolved BOOLEAN NOT NULL DEFAULT FALSE,
                    reason_code TEXT,
                    reason_message TEXT,
                    start_check_id BIGINT REFERENCES checks(id) ON DELETE SET NULL,
                    recovery_check_id BIGINT REFERENCES checks(id) ON DELETE SET NULL
                );

                CREATE INDEX IF NOT EXISTS idx_checks_target_time ON checks(target_id, checked_at DESC);
                CREATE INDEX IF NOT EXISTS idx_checks_checked_at ON checks(checked_at DESC);
                CREATE INDEX IF NOT EXISTS idx_incidents_target_time ON incidents(target_id, started_at DESC);
                CREATE INDEX IF NOT EXISTS idx_incidents_open ON incidents(target_id, is_resolved);
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


def normalize_json_keys_input(raw_value) -> str | None:
    if raw_value is None:
        return None
    if isinstance(raw_value, list):
        cleaned = [str(v).strip() for v in raw_value if str(v).strip()]
        return ",".join(cleaned) if cleaned else None
    text = str(raw_value).strip()
    if not text:
        return None
    keys = [part.strip() for part in text.split(",") if part.strip()]
    return ",".join(keys) if keys else None


def parse_expected_json_keys(raw_value) -> list[str]:
    if not raw_value:
        return []
    return [part.strip() for part in str(raw_value).split(",") if part.strip()]


def normalize_target_payload(payload: dict):
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
    expected_substring = (payload.get("expected_substring") or "").strip() or None
    expected_json_keys = normalize_json_keys_input(payload.get("expected_json_keys"))
    max_latency_raw = payload.get("max_latency_ms")
    max_latency_ms = int(max_latency_raw) if str(max_latency_raw or "").strip() else None

    if interval_seconds < 1:
        raise ValueError("interval_seconds deve ser >= 1 segundo.")
    if timeout_seconds < 1 or timeout_seconds > 60:
        raise ValueError("timeout_seconds deve estar entre 1 e 60 segundos.")
    if max_latency_ms is not None and max_latency_ms < 1:
        raise ValueError("max_latency_ms deve ser >= 1.")

    return {
        "name": name,
        "url": url,
        "interval_seconds": interval_seconds,
        "timeout_seconds": timeout_seconds,
        "expected_substring": expected_substring,
        "expected_json_keys": expected_json_keys,
        "max_latency_ms": max_latency_ms,
    }


def classify_exception(exc: Exception) -> tuple[str, str]:
    text = str(exc)
    lowered = text.lower()
    if isinstance(exc, socket.timeout) or isinstance(exc, TimeoutError):
        return "timeout", "Timeout de conexao."
    if isinstance(exc, error.URLError):
        reason = exc.reason
        reason_text = str(reason).lower()
        if isinstance(reason, socket.gaierror) or "name or service not known" in reason_text:
            return "dns_error", "Erro de DNS."
        if isinstance(reason, ssl.SSLError) or "ssl" in reason_text or "certificate" in reason_text:
            return "ssl_error", "Erro SSL/TLS."
        if "timed out" in reason_text:
            return "timeout", "Timeout de conexao."
        return "connection_error", f"Falha de conexao: {text}"
    if isinstance(exc, ssl.SSLError):
        return "ssl_error", "Erro SSL/TLS."
    if "timed out" in lowered:
        return "timeout", "Timeout de conexao."
    return "unknown_error", text or "Erro desconhecido."


def json_path_exists(data, path: str) -> bool:
    current = data
    for part in path.split("."):
        if isinstance(current, dict):
            if part not in current:
                return False
            current = current[part]
        elif isinstance(current, list):
            if not part.isdigit():
                return False
            idx = int(part)
            if idx < 0 or idx >= len(current):
                return False
            current = current[idx]
        else:
            return False
    return True


def validate_content_rules(target: dict, body_bytes: bytes, latency_ms: int):
    max_latency_ms = target.get("max_latency_ms")
    if max_latency_ms is not None and latency_ms is not None and latency_ms > max_latency_ms:
        return False, "latency_exceeded", f"Latencia acima do maximo ({latency_ms}ms > {max_latency_ms}ms)."

    expected_substring = target.get("expected_substring")
    if expected_substring:
        body_text = body_bytes.decode("utf-8", errors="ignore")
        if expected_substring not in body_text:
            return False, "content_mismatch", f"Conteudo esperado nao encontrado: '{expected_substring}'."

    expected_keys = parse_expected_json_keys(target.get("expected_json_keys"))
    if expected_keys:
        try:
            data = json.loads(body_bytes.decode("utf-8", errors="ignore"))
        except Exception:
            return False, "invalid_json", "Resposta nao e JSON valido."

        for key_path in expected_keys:
            if not json_path_exists(data, key_path):
                return False, "json_schema_mismatch", f"Chave JSON ausente: {key_path}"

    return True, None, None


def get_last_check(conn, target_id: int):
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, is_up, checked_at
            FROM checks
            WHERE target_id = %s
            ORDER BY checked_at DESC
            LIMIT 1
            """,
            (target_id,),
        )
        return cur.fetchone()


def get_open_incident(conn, target_id: int):
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT *
            FROM incidents
            WHERE target_id = %s AND is_resolved = FALSE
            ORDER BY started_at DESC
            LIMIT 1
            """,
            (target_id,),
        )
        return cur.fetchone()


def update_incident_state(conn, target: dict, prev_check, current_check: dict) -> None:
    target_id = target["id"]
    prev_is_up = None if not prev_check else bool(prev_check["is_up"])
    current_is_up = bool(current_check["is_up"])
    open_incident = get_open_incident(conn, target_id)

    if current_is_up:
        if prev_is_up is False and open_incident:
            started_at = open_incident["started_at"]
            duration_seconds = max(0, int((current_check["checked_at"] - started_at).total_seconds()))
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE incidents
                    SET ended_at = %s,
                        duration_seconds = %s,
                        is_resolved = TRUE,
                        recovery_check_id = %s
                    WHERE id = %s
                    """,
                    (current_check["checked_at"], duration_seconds, current_check["id"], open_incident["id"]),
                )
        return

    if prev_is_up is not False and not open_incident:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO incidents (
                    target_id, started_at, reason_code, reason_message, start_check_id, is_resolved
                ) VALUES (%s, %s, %s, %s, %s, FALSE)
                """,
                (
                    target_id,
                    current_check["checked_at"],
                    current_check["reason_code"],
                    current_check["error_message"],
                    current_check["id"],
                ),
            )
    elif prev_is_up is False and not open_incident:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO incidents (
                    target_id, started_at, reason_code, reason_message, start_check_id, is_resolved
                ) VALUES (%s, %s, %s, %s, %s, FALSE)
                """,
                (
                    target_id,
                    current_check["checked_at"],
                    current_check["reason_code"],
                    current_check["error_message"],
                    current_check["id"],
                ),
            )


def run_single_check(conn, target: dict) -> dict:
    prev_check = get_last_check(conn, target["id"])
    started = time.perf_counter()
    checked_at = utc_now()
    status_code = None
    latency_ms = None
    is_up = False
    reason_code = None
    error_message = None
    body_bytes = b""

    req = request.Request(
        target["url"],
        method="GET",
        headers={"User-Agent": "GenTrack/1.0", "Accept": "*/*"},
    )

    try:
        with request.urlopen(req, timeout=target["timeout_seconds"]) as resp:
            status_code = int(resp.getcode())
            body_bytes = resp.read(MAX_BODY_BYTES)
            latency_ms = int((time.perf_counter() - started) * 1000)
            is_up = 200 <= status_code < 400
            reason_code = None if is_up else ("http_5xx" if status_code >= 500 else "http_4xx")
            error_message = None if is_up else f"HTTP {status_code}"

            if is_up:
                valid, rule_reason, rule_error = validate_content_rules(target, body_bytes, latency_ms)
                if not valid:
                    is_up = False
                    reason_code = rule_reason
                    error_message = rule_error

    except error.HTTPError as exc:
        status_code = int(exc.code)
        latency_ms = int((time.perf_counter() - started) * 1000)
        is_up = False
        reason_code = "http_5xx" if status_code >= 500 else "http_4xx"
        error_message = f"HTTP {status_code}"
    except Exception as exc:
        latency_ms = int((time.perf_counter() - started) * 1000)
        is_up = False
        reason_code, error_message = classify_exception(exc)

    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO checks (target_id, checked_at, status_code, latency_ms, is_up, reason_code, error_message)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (target["id"], checked_at, status_code, latency_ms, is_up, reason_code, error_message),
        )
        check_id = cur.fetchone()["id"]

    current_check = {
        "id": check_id,
        "checked_at": checked_at,
        "is_up": is_up,
        "reason_code": reason_code,
        "error_message": error_message,
    }
    update_incident_state(conn, target, prev_check, current_check)
    conn.commit()

    return {
        "id": check_id,
        "target_id": target["id"],
        "checked_at": checked_at.isoformat(),
        "status_code": status_code,
        "latency_ms": latency_ms,
        "is_up": bool(is_up),
        "reason_code": reason_code,
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
        "expected_substring": row.get("expected_substring"),
        "expected_json_keys": parse_expected_json_keys(row.get("expected_json_keys")),
        "max_latency_ms": row.get("max_latency_ms"),
        "created_at": to_iso(row["created_at"]),
        "last_checked_at": to_iso(row["last_checked_at"]),
        "last_status_code": row["last_status_code"],
        "last_latency_ms": int(row["last_latency_ms"]) if row["last_latency_ms"] is not None else None,
        "last_is_up": bool(row["last_is_up"]) if row["last_is_up"] is not None else None,
        "last_reason_code": row.get("last_reason_code"),
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
                       SELECT c.reason_code
                       FROM checks c
                       WHERE c.target_id = t.id
                       ORDER BY c.checked_at DESC
                       LIMIT 1
                   ) AS last_reason_code,
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


def build_reliability_summary(conn, target_id: int | None = None) -> dict:
    where = "WHERE i.target_id = %s" if target_id is not None else ""
    params = (target_id,) if target_id is not None else ()

    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT i.id, i.target_id, i.started_at, i.ended_at, i.duration_seconds, i.is_resolved,
                   i.reason_code, i.reason_message, t.name AS target_name
            FROM incidents i
            JOIN targets t ON t.id = i.target_id
            {where}
            ORDER BY i.started_at DESC
            LIMIT 1
            """,
            params,
        )
        last_incident = cur.fetchone()

        cur.execute(
            f"""
            SELECT
                COUNT(*) FILTER (WHERE started_at >= NOW() - INTERVAL '1 day') AS day_count,
                COUNT(*) FILTER (WHERE started_at >= NOW() - INTERVAL '7 day') AS week_count,
                COUNT(*) FILTER (WHERE started_at >= date_trunc('month', NOW())) AS month_count,
                AVG(duration_seconds) FILTER (WHERE is_resolved = TRUE AND duration_seconds IS NOT NULL) AS mttr_seconds
            FROM incidents
            {"WHERE target_id = %s" if target_id is not None else ""}
            """,
            params,
        )
        agg = cur.fetchone() or {}

        if target_id is not None:
            cur.execute(
                """
                WITH resolved AS (
                    SELECT started_at, ended_at,
                           LAG(ended_at) OVER (ORDER BY started_at) AS prev_ended
                    FROM incidents
                    WHERE target_id = %s AND ended_at IS NOT NULL
                )
                SELECT AVG(EXTRACT(EPOCH FROM (started_at - prev_ended))) AS mtbf_seconds
                FROM resolved
                WHERE prev_ended IS NOT NULL AND started_at > prev_ended
                """,
                (target_id,),
            )
        else:
            cur.execute(
                """
                WITH resolved AS (
                    SELECT target_id, started_at, ended_at,
                           LAG(ended_at) OVER (PARTITION BY target_id ORDER BY started_at) AS prev_ended
                    FROM incidents
                    WHERE ended_at IS NOT NULL
                )
                SELECT AVG(EXTRACT(EPOCH FROM (started_at - prev_ended))) AS mtbf_seconds
                FROM resolved
                WHERE prev_ended IS NOT NULL AND started_at > prev_ended
                """
            )
        mtbf_row = cur.fetchone() or {}

    return {
        "last_incident": (
            {
                "id": last_incident["id"],
                "target_id": last_incident["target_id"],
                "target_name": last_incident["target_name"],
                "started_at": to_iso(last_incident["started_at"]),
                "ended_at": to_iso(last_incident["ended_at"]),
                "duration_seconds": last_incident["duration_seconds"],
                "is_resolved": bool(last_incident["is_resolved"]),
                "reason_code": last_incident["reason_code"],
                "reason_message": last_incident["reason_message"],
            }
            if last_incident
            else None
        ),
        "mttr_seconds": float(agg["mttr_seconds"]) if agg.get("mttr_seconds") is not None else None,
        "mtbf_seconds": float(mtbf_row["mtbf_seconds"]) if mtbf_row.get("mtbf_seconds") is not None else None,
        "incidents_day": int(agg.get("day_count") or 0),
        "incidents_week": int(agg.get("week_count") or 0),
        "incidents_month": int(agg.get("month_count") or 0),
    }


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
        data = normalize_target_payload(payload)
    except (ValueError, TypeError) as exc:
        return jsonify({"error": str(exc)}), 400

    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO targets (
                    name, url, interval_seconds, timeout_seconds,
                    expected_substring, expected_json_keys, max_latency_ms, created_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING id
                """,
                (
                    data["name"],
                    data["url"],
                    data["interval_seconds"],
                    data["timeout_seconds"],
                    data["expected_substring"],
                    data["expected_json_keys"],
                    data["max_latency_ms"],
                    utc_now(),
                ),
            )
            target_id = cur.fetchone()["id"]
        conn.commit()

        with conn.cursor() as cur:
            cur.execute("SELECT * FROM targets WHERE id = %s", (target_id,))
            row = cur.fetchone()
        run_single_check(conn, row)

        for item in fetch_targets_with_summary(conn):
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
            if not cur.fetchone():
                return jsonify({"error": "Alvo nao encontrado."}), 404

            cur.execute(
                """
                SELECT id, target_id, checked_at, status_code, latency_ms, is_up, reason_code, error_message
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
                "reason_code": row["reason_code"],
                "error_message": row["error_message"],
            }
            for row in rows
        ]
        return jsonify(history)
    finally:
        conn.close()


@app.route("/api/targets/<int:target_id>/incidents", methods=["GET"])
def target_incidents(target_id: int):
    limit_raw = flask_request.args.get("limit", "50")
    try:
        limit = max(1, min(300, int(limit_raw)))
    except ValueError:
        return jsonify({"error": "Parametro 'limit' invalido."}), 400

    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM targets WHERE id = %s", (target_id,))
            if not cur.fetchone():
                return jsonify({"error": "Alvo nao encontrado."}), 404
            cur.execute(
                """
                SELECT id, target_id, started_at, ended_at, duration_seconds, is_resolved,
                       reason_code, reason_message
                FROM incidents
                WHERE target_id = %s
                ORDER BY started_at DESC
                LIMIT %s
                """,
                (target_id, limit),
            )
            rows = cur.fetchall()

        return jsonify(
            [
                {
                    "id": row["id"],
                    "target_id": row["target_id"],
                    "started_at": to_iso(row["started_at"]),
                    "ended_at": to_iso(row["ended_at"]),
                    "duration_seconds": row["duration_seconds"],
                    "is_resolved": bool(row["is_resolved"]),
                    "reason_code": row["reason_code"],
                    "reason_message": row["reason_message"],
                }
                for row in rows
            ]
        )
    finally:
        conn.close()


@app.route("/api/targets/<int:target_id>/reliability", methods=["GET"])
def target_reliability(target_id: int):
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM targets WHERE id = %s", (target_id,))
            if not cur.fetchone():
                return jsonify({"error": "Alvo nao encontrado."}), 404
        return jsonify(build_reliability_summary(conn, target_id))
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
                "incident_summary": build_reliability_summary(conn),
                "targets": targets,
            }
        )
    finally:
        conn.close()


def create_app() -> Flask:
    if not resolve_database_url():
        raise RuntimeError("Defina DATABASE_URL (ou POSTGRES_URL/DB_URL) para iniciar o GenTrack.")
    init_db()
    start_monitor_thread()
    return app


if __name__ == "__main__":
    create_app()
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False)
