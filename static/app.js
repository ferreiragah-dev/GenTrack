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
  uptimeChart: document.getElementById("uptime-chart"),
  latencyChart: document.getElementById("latency-chart"),
  trendChart: document.getElementById("trend-chart"),
  trendTitle: document.getElementById("trend-title"),
  refreshStatus: document.getElementById("refresh-status"),
  refreshNow: document.getElementById("refresh-now"),
};

const state = {
  targets: [],
  history: [],
  selectedTargetId: null,
  selectedTargetName: "",
  refreshCountdown: 15,
};

const AUTO_REFRESH_SECONDS = 15;

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

function setupCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width));
  const height = Math.max(180, Math.floor(rect.height));
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width, height };
}

function drawEmptyChart(canvas, text) {
  const { ctx, width, height } = setupCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(143, 160, 184, 0.85)";
  ctx.font = "600 14px Rajdhani, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(text, width / 2, height / 2);
}

function drawBarChart(canvas, labels, values, { suffix = "", maxValue = null, color = "#ff9f0a" } = {}) {
  if (!labels.length) {
    drawEmptyChart(canvas, "Sem dados para exibir");
    return;
  }

  const { ctx, width, height } = setupCanvas(canvas);
  const pad = { top: 14, right: 12, bottom: 54, left: 12 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(maxValue ?? 0, ...values, 1);
  const barW = innerW / labels.length * 0.62;
  const gap = innerW / labels.length * 0.38;

  ctx.clearRect(0, 0, width, height);

  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + (innerH / 4) * i;
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
  }

  labels.forEach((label, i) => {
    const value = values[i] ?? 0;
    const x = pad.left + i * (barW + gap) + gap / 2;
    const h = (value / max) * innerH;
    const y = pad.top + innerH - h;

    const gradient = ctx.createLinearGradient(0, y, 0, y + h);
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, "rgba(255, 140, 0, 0.35)");

    ctx.fillStyle = gradient;
    if (typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(x, y, barW, h, 5);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, barW, h);
    }

    ctx.fillStyle = "#d9e4f2";
    ctx.font = "600 12px Rajdhani, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`${Math.round(value)}${suffix}`, x + barW / 2, y - 6);

    ctx.fillStyle = "#93a6c1";
    const short = label.length > 14 ? `${label.slice(0, 11)}...` : label;
    ctx.fillText(short, x + barW / 2, height - 18);
  });
}

function drawLineChart(canvas, labels, values) {
  if (!labels.length) {
    drawEmptyChart(canvas, "Selecione um alvo para ver tendencia");
    return;
  }

  const { ctx, width, height } = setupCanvas(canvas);
  const pad = { top: 16, right: 14, bottom: 36, left: 20 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(1, max - min);

  ctx.clearRect(0, 0, width, height);

  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + (innerH / 4) * i;
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
  }

  const points = values.map((value, i) => {
    const x = pad.left + (i / Math.max(1, values.length - 1)) * innerW;
    const y = pad.top + innerH - ((value - min) / range) * innerH;
    return { x, y, value, label: labels[i] };
  });

  const fill = ctx.createLinearGradient(0, pad.top, 0, pad.top + innerH);
  fill.addColorStop(0, "rgba(255, 159, 10, 0.28)");
  fill.addColorStop(1, "rgba(255, 159, 10, 0.02)");

  ctx.beginPath();
  points.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.lineTo(points[points.length - 1].x, pad.top + innerH);
  ctx.lineTo(points[0].x, pad.top + innerH);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  points.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.strokeStyle = "#ff9f0a";
  ctx.lineWidth = 2;
  ctx.stroke();

  points.forEach((p, i) => {
    if (i % Math.ceil(points.length / 10) !== 0 && i !== points.length - 1) return;
    ctx.fillStyle = "#8ea3c1";
    ctx.font = "600 11px Rajdhani, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(p.label, p.x, height - 12);
  });

  points.forEach((p) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = "#ffc266";
    ctx.fill();
  });
}

function renderTargetCharts() {
  const sorted = [...state.targets].sort((a, b) => (b.uptime_24h ?? -1) - (a.uptime_24h ?? -1)).slice(0, 8);

  drawBarChart(
    els.uptimeChart,
    sorted.map((t) => t.name),
    sorted.map((t) => t.uptime_24h ?? 0),
    { suffix: "%", maxValue: 100, color: "#ff9f0a" }
  );

  const latencySorted = [...state.targets]
    .filter((t) => t.last_latency_ms != null)
    .sort((a, b) => b.last_latency_ms - a.last_latency_ms)
    .slice(0, 8);

  drawBarChart(
    els.latencyChart,
    latencySorted.map((t) => t.name),
    latencySorted.map((t) => t.last_latency_ms ?? 0),
    { suffix: "ms", color: "#58a6ff" }
  );
}

function renderTrendChart() {
  const sorted = [...state.history].sort((a, b) => new Date(a.checked_at) - new Date(b.checked_at)).slice(-30);
  const labels = sorted.map((item) => new Date(item.checked_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }));
  const values = sorted.map((item) => item.latency_ms ?? 0);
  drawLineChart(els.trendChart, labels, values);
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

async function refreshDashboard() {
  const data = await api("/api/dashboard");
  els.kpiTotal.textContent = data.total_targets;
  els.kpiUp.textContent = data.up_now;
  els.kpiDown.textContent = data.down_now;
  els.kpiUptime.textContent = data.avg_uptime_24h == null ? "--" : `${data.avg_uptime_24h.toFixed(2)}%`;
  state.targets = data.targets || [];
  renderTargets(state.targets);
  renderTargetCharts();

  if (state.selectedTargetId != null) {
    const found = state.targets.find((item) => Number(item.id) === Number(state.selectedTargetId));
    if (!found) {
      state.selectedTargetId = null;
      state.selectedTargetName = "";
      state.history = [];
      els.historyTitle.textContent = 'Clique em "Historico" em um alvo.';
      els.historyBody.innerHTML = '<tr><td colspan="5">Sem historico para esse alvo.</td></tr>';
      els.trendTitle.textContent = "Tendencia de latencia (selecione um alvo)";
      renderTrendChart();
    }
  }
}

async function refreshAll() {
  await refreshDashboard();
  if (state.selectedTargetId != null) {
    await loadHistory(state.selectedTargetId, state.selectedTargetName || "alvo");
  }
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
  if (Number(state.selectedTargetId) === Number(targetId)) {
    state.selectedTargetId = null;
    state.selectedTargetName = "";
    state.history = [];
    els.historyTitle.textContent = 'Clique em "Historico" em um alvo.';
    els.historyBody.innerHTML = '<tr><td colspan="5">Sem historico para esse alvo.</td></tr>';
    els.trendTitle.textContent = "Tendencia de latencia (selecione um alvo)";
    renderTrendChart();
  }
  await refreshDashboard();
}

async function checkTarget(targetId) {
  await api(`/api/targets/${targetId}/check`, { method: "POST" });
  await refreshDashboard();
  if (Number(state.selectedTargetId) === Number(targetId)) {
    await loadHistory(targetId, state.selectedTargetName || "alvo");
  }
}

async function loadHistory(targetId, targetName) {
  const history = await api(`/api/targets/${targetId}/history?limit=60`);
  state.selectedTargetId = Number(targetId);
  state.selectedTargetName = targetName;
  state.history = history || [];

  els.historyTitle.textContent = `Historico de ${targetName}`;
  els.trendTitle.textContent = `Tendencia de latencia - ${targetName}`;

  if (!history.length) {
    els.historyBody.innerHTML = `<tr><td colspan="5">Sem historico para esse alvo.</td></tr>`;
    renderTrendChart();
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

  renderTrendChart();
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

function redrawCharts() {
  renderTargetCharts();
  renderTrendChart();
}

function updateRefreshStatus() {
  els.refreshStatus.textContent = `Auto refresh em ${state.refreshCountdown}s`;
}

function startAutoRefresh() {
  state.refreshCountdown = AUTO_REFRESH_SECONDS;
  updateRefreshStatus();

  window.setInterval(() => {
    state.refreshCountdown -= 1;
    if (state.refreshCountdown <= 0) {
      state.refreshCountdown = AUTO_REFRESH_SECONDS;
      refreshAll().catch(() => {});
    }
    updateRefreshStatus();
  }, 1000);
}

els.form.addEventListener("submit", createTarget);
els.targetsBody.addEventListener("click", handleTableClick);
els.refreshNow.addEventListener("click", () => {
  state.refreshCountdown = AUTO_REFRESH_SECONDS;
  updateRefreshStatus();
  refreshAll().catch((err) => {
    els.message.textContent = err.message;
  });
});
window.addEventListener("resize", () => {
  window.clearTimeout(window.__gtResizeTimer);
  window.__gtResizeTimer = window.setTimeout(redrawCharts, 120);
});

refreshDashboard()
  .then(() => {
    renderTrendChart();
    startAutoRefresh();
  })
  .catch((err) => {
    els.message.textContent = err.message;
  });
