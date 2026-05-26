(function () {
  const session = Portal.getSession();
  if (!session) return;
  if (session.role !== "admin") location.href = "staff.html";

  let dashboard = {};
  let refreshTimer;

  const empty = (message, span = 8) => `<tr><td colspan="${span}" class="empty-state">${message}</td></tr>`;
  const badge = (text, tone = "") => `<span class="badge ${tone}">${text || "--"}</span>`;

  const normalizeDashboard = (data) => {
    const root = data.data || data.dashboard || data;
    return {
      stats: root.stats || root.summary || root.counters || {},
      attendance: Portal.normalizeArray(root.attendanceBoard || root.attendance || root.onlineStaff),
      breaks: Portal.normalizeArray(root.breakBoard || root.breaks),
      staff: Portal.normalizeArray(root.staff || root.staffList || root.users),
      schedules: Portal.normalizeArray(root.schedules || root.schedule),
      kpis: Portal.normalizeArray(root.kpis || root.kpi || root.monthlyKpi),
      top: Portal.normalizeArray(root.topPerformers || root.leaderboard || root.rankings),
      worst: Portal.normalizeArray(root.worstPerformers || root.lowPerformers || root.needsCoaching),
      dailyLogs: Portal.normalizeArray(root.dailyLogs || root.logs),
      telegramLogs: Portal.normalizeArray(root.telegramLogs),
      auditLogs: Portal.normalizeArray(root.auditLogs || root.audit),
      ipAllowlist: root.ipAllowlist || root.allowlist || []
    };
  };

  const renderStats = (stats) => {
    Portal.setText("totalStaff", Portal.pick(stats, ["totalStaff", "staffTotal", "total"], dashboard.staff.length || "--"));
    Portal.setText("onlineStaff", Portal.pick(stats, ["onlineStaff", "online"], "--"));
    Portal.setText("checkedInToday", Portal.pick(stats, ["checkedInToday", "checkedIn", "present"], "--"));
    Portal.setText("onBreak", Portal.pick(stats, ["onBreak", "breaks"], "--"));
    Portal.setText("lateStaff", Portal.pick(stats, ["lateStaff", "late"], "--"));
    Portal.setText("missingCheckout", Portal.pick(stats, ["missingCheckout", "missingCheckOut"], "--"));
  };

  const statusTone = (value) => {
    const text = String(value).toLowerCase();
    if (text.includes("late") || text.includes("missing") || text.includes("fail") || text.includes("offline")) return "red";
    if (text.includes("break") || text.includes("pending")) return "amber";
    if (text.includes("online") || text.includes("in") || text.includes("ok") || text.includes("sent")) return "green";
    return "";
  };

  const renderAttendance = (rows) => {
    const host = document.getElementById("attendanceBoard");
    if (!host) return;
    if (!rows.length) return host.innerHTML = empty("No live attendance records received.", 5);
    host.innerHTML = rows.map((row) => `
      <tr>
        <td>${Portal.pick(row, ["name", "staffName", "staff"], "Staff")}</td>
        <td>${Portal.pick(row, ["department", "team"], "--")}</td>
        <td>${badge(Portal.pick(row, ["status", "state"], "--"), statusTone(Portal.pick(row, ["status", "state"], "")))}</td>
        <td>${Portal.formatTime(Portal.pick(row, ["checkIn", "check_in", "in"], ""))}</td>
        <td>${Portal.pick(row, ["ip", "ipAddress"], "--")}</td>
      </tr>`).join("");
  };

  const renderBreaks = (rows) => {
    const host = document.getElementById("breakBoard");
    if (!host) return;
    if (!rows.length) return host.innerHTML = empty("No active break records received.", 4);
    host.innerHTML = rows.map((row) => `
      <tr>
        <td>${Portal.pick(row, ["name", "staffName", "staff"], "Staff")}</td>
        <td>${Portal.formatTime(Portal.pick(row, ["breakStart", "start", "startedAt"], ""))}</td>
        <td>${Portal.pick(row, ["duration", "breakDuration"], "--")}</td>
        <td>${badge(Portal.pick(row, ["status", "state"], "--"), statusTone(Portal.pick(row, ["status", "state"], "")))}</td>
      </tr>`).join("");
  };

  const renderStaff = (rows) => {
    const host = document.getElementById("staffTable");
    const query = document.getElementById("staffSearch")?.value.trim().toLowerCase() || "";
    const filtered = query ? rows.filter((row) => JSON.stringify(row).toLowerCase().includes(query)) : rows;
    if (!host) return;
    if (!filtered.length) return host.innerHTML = empty("No staff records match the current filter.", 5);
    host.innerHTML = filtered.map((row) => `
      <tr>
        <td>${Portal.pick(row, ["name", "fullName", "staffName"], "Staff")}</td>
        <td>${Portal.pick(row, ["role", "position"], "--")}</td>
        <td>${Portal.pick(row, ["department", "team"], "--")}</td>
        <td>${Portal.pick(row, ["kpi", "kpiScore", "score"], "--")}</td>
        <td>${badge(Portal.pick(row, ["status", "state"], "--"), statusTone(Portal.pick(row, ["status", "state"], "")))}</td>
      </tr>`).join("");
  };

  const renderSchedules = (rows) => {
    const host = document.getElementById("scheduleTable");
    if (!host) return;
    if (!rows.length) return host.innerHTML = empty("No schedule rows received.", 5);
    host.innerHTML = rows.map((row) => `
      <tr>
        <td>${Portal.pick(row, ["name", "staffName", "staff"], "Staff")}</td>
        <td>${Portal.pick(row, ["shift", "shiftName", "name"], "--")}</td>
        <td>${Portal.formatTime(Portal.pick(row, ["start", "startTime"], ""))}</td>
        <td>${Portal.formatTime(Portal.pick(row, ["end", "endTime"], ""))}</td>
        <td>${Portal.pick(row, ["day", "date"], "--")}</td>
      </tr>`).join("");
  };

  const renderKpi = (rows) => {
    const host = document.getElementById("kpiTable");
    Portal.setText("kpiRows", `${rows.length} rows`);
    if (!host) return;
    if (!rows.length) return host.innerHTML = empty("No KPI rows received.", 5);
    host.innerHTML = rows.map((row) => `
      <tr>
        <td>${Portal.pick(row, ["name", "staffName", "staff"], "Staff")}</td>
        <td>${Portal.pick(row, ["month", "period"], "--")}</td>
        <td>${Portal.pick(row, ["kpi", "kpiScore", "score"], "--")}</td>
        <td>${Portal.pick(row, ["quarter", "quarterScore"], "--")}</td>
        <td>${Portal.pick(row, ["rank", "position"], "--")}</td>
      </tr>`).join("");
  };

  const renderLeaders = (id, rows) => {
    const host = document.getElementById(id);
    if (!host) return;
    if (!rows.length) {
      host.innerHTML = `<div class="empty-state">Ranking records are not available yet.</div>`;
      return;
    }
    host.innerHTML = rows.slice(0, 7).map((row, index) => `
      <div class="leader-row">
        <span class="leader-rank">${Portal.pick(row, ["rank", "position"], index + 1)}</span>
        <div><strong>${Portal.pick(row, ["name", "staffName", "staff"], "Staff")}</strong><br><small>${Portal.pick(row, ["department", "team"], "")}</small></div>
        <strong>${Portal.pick(row, ["score", "kpi", "quarterScore"], "--")}</strong>
      </div>`).join("");
  };

  const renderLogs = (id, rows, columns) => {
    const host = document.getElementById(id);
    if (!host) return;
    if (!rows.length) return host.innerHTML = empty("No log records received.", columns.length);
    host.innerHTML = rows.slice(0, 80).map((row) => `
      <tr>${columns.map((column) => `<td>${column.render ? column.render(row) : Portal.pick(row, column.keys, "--")}</td>`).join("")}</tr>`).join("");
  };

  const renderIpAllowlist = (value) => {
    const textarea = document.getElementById("ipAllowlist");
    if (!textarea || textarea.dataset.touched) return;
    textarea.value = Array.isArray(value) ? value.join("\n") : String(value || "");
  };

  const renderCharts = () => {
    drawBars("attendanceChart", [
      ["Online", Number(Portal.pick(dashboard.stats, ["onlineStaff", "online"], 0))],
      ["Checked In", Number(Portal.pick(dashboard.stats, ["checkedInToday", "checkedIn"], 0))],
      ["Break", Number(Portal.pick(dashboard.stats, ["onBreak", "breaks"], 0))],
      ["Late", Number(Portal.pick(dashboard.stats, ["lateStaff", "late"], 0))],
      ["Missing", Number(Portal.pick(dashboard.stats, ["missingCheckout", "missingCheckOut"], 0))]
    ], "#28dcff");

    const kpiRows = dashboard.kpis.slice(0, 8).map((row) => [Portal.pick(row, ["name", "staffName", "staff"], "Staff"), Number(Portal.pick(row, ["kpi", "kpiScore", "score"], 0))]);
    drawBars("kpiChart", kpiRows, "#54f5a8");
  };

  const drawBars = (id, rows, color) => {
    const canvas = document.getElementById(id);
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "rgba(255,255,255,.08)";
    ctx.fillRect(42, 20, width - 62, height - 66);
    if (!rows.length || rows.every((row) => !row[1])) {
      ctx.fillStyle = "#91a8bb";
      ctx.font = "16px system-ui";
      ctx.fillText("No analytics records received", 54, 64);
      return;
    }
    const max = Math.max(...rows.map((row) => row[1]), 1);
    const gap = 12;
    const barWidth = Math.max(24, (width - 82 - gap * (rows.length - 1)) / rows.length);
    rows.forEach((row, index) => {
      const x = 42 + index * (barWidth + gap);
      const h = Math.max(4, (row[1] / max) * (height - 98));
      const y = height - 46 - h;
      const gradient = ctx.createLinearGradient(0, y, 0, height - 46);
      gradient.addColorStop(0, color);
      gradient.addColorStop(1, "rgba(40,220,255,.18)");
      ctx.fillStyle = gradient;
      ctx.fillRect(x, y, barWidth, h);
      ctx.fillStyle = "#dff7ff";
      ctx.font = "700 13px system-ui";
      ctx.fillText(String(row[1]), x, y - 7);
      ctx.fillStyle = "#91a8bb";
      ctx.font = "12px system-ui";
      ctx.fillText(String(row[0]).slice(0, 10), x, height - 24);
    });
  };

  const renderAll = () => {
    renderStats(dashboard.stats);
    renderAttendance(dashboard.attendance);
    renderBreaks(dashboard.breaks);
    renderStaff(dashboard.staff);
    renderSchedules(dashboard.schedules);
    renderKpi(dashboard.kpis);
    renderLeaders("topPerformers", dashboard.top);
    renderLeaders("worstPerformers", dashboard.worst);
    renderLogs("dailyLogs", dashboard.dailyLogs, [
      { render: (row) => Portal.formatTime(Portal.pick(row, ["time", "timestamp", "createdAt"], "")) },
      { keys: ["name", "staffName", "staff"] },
      { keys: ["action", "event"] },
      { render: (row) => badge(Portal.pick(row, ["status", "state"], "--"), statusTone(Portal.pick(row, ["status", "state"], ""))) }
    ]);
    renderLogs("telegramLogs", dashboard.telegramLogs, [
      { render: (row) => Portal.formatTime(Portal.pick(row, ["time", "timestamp", "createdAt"], "")) },
      { keys: ["target", "chat", "recipient"] },
      { keys: ["message", "text"] },
      { render: (row) => badge(Portal.pick(row, ["status", "state"], "--"), statusTone(Portal.pick(row, ["status", "state"], ""))) }
    ]);
    renderLogs("auditLogs", dashboard.auditLogs, [
      { render: (row) => Portal.formatTime(Portal.pick(row, ["time", "timestamp", "createdAt"], "")) },
      { keys: ["user", "name", "email"] },
      { keys: ["action", "event"] },
      { keys: ["ip", "ipAddress"] },
      { render: (row) => badge(Portal.pick(row, ["result", "status", "state"], "--"), statusTone(Portal.pick(row, ["result", "status", "state"], ""))) }
    ]);
    renderIpAllowlist(dashboard.ipAllowlist);
    renderCharts();
  };

  const load = async (silent = false) => {
    if (!silent) Portal.setStatus(false, "Loading");
    try {
      const data = await Portal.api.dashboard("admin");
      dashboard = normalizeDashboard(data);
      renderAll();
    } catch (error) {
      dashboard = normalizeDashboard({});
      renderAll();
      Portal.setStatus(false, "API issue");
      if (!/invalid action/i.test(String(error.message))) Portal.toast(error.message || "Unable to load admin dashboard", "error");
    }
  };

  const callFirstValid = async (actions, payload) => {
    let lastError;
    for (const action of actions) {
      try {
        const data = await Portal.api.action(action, payload);
        if (/invalid action/i.test(String(data?.message || data?.error || ""))) {
          lastError = new Error(data.message || data.error);
          continue;
        }
        return data;
      } catch (error) {
        if (/invalid action/i.test(String(error.message))) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    throw lastError || new Error("Action is not available");
  };

  const parseCsv = (text) => {
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      const next = text[i + 1];
      if (char === '"' && quoted && next === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === "," && !quoted) {
        row.push(cell.trim());
        cell = "";
      } else if ((char === "\n" || char === "\r") && !quoted) {
        if (char === "\r" && next === "\n") i += 1;
        row.push(cell.trim());
        if (row.some(Boolean)) rows.push(row);
        row = [];
        cell = "";
      } else {
        cell += char;
      }
    }
    row.push(cell.trim());
    if (row.some(Boolean)) rows.push(row);
    if (!rows.length) return [];
    const headers = rows.shift().map((item) => item.trim());
    return rows.map((items) => headers.reduce((record, header, index) => {
      record[header] = items[index] || "";
      return record;
    }, {}));
  };

  const exportTable = (name) => {
    const map = {
      attendance: dashboard.attendance,
      breaks: dashboard.breaks,
      schedule: dashboard.schedules,
      dailyLogs: dashboard.dailyLogs,
      telegramLogs: dashboard.telegramLogs,
      auditLogs: dashboard.auditLogs
    };
    const rows = map[name] || [];
    if (!rows.length) return Portal.toast("No rows available to export");
    const keys = Array.from(rows.reduce((set, row) => {
      Object.keys(row).forEach((key) => set.add(key));
      return set;
    }, new Set()));
    const csv = [keys.join(","), ...rows.map((row) => keys.map((key) => `"${String(row[key] ?? "").replaceAll('"', '""')}"`).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  document.getElementById("staffSearch")?.addEventListener("input", () => renderStaff(dashboard.staff || []));
  document.getElementById("ipAllowlist")?.addEventListener("input", (event) => event.target.dataset.touched = "1");
  document.querySelectorAll("[data-export]").forEach((btn) => btn.addEventListener("click", () => exportTable(btn.dataset.export)));
  document.querySelector("[data-refresh]")?.addEventListener("click", () => load());
  document.getElementById("clearScheduleUpload")?.addEventListener("click", () => {
    const input = document.getElementById("scheduleFile");
    const state = document.getElementById("scheduleUploadState");
    if (input) input.value = "";
    if (state) state.hidden = true;
  });
  document.getElementById("scheduleUploadForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const state = document.getElementById("scheduleUploadState");
    const file = document.getElementById("scheduleFile")?.files?.[0];
    if (!file) {
      state.hidden = false;
      state.textContent = "Select a CSV schedule file first.";
      return;
    }
    try {
      state.hidden = false;
      state.textContent = "Uploading schedule...";
      const csv = await file.text();
      const rows = parseCsv(csv);
      await callFirstValid(["uploadSchedule", "saveScheduleBatch", "importSchedule", "updateSchedule"], {
        fileName: file.name,
        csv,
        rows,
        schedules: rows
      });
      state.textContent = `Schedule uploaded: ${rows.length} rows.`;
      Portal.toast("Schedule uploaded");
      await load(true);
    } catch (error) {
      state.textContent = /invalid action/i.test(String(error.message))
        ? "Schedule upload action is not enabled in the Worker yet."
        : (error.message || "Unable to upload schedule.");
    }
  });
  document.getElementById("kpiInputForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const state = document.getElementById("kpiInputState");
    const payload = {
      staffId: document.getElementById("kpiStaffId").value.trim(),
      login_id: document.getElementById("kpiStaffId").value.trim(),
      email: document.getElementById("kpiStaffId").value.trim(),
      month: document.getElementById("kpiMonth").value,
      leadership: Number(document.getElementById("kpiLeadership").value || 0),
      effectiveness: Number(document.getElementById("kpiEffectiveness").value || 0),
      problemSolving: Number(document.getElementById("kpiProblemSolving").value || 0),
      communication: Number(document.getElementById("kpiCommunication").value || 0),
      productivity: Number(document.getElementById("kpiProductivity").value || 0),
      initiative: Number(document.getElementById("kpiInitiative").value || 0),
      penalty: Number(document.getElementById("kpiPenalty").value || 0)
    };
    payload.kpiScore = Math.max(0, (
      payload.leadership +
      payload.effectiveness +
      payload.problemSolving +
      payload.communication +
      payload.productivity +
      payload.initiative -
      payload.penalty
    ) / 6);
    try {
      state.hidden = false;
      state.textContent = "Saving KPI...";
      await callFirstValid(["saveKPI", "saveKpi", "updateKPI", "updateKpi", "saveMonthlyKPI"], payload);
      state.textContent = `KPI saved for ${payload.staffId}.`;
      Portal.toast("KPI saved");
      await load(true);
    } catch (error) {
      state.textContent = /invalid action/i.test(String(error.message))
        ? "KPI save action is not enabled in the Worker yet."
        : (error.message || "Unable to save KPI.");
    }
  });
  document.getElementById("saveIpBtn")?.addEventListener("click", async () => {
    const state = document.getElementById("ipSaveState");
    try {
      const ips = document.getElementById("ipAllowlist").value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      await Portal.api.action("saveIpAllowlist", { ips, ipAllowlist: ips });
      state.hidden = false;
      state.textContent = "IP allowlist saved through Worker.";
      Portal.toast("IP allowlist saved");
    } catch (error) {
      state.hidden = false;
      state.textContent = error.message || "Unable to save IP allowlist.";
    }
  });

  load();
  refreshTimer = setInterval(() => load(true), 15000);
  window.addEventListener("resize", renderCharts);
  window.addEventListener("beforeunload", () => clearInterval(refreshTimer));
})();
