(function () {
  const session = Portal.getSession();
  if (!session) return;
  if (session.role !== "staff") location.href = "admin.html";

  let state = {};
  let refreshTimer;
  let breakStartedAt = null;

  const empty = (message) => `<tr><td colspan="8" class="empty-state">${message}</td></tr>`;
  const badge = (text, tone = "") => `<span class="badge ${tone}">${text || "--"}</span>`;
  const initials = (name) => String(name || "SP").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();

  const normalizeDashboard = (data) => {
    const root = data.data || data.dashboard || data;
    const staff = root.staff || root.profile || root.user || session.raw || {};
    const today = root.today || root.attendance || root.current || {};
    const shift = root.shift || today.shift || {};
    const performance = root.performance || root.kpi || {};
    return {
      staff,
      today,
      shift,
      performance,
      history: Portal.normalizeArray(root.history || root.attendanceHistory || root.records),
      leaderboard: Portal.normalizeArray(root.leaderboard || root.rankings),
      timeline: Portal.normalizeArray(root.timeline || root.activity || root.logs),
      ip: root.ip || root.ipStatus || {}
    };
  };

  const shiftProgress = (shift) => {
    const start = new Date(Portal.pick(shift, ["start", "startTime", "shiftStart"], ""));
    const end = new Date(Portal.pick(shift, ["end", "endTime", "shiftEnd"], ""));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return Portal.percent(Portal.pick(shift, ["progress"], 0));
    const now = Date.now();
    return Portal.percent(((now - start.getTime()) / (end.getTime() - start.getTime())) * 100);
  };

  const renderProfile = ({ staff, today, shift, performance, leaderboard, timeline, history, ip }) => {
    const name = Portal.pick(staff, ["name", "fullName", "staffName", "displayName"], session.name);
    Portal.setText("staffGreeting", `Welcome back, ${name}`);
    Portal.setText("staffInitials", initials(name));
    Portal.setText("staffName", name);
    Portal.setText("staffMeta", [Portal.pick(staff, ["role", "position"], "Staff"), Portal.pick(staff, ["department", "team"], "")].filter(Boolean).join(" • "));

    const ipOk = Boolean(Portal.pick(ip, ["allowed", "isAllowed", "ok"], false) || Portal.pick(today, ["ipAllowed"], false));
    const ipEl = document.getElementById("ipStatus");
    if (ipEl) {
      ipEl.textContent = ipOk ? "IP allowed" : Portal.pick(ip, ["message", "status"], "IP pending");
      ipEl.classList.toggle("safe", ipOk);
      ipEl.classList.toggle("warn", !ipOk);
    }

    Portal.setText("shiftName", Portal.pick(shift, ["name", "shift", "title"], "Assigned shift"));
    const start = Portal.pick(shift, ["start", "startTime", "shiftStart"], Portal.pick(today, ["shiftStart"], ""));
    const end = Portal.pick(shift, ["end", "endTime", "shiftEnd"], Portal.pick(today, ["shiftEnd"], ""));
    Portal.setText("shiftWindow", `${Portal.formatTime(start)} - ${Portal.formatTime(end)}`);
    document.getElementById("shiftProgress").style.width = `${shiftProgress(shift)}%`;
    Portal.setText("lateWarning", Portal.pick(today, ["lateWarning", "lateMessage"], Portal.pick(today, ["isLate"], false) ? "Late warning active" : "On-time status monitored"));

    const attendanceStatus = Portal.pick(today, ["status", "attendanceStatus", "state"], "Not checked in");
    const breakStatus = Portal.pick(today, ["breakStatus", "currentBreakStatus"], "Not on break");
    Portal.setText("attendanceStatus", attendanceStatus);
    Portal.setText("breakStatus", breakStatus);
    Portal.setText("monthlyScore", Portal.pick(performance, ["monthlyAttendanceScore", "attendanceScore", "monthlyScore"], "--"));
    Portal.setText("kpiScore", Portal.pick(performance, ["kpi", "kpiScore", "score"], "--"));
    Portal.setText("quarterScore", Portal.pick(performance, ["quarter", "quarterScore"], "--"));
    Portal.setText("rankPosition", Portal.pick(performance, ["rank", "rankPosition", "position"], "--"));
    Portal.setText("scoreUpdated", Portal.pick(performance, ["updatedAt", "month"], "Live"));
    setRing("kpiRing", Portal.pick(performance, ["kpi", "kpiScore", "score"], 0), "var(--cyan)");
    setRing("quarterRing", Portal.pick(performance, ["quarter", "quarterScore"], 0), "var(--green)");

    renderLeaderboard(leaderboard);
    renderTimeline(timeline);
    renderHistory(history);
    updateActionStates(today);
  };

  const setRing = (id, value, color) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.background = `conic-gradient(${color} ${Portal.percent(value) * 3.6}deg, rgba(255,255,255,.08) 0)`;
  };

  const renderLeaderboard = (rows) => {
    const host = document.getElementById("leaderboardPreview");
    if (!host) return;
    if (!rows.length) {
      host.innerHTML = `<div class="empty-state">Leaderboard data will appear after the API returns ranking records.</div>`;
      return;
    }
    host.innerHTML = rows.slice(0, 5).map((row, index) => `
      <div class="leader-row">
        <span class="leader-rank">${Portal.pick(row, ["rank", "position"], index + 1)}</span>
        <div><strong>${Portal.pick(row, ["name", "staffName", "staff"], "Staff")}</strong><br><small>${Portal.pick(row, ["department", "team"], "")}</small></div>
        <strong>${Portal.pick(row, ["score", "kpi", "quarterScore"], "--")}</strong>
      </div>`).join("");
  };

  const renderTimeline = (rows) => {
    const host = document.getElementById("activityTimeline");
    if (!host) return;
    if (!rows.length) {
      host.innerHTML = `<div class="empty-state">No activity events received yet.</div>`;
      return;
    }
    host.innerHTML = rows.slice(0, 8).map((row) => `
      <div class="timeline-row">
        <span class="badge green">${Portal.formatTime(Portal.pick(row, ["time", "createdAt", "timestamp"], ""))}</span>
        <div><strong>${Portal.pick(row, ["action", "event", "title"], "Activity")}</strong><br><small>${Portal.pick(row, ["message", "note", "details"], "")}</small></div>
        ${badge(Portal.pick(row, ["status", "state"], "ok"))}
      </div>`).join("");
  };

  const renderHistory = (rows) => {
    const host = document.getElementById("attendanceHistory");
    if (!host) return;
    Portal.setText("historyCount", `${rows.length} records`);
    if (!rows.length) {
      host.innerHTML = empty("Attendance history is empty.");
      return;
    }
    host.innerHTML = rows.slice(0, 20).map((row) => `
      <tr>
        <td>${Portal.formatDate(Portal.pick(row, ["date", "day"], ""))}</td>
        <td>${Portal.formatTime(Portal.pick(row, ["checkIn", "in", "check_in"], ""))}</td>
        <td>${Portal.formatTime(Portal.pick(row, ["checkOut", "out", "check_out"], ""))}</td>
        <td>${badge(Portal.pick(row, ["status", "state"], "--"), statusTone(Portal.pick(row, ["status", "state"], "")))}</td>
        <td>${Portal.pick(row, ["breakDuration", "break", "breakTotal"], "--")}</td>
      </tr>`).join("");
  };

  const statusTone = (value) => {
    const text = String(value).toLowerCase();
    if (text.includes("late") || text.includes("missing") || text.includes("absent")) return "red";
    if (text.includes("break") || text.includes("pending")) return "amber";
    if (text.includes("in") || text.includes("present") || text.includes("ok")) return "green";
    return "";
  };

  const updateActionStates = (today) => {
    const checkedIn = /in|present|online/i.test(Portal.pick(today, ["status", "attendanceStatus", "state"], ""));
    const checkedOut = /out|closed|complete/i.test(Portal.pick(today, ["status", "attendanceStatus", "state"], ""));
    const onBreak = /break/i.test(Portal.pick(today, ["breakStatus", "currentBreakStatus"], ""));
    Portal.setText("checkInState", checkedIn ? "Completed" : "Ready");
    Portal.setText("checkOutState", checkedOut ? "Completed" : checkedIn ? "Ready" : "Pending");
    Portal.setText("breakStartState", onBreak ? "Running" : checkedIn ? "Available" : "Check in first");
    Portal.setText("breakEndState", onBreak ? "Ready" : "Inactive");
    breakStartedAt = Portal.pick(today, ["breakStartedAt", "breakStart", "currentBreakStart"], breakStartedAt);
    document.querySelector('[data-action="checkIn"]').disabled = checkedIn && !checkedOut;
    document.querySelector('[data-action="checkOut"]').disabled = !checkedIn || checkedOut;
    document.querySelector('[data-action="breakStart"]').disabled = !checkedIn || onBreak || checkedOut;
    document.querySelector('[data-action="breakEnd"]').disabled = !onBreak;
  };

  const tickBreak = () => {
    if (!breakStartedAt) return Portal.setText("breakTimer", "00:00:00");
    const start = new Date(breakStartedAt);
    if (Number.isNaN(start.getTime())) return;
    const diff = Math.max(0, Date.now() - start.getTime());
    const h = String(Math.floor(diff / 3600000)).padStart(2, "0");
    const m = String(Math.floor((diff % 3600000) / 60000)).padStart(2, "0");
    const s = String(Math.floor((diff % 60000) / 1000)).padStart(2, "0");
    Portal.setText("breakTimer", `${h}:${m}:${s}`);
  };

  const load = async (silent = false) => {
    if (!silent) Portal.setStatus(false, "Loading");
    try {
      const data = await Portal.api.dashboard("staff");
      state = normalizeDashboard(data);
      renderProfile(state);
    } catch (error) {
      state = normalizeDashboard({});
      renderProfile(state);
      Portal.setStatus(false, "API issue");
      Portal.toast(error.message || "Unable to load staff dashboard", "error");
    }
  };

  const bindActions = () => {
    document.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        const action = button.dataset.action;
        button.disabled = true;
        try {
          await Portal.api.action(action, { staffId: session.staffId });
          Portal.toast(`${button.firstChild.textContent.trim()} recorded`);
          await load(true);
        } catch (error) {
          Portal.toast(error.message || "Action failed", "error");
        } finally {
          button.disabled = false;
        }
      });
    });
  };

  bindActions();
  load();
  setInterval(tickBreak, 1000);
  refreshTimer = setInterval(() => load(true), 15000);
  window.addEventListener("beforeunload", () => clearInterval(refreshTimer));
})();
