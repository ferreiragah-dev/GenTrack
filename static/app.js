const els = {
  form: document.getElementById("target-form"),
  name: document.getElementById("name"),
  url: document.getElementById("url"),
  interval: document.getElementById("interval_seconds"),
  timeout: document.getElementById("timeout_seconds"),
  message: document.getElementById("form-message"),
  kpiTotal: document.getElementById("kpi-total"),
  kpiUp: document.getElementById("kpi-up"),
  kpiDown: document.getElementById("kpi-down"),
  kpiUptime: document.getElementById("kpi-uptime"),
  targetsBody: document.getElementById("targets-body"),
  historyTitle: document.getElementById("history-title"),
  historyBody: document.getElementById("history-body"),
};

const fmtDate = (iso) => {
  if (!iso) return "--";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString("pt-BR");
};

const fmtUptime = (value) => (value == null ? "--" : `${value.toFixed(2)}%`);
const fmtLatency = (value) => (value == null ? "--" : `${value} ms`);

const statusLabel = (isUp) => {
  if (isUp === true) return { text: "UP", css: "up" };
  if (isUp === false) return { text: "DOWN", css: "down" };
  return { text: "SEM DADOS", css: "" };
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Erro ${response.status}`);
  }
  return payload;
}

async function refreshDashboard() {
  const data = await api("/api/dashboard");
  els.kpiTotal.textContent = data.total_targets;
  els.kpiUp.textContent = data.up_now;
  els.kpiDown.textContent = data.down_now;
  els.kpiUptime.textContent = data.avg_uptime_24h == null ? "--" : `${data.avg_uptime_24h.toFixed(2)}%`;

  renderTargets(data.targets || []);
}

function renderTargets(targets) {
  if (!targets.length) {
    els.targetsBody.innerHTML = `<tr><td colspan="8">Nenhum alvo cadastrado.</td></tr>`;
    return;
  }

  els.targetsBody.innerHTML = targets
    .map((target) => {
      const status = statusLabel(target.last_is_up);
      return `
        <tr>
          <td>${target.name}</td>
          <td><a href="${target.url}" target="_blank" rel="noreferrer">${target.url}</a></td>
          <td><span class="status ${status.css}">${status.text}</span></td>
          <td>${target.last_status_code ?? "--"}</td>
          <td>${fmtLatency(target.last_latency_ms)}</td>
          <td>${fmtUptime(target.uptime_24h)}</td>
          <td>${fmtDate(target.last_checked_at)}</td>
          <td>
            <div class="actions">
              <button data-action="check" data-id="${target.id}">Check</button>
              <button data-action="history" data-id="${target.id}" data-name="${target.name}">Historico</button>
              <button data-action="delete" data-id="${target.id}">Excluir</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

async function createTarget(event) {
  event.preventDefault();
  els.message.textContent = "";

  try {
    await api("/api/targets", {
      method: "POST",
      body: JSON.stringify({
        name: els.name.value,
        url: els.url.value,
        interval_seconds: Number(els.interval.value),
        timeout_seconds: Number(els.timeout.value),
      }),
    });

    els.form.reset();
    els.interval.value = "60";
    els.timeout.value = "8";
    els.message.textContent = "Alvo cadastrado com sucesso.";
    await refreshDashboard();
  } catch (err) {
    els.message.textContent = err.message;
  }
}

async function deleteTarget(targetId) {
  await api(`/api/targets/${targetId}`, { method: "DELETE" });
  await refreshDashboard();
}

async function checkTarget(targetId) {
  await api(`/api/targets/${targetId}/check`, { method: "POST" });
  await refreshDashboard();
}

async function loadHistory(targetId, targetName) {
  const history = await api(`/api/targets/${targetId}/history?limit=50`);
  els.historyTitle.textContent = `Historico de ${targetName}`;

  if (!history.length) {
    els.historyBody.innerHTML = `<tr><td colspan="5">Sem historico para esse alvo.</td></tr>`;
    return;
  }

  els.historyBody.innerHTML = history
    .map((item) => {
      const status = statusLabel(item.is_up);
      return `
        <tr>
          <td>${fmtDate(item.checked_at)}</td>
          <td><span class="status ${status.css}">${status.text}</span></td>
          <td>${item.status_code ?? "--"}</td>
          <td>${fmtLatency(item.latency_ms)}</td>
          <td>${item.error_message || "--"}</td>
        </tr>
      `;
    })
    .join("");
}

async function handleTableClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const action = button.dataset.action;
  const targetId = button.dataset.id;
  const targetName = button.dataset.name;

  try {
    if (action === "delete") {
      await deleteTarget(targetId);
    } else if (action === "check") {
      await checkTarget(targetId);
    } else if (action === "history") {
      await loadHistory(targetId, targetName || "alvo");
    }
  } catch (err) {
    window.alert(err.message);
  }
}

els.form.addEventListener("submit", createTarget);
els.targetsBody.addEventListener("click", handleTableClick);

refreshDashboard().catch((err) => {
  els.message.textContent = err.message;
});
setInterval(() => refreshDashboard().catch(() => {}), 15000);
