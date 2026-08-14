const $ = (sel) => document.querySelector(sel);

const els = {
  statusPanel: $("#statusPanel"),
  statusLabel: $("#statusLabel"),
  statusMeta: $("#statusMeta"),
  ttlBox: $("#ttlBox"),
  ttlValue: $("#ttlValue"),
  hostMatrix: $("#hostMatrix"),
  adviceBox: $("#adviceBox"),
  machineLabel: $("#machineLabel"),
  userid: $("#userid"),
  username: $("#username"),
  publicKey: $("#publicKey"),
  keyMeta: $("#keyMeta"),
  factKeepalive: $("#factKeepalive"),
  factKnock: $("#factKnock"),
  factKey: $("#factKey"),
  factLast: $("#factLast"),
  logList: $("#logList"),
  btnProbe: $("#btnProbe"),
  btnDiagnose: $("#btnDiagnose"),
  btnScroll: $("#btnScroll"),
  btnApply: $("#btnApply"),
  btnAuthorize: $("#btnAuthorize"),
};

let snapshot = null;
let probeTimer = null;
let authorizedSince = null;

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || data.result?.reason || `请求失败 (${res.status})`);
  }
  return data;
}

function fmtMs(ms) {
  if (!ms && ms !== 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

function fmtTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

function setBusy(btn, busy, label) {
  if (!btn) return;
  btn.disabled = busy;
  if (label) btn.dataset.label ||= btn.textContent;
  btn.textContent = busy ? label : btn.dataset.label || btn.textContent;
}

function renderHosts(hosts, advice) {
  if (!hosts?.length) {
    els.hostMatrix.hidden = true;
    els.adviceBox.hidden = true;
    return;
  }
  els.hostMatrix.hidden = false;
  els.hostMatrix.innerHTML = "";
  for (const h of hosts) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = h.name;
    const code = document.createElement("span");
    code.className = "code";
    code.textContent = h.httpStatus ? String(h.httpStatus) : "—";
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = h.hint || h.error || `dns ${h.dns || "—"}`;
    li.append(name, code, hint);
    els.hostMatrix.append(li);
  }
  if (advice?.length) {
    els.adviceBox.hidden = false;
    els.adviceBox.textContent = advice[0];
  } else {
    els.adviceBox.hidden = true;
  }
}

function renderStatus(state) {
  const authorized = Boolean(state?.authorized);
  const panelState = state ? (authorized ? "authorized" : "unauthorized") : "unknown";
  els.statusPanel.dataset.state = panelState;
  els.statusLabel.textContent = state?.status || "检测中";

  if (!state) {
    els.statusMeta.textContent = "正在探测 spacheck.json…";
    els.ttlBox.hidden = true;
    return;
  }

  if (authorized) {
    if (!authorizedSince) authorizedSince = state.checkedAt || Date.now();
    const validMs = snapshot?.config?.authValidMs || 1_200_000;
    const remain = Math.max(0, validMs - (Date.now() - authorizedSince));
    els.statusMeta.textContent = `HTTP ${state.httpStatus} · ${state.latencyMs ?? "—"}ms · 白名单对本机公网 IP 生效`;
    els.ttlBox.hidden = false;
    els.ttlValue.textContent = fmtMs(remain);
  } else {
    authorizedSince = null;
    els.statusMeta.textContent = state.error
      ? `不可达：${state.error}`
      : `HTTP ${state.httpStatus || "—"} · 未进入白名单（git 403 也常表示未授权）`;
    els.ttlBox.hidden = true;
  }

  renderHosts(state.hosts || snapshot?.hosts, state.advice);
}

function renderSnapshot(snap) {
  snapshot = snap;
  els.machineLabel.textContent = `machine ${snap.machineid?.slice(0, 16) || "—"}…`;

  if (snap.profile) {
    if (!els.userid.value) els.userid.value = snap.profile.userid || "";
    if (!els.username.value) els.username.value = snap.profile.username || "";
  }

  if (snap.hasKey) {
    els.keyMeta.textContent = `本地已保存公钥 · 更新于 ${fmtTime(snap.keyUpdatedAt)}`;
    if (!els.publicKey.value) {
      els.publicKey.placeholder = "已有本地公钥（可粘贴新密钥覆盖）";
    }
  } else {
    els.keyMeta.textContent = "尚未保存本地公钥";
  }

  els.factKeepalive.textContent = snap.keepAlive ? "运行中" : "未启动";
  els.factKnock.textContent = fmtMs(snap.config?.knockIntervalMs);
  els.factKey.textContent = fmtMs(snap.config?.publicKeyIntervalMs);
  if (snap.lastKnock) {
    els.factLast.textContent = `${snap.lastKnock.type} · ${fmtTime(snap.lastKnock.at)}${
      snap.lastKnock.skipped ? " · 跳过" : ""
    }`;
  } else {
    els.factLast.textContent = "—";
  }

  renderStatus(snap.state);
  if (snap.hosts) renderHosts(snap.hosts, snap.state?.advice);
  renderLogs(snap.logs || []);
  scheduleProbeLoop(snap.state?.authorized);
}

function renderLogs(logs) {
  els.logList.innerHTML = "";
  for (const entry of logs.slice(0, 12)) {
    const li = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = fmtTime(entry.at);
    li.append(time, document.createTextNode(`${entry.message}`));
    els.logList.append(li);
  }
}

function scheduleProbeLoop(authorized) {
  if (probeTimer) clearInterval(probeTimer);
  // Unauthorized: retry every 1s (page). Authorized: slower refresh.
  const ms = authorized ? 15_000 : 1_000;
  probeTimer = setInterval(() => {
    refresh(false).catch(() => {});
  }, ms);
}

async function refresh(doProbe = false) {
  if (doProbe) {
    const data = await api("/api/probe", { method: "POST", body: "{}" });
    renderSnapshot(data.snapshot);
    return data;
  }
  const data = await api("/api/status");
  renderSnapshot(data);
  return data;
}

async function saveProfileIfNeeded() {
  const userid = els.userid.value.trim();
  const username = els.username.value.trim();
  if (!userid || !username) throw new Error("请填写工号与姓名");
  await api("/api/profile", {
    method: "POST",
    body: JSON.stringify({ userid, username, usercode: userid }),
  });
}

els.btnScroll.addEventListener("click", () => {
  $("#authFlow").scrollIntoView({ behavior: "smooth", block: "start" });
});

els.btnProbe.addEventListener("click", async () => {
  setBusy(els.btnProbe, true, "探测中…");
  try {
    await refresh(true);
  } catch (err) {
    els.statusMeta.textContent = err.message;
  } finally {
    setBusy(els.btnProbe, false);
  }
});

els.btnDiagnose.addEventListener("click", async () => {
  setBusy(els.btnDiagnose, true, "诊断中…");
  try {
    const data = await api("/api/diagnose", { method: "POST", body: "{}" });
    renderSnapshot(data.snapshot);
    if (data.diagnose?.advice?.length) {
      els.adviceBox.hidden = false;
      els.adviceBox.textContent = data.diagnose.advice.join(" ");
    }
  } catch (err) {
    els.statusMeta.textContent = err.message;
  } finally {
    setBusy(els.btnDiagnose, false);
  }
});

els.btnApply.addEventListener("click", async () => {
  setBusy(els.btnApply, true, "发送中…");
  try {
    await saveProfileIfNeeded();
    const data = await api("/api/apply", {
      method: "POST",
      body: JSON.stringify({
        userid: els.userid.value.trim(),
        username: els.username.value.trim(),
      }),
    });
    renderSnapshot(data.snapshot);
    els.keyMeta.textContent = "申请已发送 — 请在企业微信查收公钥后粘贴到下方";
  } catch (err) {
    els.keyMeta.textContent = err.message;
  } finally {
    setBusy(els.btnApply, false);
  }
});

els.btnAuthorize.addEventListener("click", async () => {
  setBusy(els.btnAuthorize, true, "敲门中…");
  try {
    await saveProfileIfNeeded();
    const payload = {
      userid: els.userid.value.trim(),
      username: els.username.value.trim(),
    };
    const key = els.publicKey.value.trim();
    if (key) payload.publicKey = key;
    const data = await api("/api/authorize", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    renderSnapshot(data.snapshot);
    // Active probing after knock
    for (const delay of [1000, 2000, 4000]) {
      setTimeout(() => refresh(true).catch(() => {}), delay);
    }
  } catch (err) {
    els.keyMeta.textContent = err.message;
  } finally {
    setBusy(els.btnAuthorize, false);
  }
});

// Boot
refresh(true).catch(async () => {
  try {
    await refresh(false);
  } catch (err) {
    els.statusLabel.textContent = "服务未就绪";
    els.statusMeta.textContent = err.message;
  }
});
