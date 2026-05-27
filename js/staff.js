(function () {
  const session = Portal.getSession();
  if (!session) return;
  if (session.role !== "staff") location.href = "admin.html";

  let state = {};
  let refreshTimer;
  let breakStartedAt = null;
  const BREAK_RULES = {
    BREAK: { label: "Break", limit: 1, minutes: 60 },
    BIO_BREAK: { label: "Bio Break", limit: 3, minutes: 11 },
    PRAYER_BREAK: { label: "Prayer Break", limit: 3, minutes: 15 }
  };

  const empty = (message) => `<tr><td colspan="8" class="empty-state">${message}</td></tr>`;
  const badge = (text, tone = "") => `<span class="badge ${tone}">${text || "--"}</span>`;
  const initials = (name) => String(name || "SP").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  const numeric = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const averageScore = (rows, keys) => {
    const values = rows
      .map((row) => numeric(Portal.pick(row, keys, "")))
      .filter((value) => value !== null);
    if (!values.length) return "--";
    return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
  };
  const dateKey = (value) => String(value || "").slice(0, 10);

  const normalizeDashboard = (data) => {
    const root = data.data || data.dashboard || data;
    const staff = root.staff || root.profile || root.user || session.raw || {};
    const schedule = root.today_schedule || root.schedule || root.shift || {};
    const attendance = root.attendance_state || root.today || root.attendance || root.current || {};
    const kpi = root.own_kpi || root.performance || root.kpi || {};
    const leaderboard = Portal.normalizeArray(root.leaderboard || root.rankings);
    const attendanceEvents = Portal.normalizeArray(root.attendance_events || root.timeline || root.activity || root.logs);
    const dailyScores = Portal.normalizeArray(root.daily_scores || root.history || root.attendanceHistory || root.records);
    const quarterScores = Portal.normalizeArray(root.quarter_scores || root.quarterScores);
    const quarterScore = root.quarter_score || quarterScores[0] || {};
    const nextSchedule = Portal.normalizeArray(root.next_7_schedule || root.upcoming_schedule || root.nextSchedule);
    const monthlySchedule = Portal.normalizeArray(root.monthly_schedule);
    const selectedMonth = document.getElementById("scheduleMonth")?.value || new Date().toISOString().slice(0, 7);
    const currentMonth = new Date().toISOString().slice(0, 7);
    const scheduleList = selectedMonth === currentMonth && nextSchedule.length ? nextSchedule : monthlySchedule;
    const loginKey = String(Portal.pick(staff, ["login_id"], session.loginId || session.staffId || "")).toLowerCase();
    const ownLeader = leaderboard.find((row) => String(Portal.pick(row, ["login_id", "email"], "")).toLowerCase() === loginKey);
    const todayKey = new Date().toISOString().slice(0, 10);
    const todayEvents = attendanceEvents.filter((row) => dateKey(Portal.pick(row, ["event_date", "date", "created_at"], "")) === todayKey);
    const monthlyAttendanceScore = Portal.pick(root, ["monthly_attendance_score"], averageScore(dailyScores, ["final_attendance_score", "attendanceScore", "score"]));
    const kpiScore = Portal.pick(kpi, ["kpi_score_out_of_5", "kpiScore", "score"], "--");
    const finalScore = numeric(monthlyAttendanceScore) !== null && numeric(kpiScore) !== null
      ? Number((numeric(monthlyAttendanceScore) * 0.4 + numeric(kpiScore) * 0.6).toFixed(2))
      : Portal.pick(root, ["final_score"], "--");
    return {
      staff,
      today: {
        ...attendance,
        status: attendance.hasCheckOut ? "Checked out" : attendance.hasCheckIn ? "Checked in" : "Not checked in",
        breakStatus: attendance.activeBreak ? attendance.activeBreak.replaceAll("_", " ") : "Not on break",
        ipAllowed: true
      },
      shift: {
        ...schedule,
        name: Portal.pick(schedule, ["shift_code", "shift", "name"], "Today shift"),
        start: Portal.pick(schedule, ["start_time", "start", "startTime"], ""),
        end: Portal.pick(schedule, ["end_time", "end", "endTime"], "")
      },
      performance: {
        ...kpi,
        kpiScore,
        quarterScore: Portal.pick(quarterScore, ["final_score", "quarter_score", "score"], Portal.pick(root, ["quarter_score"], "--")),
        rank: Portal.pick(root, ["current_rank", "rank"], Portal.pick(ownLeader || {}, ["rank", "position"], Portal.pick(kpi, ["rank"], "--"))),
        monthlyAttendanceScore,
        finalScore,
        quarter: Portal.pick(quarterScore, ["quarter"], "")
      },
      history: attendanceEvents.length ? attendanceEvents : dailyScores,
      scheduleList,
      tomorrowSchedule: root.tomorrow_schedule || {},
      leaderboard,
      timeline: todayEvents.length ? todayEvents : attendanceEvents,
      ip: root.ip || root.ipStatus || { allowed: true, message: "IP allowed" }
    };
  };

  const shiftProgress = (shift) => {
    const start = new Date(Portal.pick(shift, ["start", "startTime", "shiftStart"], ""));
    const end = new Date(Portal.pick(shift, ["end", "endTime", "shiftEnd"], ""));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return Portal.percent(Portal.pick(shift, ["progress"], 0));
    const now = Date.now();
    return Portal.percent(((now - start.getTime()) / (end.getTime() - start.getTime())) * 100);
  };

  const renderProfile = ({ staff, today, shift, performance, leaderboard, timeline, history, scheduleList, tomorrowSchedule, ip }) => {
    const name = Portal.pick(staff, ["full_name", "name", "fullName", "staffName", "displayName"], session.name);
    Portal.setText("staffGreeting", `Welcome back, ${name}`);
    Portal.setText("staffInitials", initials(name));
    Portal.setText("staffName", name);
    Portal.setText("staffMeta", [Portal.pick(staff, ["role", "position"], "Staff"), Portal.pick(staff, ["department", "team"], "")].filter(Boolean).join(" / "));

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
    Portal.setText("monthlyScore", Portal.pick(performance, ["monthlyAttendanceScore", "monthly_attendance_score", "attendanceScore", "monthlyScore"], "--"));
    Portal.setText("kpiScore", Portal.pick(performance, ["kpi_score_out_of_5", "kpi", "kpiScore", "score"], "--"));
    Portal.setText("quarterScore", Portal.pick(performance, ["final_score", "quarterScore", "quarter_score", "quarter"], "--"));
    Portal.setText("rankPosition", Portal.pick(performance, ["rank", "rankPosition", "position"], "--"));
    const finalScore = Portal.pick(performance, ["finalScore", "final_score"], "--");
    Portal.setText("scoreUpdated", finalScore === "--" ? Portal.pick(performance, ["updatedAt", "month"], "Live") : `Final score: ${finalScore}`);
    setRing("kpiRing", Portal.pick(performance, ["kpi_score_out_of_5", "kpi", "kpiScore", "score"], 0), "var(--cyan)");
    setRing("quarterRing", Portal.pick(performance, ["final_score", "quarterScore", "quarter_score", "quarter"], 0), "var(--green)");

    renderLeaderboard(leaderboard);
    renderTimeline(timeline);
    renderHistory(history);
    renderUpcomingSchedule(scheduleList, tomorrowSchedule);
    updateActionStates(today);
  };

  const setRing = (id, value, color) => {
    const el = document.getElementById(id);
    if (!el) return;
    const numeric = Number(value);
    const percent = Number.isFinite(numeric) && numeric <= 5 ? numeric * 20 : numeric;
    el.style.background = `conic-gradient(${color} ${Portal.percent(percent) * 3.6}deg, rgba(255,255,255,.08) 0)`;
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
        <div><strong>${Portal.pick(row, ["name", "staffName", "full_name", "staff"], "Staff")}</strong><br><small>${Portal.pick(row, ["department", "team"], "")}</small></div>
        <strong>${Portal.pick(row, ["score", "kpi", "kpi_score_out_of_5", "quarterScore"], "--")}</strong>
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
        <span class="badge green">${Portal.formatTime(Portal.pick(row, ["event_time", "time", "created_at", "createdAt", "timestamp"], ""))}</span>
        <div><strong>${Portal.pick(row, ["event_type", "action", "event", "title"], "Activity")}</strong><br><small>${Portal.pick(row, ["break_type", "message", "note", "details", "ip"], "")}</small></div>
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
    host.innerHTML = rows.slice(0, 20).map((row) => {
      const eventType = String(Portal.pick(row, ["event_type", "action", "event"], "")).toUpperCase();
      const eventTime = Portal.pick(row, ["event_time", "time", "created_at", "createdAt", "timestamp"], "");
      const isEventRow = Boolean(eventType);
      const inTime = isEventRow && /CHECK_IN|BREAK_START/.test(eventType) ? eventTime : Portal.pick(row, ["checkIn", "in", "check_in", "firstCheckIn"], "");
      const outTime = isEventRow && /CHECK_OUT|BREAK_END/.test(eventType) ? eventTime : Portal.pick(row, ["checkOut", "out", "check_out", "lastCheckOut"], "");
      const status = isEventRow ? eventType.replaceAll("_", " ") : Portal.pick(row, ["status", "state"], "--");
      const breakText = isEventRow
        ? Portal.pick(row, ["break_type", "shift_code", "ip"], "--")
        : Portal.pick(row, ["breakDuration", "break", "breakTotal", "penalty", "final_attendance_score"], "--");
      return `
        <tr>
          <td>${Portal.formatDate(Portal.pick(row, ["score_date", "event_date", "date", "day"], ""))}</td>
          <td>${Portal.formatTime(inTime)}</td>
          <td>${Portal.formatTime(outTime)}</td>
          <td>${badge(status, statusTone(status))}</td>
          <td>${breakText}</td>
        </tr>`;
    }).join("");
  };

  const renderUpcomingSchedule = (rows, tomorrow) => {
    const host = document.getElementById("upcomingSchedule");
    if (!host) return;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const nextWeek = new Date(today);
    nextWeek.setDate(today.getDate() + 7);
    let list = rows.filter((row) => {
      const date = new Date(`${Portal.pick(row, ["date", "schedule_date"], "")}T00:00:00`);
      return !Number.isNaN(date.getTime()) && date >= today;
    });
    if (tomorrow?.ok && !list.some((row) => Portal.pick(row, ["date", "schedule_date"], "") === Portal.pick(tomorrow, ["schedule_date", "date"], ""))) {
      list.push({
        date: Portal.pick(tomorrow, ["schedule_date", "date"], ""),
        shift_code: Portal.pick(tomorrow, ["shift_code"], ""),
        start_time: Portal.pick(tomorrow, ["start_time"], ""),
        end_time: Portal.pick(tomorrow, ["end_time"], ""),
        status: Portal.pick(tomorrow, ["status"], "")
      });
    }
    list.sort((a, b) => String(Portal.pick(a, ["date", "schedule_date"], "")).localeCompare(String(Portal.pick(b, ["date", "schedule_date"], ""))));
    const nextSeven = list.filter((row) => {
      const date = new Date(`${Portal.pick(row, ["date", "schedule_date"], "")}T00:00:00`);
      return date <= nextWeek;
    });
    const output = (nextSeven.length ? nextSeven : list).slice(0, 7);
    if (!output.length) {
      host.innerHTML = empty("No upcoming schedule found for selected month.");
      return;
    }
    host.innerHTML = output.map((row) => `
      <tr>
        <td>${Portal.formatDate(Portal.pick(row, ["date", "schedule_date"], ""))}</td>
        <td>${Portal.pick(row, ["shift_code", "shift"], "--")}</td>
        <td>${Portal.formatTime(Portal.pick(row, ["start_time", "start"], ""))}</td>
        <td>${Portal.formatTime(Portal.pick(row, ["end_time", "end"], ""))}</td>
        <td>${badge(Portal.pick(row, ["status"], "--"), statusTone(Portal.pick(row, ["status"], "")))}</td>
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
    const checkedIn = today.hasCheckIn === true;
    const checkedOut = today.hasCheckOut === true;
    const activeBreak = Portal.pick(today, ["activeBreak"], "");
    const onBreak = Boolean(activeBreak);
    const selectedBreak = document.getElementById("breakTypeSelect")?.value || "BREAK";
    const counts = today.counts || {};
    const selectedCount = Number(counts[selectedBreak] || 0);
    const selectedRule = BREAK_RULES[selectedBreak] || BREAK_RULES.BREAK;
    const selectedLimitReached = selectedCount >= selectedRule.limit;
    Portal.setText("checkInState", checkedIn ? "Completed" : "Ready");
    Portal.setText("checkOutState", checkedOut ? "Completed" : checkedIn ? "Ready" : "Pending");
    Portal.setText("breakStartState", onBreak ? "Running" : selectedLimitReached ? "Limit reached" : checkedIn ? "Available" : "Check in first");
    Portal.setText("breakEndState", onBreak ? "Ready" : "Inactive");
    Portal.setText("breakLimitHint", `${selectedRule.label}: ${selectedCount}/${selectedRule.limit} used, ${selectedRule.minutes} min limit`);
    breakStartedAt = Portal.pick(today, ["breakStartedAt", "breakStart", "currentBreakStart"], breakStartedAt);
    document.querySelector('[data-action="checkIn"]').disabled = checkedIn;
    document.querySelector('[data-action="checkOut"]').disabled = !checkedIn || checkedOut;
    document.querySelector('[data-action="breakStart"]').disabled = !checkedIn || onBreak || checkedOut || selectedLimitReached;
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
      const month = document.getElementById("scheduleMonth")?.value || new Date().toISOString().slice(0, 7);
      const data = await Portal.api.dashboard("staff", { month });
      state = normalizeDashboard(data);
      renderProfile(state);
    } catch (error) {
      state = normalizeDashboard({});
      renderProfile(state);
      Portal.setStatus(false, "API issue");
      if (!/invalid action/i.test(String(error.message))) Portal.toast(error.message || "Unable to load staff dashboard", "error");
    }
  };

  const bindActions = () => {
    document.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        const action = button.dataset.action;
        const eventMap = {
          checkIn: { event_type: "CHECK_IN" },
          checkOut: { event_type: "CHECK_OUT" },
          breakStart: { event_type: "BREAK_START", break_type: document.getElementById("breakTypeSelect")?.value || "BREAK" },
          breakEnd: { event_type: "BREAK_END", break_type: state.today?.activeBreak || "BREAK" }
        };
        button.disabled = true;
        try {
          const ip = await Portal.api.detectIp();
          await Portal.api.action("attendance_action", {
            login_id: session.loginId || session.staffId,
            ip,
            user_agent: navigator.userAgent,
            ...(eventMap[action] || {})
          });
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
  const scheduleMonth = document.getElementById("scheduleMonth");
  if (scheduleMonth) {
    scheduleMonth.value = new Date().toISOString().slice(0, 7);
    scheduleMonth.addEventListener("change", () => load());
  }
  document.getElementById("breakTypeSelect")?.addEventListener("change", () => updateActionStates(state.today || {}));
  load();
  setInterval(tickBreak, 1000);
  refreshTimer = setInterval(() => load(true), 15000);
  window.addEventListener("beforeunload", () => clearInterval(refreshTimer));
})();
