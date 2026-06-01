(function () {
  const session = Portal.getSession();
  if (!session) return;
  if (session.role !== "staff") location.href = "admin.html";

  const CACHE_KEY = `spv2_staff_dashboard_last_good_${session.loginId || session.staffId || "staff"}`;
  const readCachedDashboard = () => {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); } catch (error) { return null; }
  };
  const writeCachedDashboard = (data) => {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (error) {}
  };

  let state = {};
  let refreshTimer;
  let refreshInFlight = false;
  let breakStartedAt = null;
  const BREAK_RULES = {
    BREAK: { label: "Break", limit: 1, minutes: 60 },
    BIO_BREAK: { label: "Bio Break", limit: 3, minutes: 11 },
    PRAYER_BREAK: { label: "Prayer Break", limit: 3, minutes: 15 }
  };

  const empty = (message) => `<tr><td colspan="8" class="empty-state">${message}</td></tr>`;
  const badge = (text, tone = "") => `<span class="badge ${tone}">${text || "--"}</span>`;
  const previewLimit = 5;
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
  const noScheduleMessage = "No schedule found for this day. Please contact admin.";
  const formatShiftTime12h = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return "--";
    const timePart = raw.includes("T") ? raw.split("T").pop() : raw;
    const match = timePart.match(/\b(\d{1,2})(?::(\d{1,2}))(?::\d{1,2})?\s*(AM|PM)?\b/i);
    if (!match) {
      const parsed = /GMT|T|:\d{2}/i.test(raw) ? new Date(raw) : null;
      if (parsed && !Number.isNaN(parsed.getTime())) {
        const hour = parsed.getHours();
        const suffix = hour >= 12 ? "PM" : "AM";
        return `${hour % 12 || 12}:${String(parsed.getMinutes()).padStart(2, "0")} ${suffix}`;
      }
      return raw;
    }
    let hour = Number(match[1]);
    const minute = Number(match[2] || 0);
    const meridiem = String(match[3] || "").toUpperCase();
    if (meridiem === "PM" && hour < 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;
    const suffix = hour >= 12 ? "PM" : "AM";
    const hour12 = hour % 12 || 12;
    return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
  };
  const nonWorkingMessage = (value) => `Today is your ${String(value || "OFF").toUpperCase()} day.`;
  const isNonWorkingSchedule = (schedule) => {
    const shift = String(Portal.pick(schedule, ["shift_code"], "")).toUpperCase();
    const status = String(Portal.pick(schedule, ["status"], "")).toUpperCase();
    return ["OFF", "AL", "UL", "SL", "HOLIDAY"].includes(shift) || ["OFF", "AL", "UL", "SL", "HOLIDAY"].includes(status);
  };
  const nonWorkingValue = (schedule) => {
    const shift = String(Portal.pick(schedule, ["shift_code"], "")).toUpperCase();
    const status = String(Portal.pick(schedule, ["status"], "")).toUpperCase();
    return ["OFF", "AL", "UL", "SL", "HOLIDAY"].includes(shift) ? shift : status || "OFF";
  };

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
    const hasSchedule = schedule && schedule.ok !== false && Boolean(Portal.pick(schedule, ["schedule_date", "shift_code", "status", "start_time", "end_time"], ""));
    const nonWorking = hasSchedule && isNonWorkingSchedule(schedule);
    const actionBlockMessage = !hasSchedule ? noScheduleMessage : nonWorking ? nonWorkingMessage(nonWorkingValue(schedule)) : "";
    const dailyAverage = averageScore(dailyScores, ["final_attendance_score", "attendanceScore", "score"]);
    const monthlyAttendanceScore = Portal.pick(root, ["monthly_attendance_score", "attendance_score"], dailyAverage === "--" ? 0 : dailyAverage);
    const kpiScore = Portal.pick(root, ["kpi_score"], Portal.pick(kpi, ["kpi_score_out_of_5", "kpiScore", "score"], 0));
    const kpiDisplay = kpiScore;
    const finalScore = numeric(monthlyAttendanceScore) !== null && numeric(kpiScore) !== null
      ? Number((numeric(monthlyAttendanceScore) * 0.4 + numeric(kpiScore) * 0.6).toFixed(2))
      : Portal.pick(root, ["final_score"], 0);
    return {
      staff,
      today: {
        ...attendance,
        status: attendance.hasCheckOut ? "Checked out" : attendance.hasCheckIn ? "Checked in" : "Not checked in",
        breakStatus: attendance.activeBreak ? attendance.activeBreak.replaceAll("_", " ") : "Not on break",
        ipAllowed: true,
        actionBlocked: Boolean(actionBlockMessage),
        actionBlockMessage
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
        kpiDisplay,
        quarterScore: Portal.pick(quarterScore, ["final_score", "quarter_score", "score"], Portal.pick(root, ["quarter_score_value", "quarter_score"], finalScore)),
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

  const hasOwn = (source, key) => source && Object.prototype.hasOwnProperty.call(source, key);
  const hasValidNumber = (value) => value !== undefined && value !== null && value !== "" && Number.isFinite(Number(value));
  const hasMeaningfulBackendValue = (root, key) => {
    if (!hasOwn(root, key)) return false;
    const value = root[key];
    if (value === undefined || value === null || value === "") return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
  };
  const rootHasAny = (root, keys) => keys.some((key) => hasMeaningfulBackendValue(root, key));
  const mergeStableDashboard = (previous, next, rawData) => {
    if (!previous || !Object.keys(previous).length) return next;
    const root = rawData?.data || rawData?.dashboard || rawData || {};
    const previousPerf = previous.performance || {};
    const nextPerf = next.performance || {};
    const mergedPerf = { ...nextPerf };

    [
      { key: "kpiScore", rootKeys: ["kpi_score", "own_kpi", "monthly_kpi", "performance_details"] },
      { key: "kpiDisplay", rootKeys: ["kpi_score", "own_kpi", "monthly_kpi", "performance_details"] },
      { key: "monthlyAttendanceScore", rootKeys: ["monthly_attendance_score", "attendance_score", "daily_scores", "performance_details"] },
      { key: "finalScore", rootKeys: ["final_score", "monthly_attendance_score", "attendance_score", "kpi_score", "own_kpi", "daily_scores", "performance_details"] },
      { key: "quarterScore", rootKeys: ["quarter_score", "quarter_score_value", "quarter_scores", "performance_details"] },
      { key: "rank", rootKeys: ["current_rank", "rank", "leaderboard", "performance_details"] }
    ].forEach((item) => {
      const nextValue = mergedPerf[item.key];
      const previousValue = previousPerf[item.key];
      const backendSuppliedField = rootHasAny(root, item.rootKeys);
      if ((!backendSuppliedField || !hasValidNumber(nextValue)) && hasValidNumber(previousValue)) {
        mergedPerf[item.key] = previousValue;
      }
    });

    if ((!next.leaderboard || !next.leaderboard.length) && previous.leaderboard?.length) next.leaderboard = previous.leaderboard;
    if ((!next.history || !next.history.length) && previous.history?.length) next.history = previous.history;
    if ((!next.timeline || !next.timeline.length) && previous.timeline?.length) next.timeline = previous.timeline;
    if ((!next.scheduleList || !next.scheduleList.length) && previous.scheduleList?.length) next.scheduleList = previous.scheduleList;
    return { ...next, performance: mergedPerf };
  };

  state = normalizeDashboard(readCachedDashboard() || {});

  const openLeaderboardModal = (rows, loginKey) => {
    let modal = document.getElementById("staffLeaderboardModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "staffLeaderboardModal";
      modal.className = "data-modal";
      modal.innerHTML = `
        <div class="data-modal__panel">
          <div class="data-modal__head">
            <h2>Team Leaderboard</h2>
            <button class="mini-btn" type="button" data-modal-close>Close</button>
          </div>
          <input id="staffLeaderboardSearch" class="search-input" placeholder="Search team scores">
          <div class="table-wrap data-modal__table">
            <table>
              <thead><tr><th>Name</th><th>Team</th><th>Attendance</th><th>KPI</th><th>Final</th><th>Rank</th></tr></thead>
              <tbody id="staffLeaderboardBody"></tbody>
            </table>
          </div>
        </div>`;
      document.body.appendChild(modal);
      modal.addEventListener("click", (event) => {
        if (event.target === modal || event.target.closest("[data-modal-close]")) modal.classList.remove("open");
      });
    }
    const render = () => {
      const query = document.getElementById("staffLeaderboardSearch")?.value.trim().toLowerCase() || "";
      const filtered = query ? rows.filter((row) => JSON.stringify(row).toLowerCase().includes(query)) : rows;
      document.getElementById("staffLeaderboardBody").innerHTML = filtered.length ? filtered.map((row, index) => {
        const rowLogin = String(Portal.pick(row, ["login_id", "email"], "")).toLowerCase();
        return `
          <tr class="${rowLogin && rowLogin === loginKey ? "is-current-user" : ""}">
            <td>${Portal.pick(row, ["name", "staffName", "full_name", "staff"], "Staff")}</td>
            <td>${Portal.pick(row, ["department", "team"], "--")}</td>
            <td>${Portal.pick(row, ["attendance_score", "monthly_attendance_score"], "0")}</td>
            <td>${Portal.pick(row, ["kpi_score_out_of_5", "kpi_score", "kpi", "kpiScore"], "0")}</td>
            <td>${Portal.pick(row, ["final_score", "score"], "0")}</td>
            <td>${Portal.pick(row, ["rank", "position"], index + 1)}</td>
          </tr>`;
      }).join("") : `<tr><td colspan="6" class="empty-state">No leaderboard rows match this search.</td></tr>`;
    };
    const search = document.getElementById("staffLeaderboardSearch");
    search.value = "";
    search.oninput = render;
    render();
    modal.classList.add("open");
    search.focus();
  };

  const ensureStaffViewButton = (hostId, label, disabled, onClick) => {
    const host = document.getElementById(hostId);
    const panelTitle = host?.closest(".glass-panel")?.querySelector(".panel-title");
    if (!panelTitle) return;
    let button = panelTitle.querySelector(`[data-staff-view-all="${hostId}"]`);
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "mini-btn";
      button.dataset.staffViewAll = hostId;
      button.textContent = label;
      panelTitle.appendChild(button);
    }
    button.disabled = Boolean(disabled);
    button.onclick = onClick;
  };

  const openStaffTableModal = (title, rows, columns) => {
    let modal = document.getElementById("staffDataModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "staffDataModal";
      modal.className = "data-modal";
      modal.innerHTML = `
        <div class="data-modal__panel">
          <div class="data-modal__head">
            <h2 id="staffDataModalTitle">Records</h2>
            <button class="mini-btn" type="button" data-modal-close>Close</button>
          </div>
          <input id="staffDataModalSearch" class="search-input" placeholder="Search records">
          <div class="table-wrap data-modal__table">
            <table>
              <thead id="staffDataModalHead"></thead>
              <tbody id="staffDataModalBody"></tbody>
            </table>
          </div>
        </div>`;
      document.body.appendChild(modal);
      modal.addEventListener("click", (event) => {
        if (event.target === modal || event.target.closest("[data-modal-close]")) modal.classList.remove("open");
      });
    }
    document.getElementById("staffDataModalTitle").textContent = title;
    document.getElementById("staffDataModalHead").innerHTML = `<tr>${columns.map((column) => `<th>${column.label}</th>`).join("")}</tr>`;
    const render = () => {
      const query = document.getElementById("staffDataModalSearch")?.value.trim().toLowerCase() || "";
      const filtered = query ? rows.filter((row) => JSON.stringify(row).toLowerCase().includes(query)) : rows;
      document.getElementById("staffDataModalBody").innerHTML = filtered.length ? filtered.map((row) => `
        <tr>${columns.map((column) => `<td>${column.render ? column.render(row) : Portal.pick(row, column.keys, "--")}</td>`).join("")}</tr>
      `).join("") : `<tr><td colspan="${columns.length}" class="empty-state">No records match this search.</td></tr>`;
    };
    const search = document.getElementById("staffDataModalSearch");
    search.value = "";
    search.oninput = render;
    render();
    modal.classList.add("open");
    search.focus();
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
    Portal.setText("shiftWindow", `${formatShiftTime12h(start)} - ${formatShiftTime12h(end)}`);
    document.getElementById("shiftProgress").style.width = `${shiftProgress(shift)}%`;
    Portal.setText("lateWarning", Portal.pick(today, ["actionBlockMessage"], "") || Portal.pick(today, ["lateWarning", "lateMessage"], Portal.pick(today, ["isLate"], false) ? "Late warning active" : "On-time status monitored"));

    const attendanceStatus = Portal.pick(today, ["status", "attendanceStatus", "state"], "Not checked in");
    const breakStatus = Portal.pick(today, ["breakStatus", "currentBreakStatus"], "Not on break");
    Portal.setText("attendanceStatus", attendanceStatus);
    Portal.setText("breakStatus", breakStatus);
    Portal.setText("monthlyScore", Portal.pick(performance, ["monthlyAttendanceScore", "monthly_attendance_score", "attendanceScore", "monthlyScore"], "0"));
    Portal.setText("kpiScore", Portal.pick(performance, ["kpiDisplay", "kpi_score_out_of_5", "kpi", "kpiScore", "score"], "0"));
    Portal.setText("quarterScore", Portal.pick(performance, ["quarterScore", "quarter_score", "final_score", "quarter"], "0"));
    Portal.setText("rankPosition", Portal.pick(performance, ["rank", "rankPosition", "position"], "--"));
    const finalScore = Portal.pick(performance, ["finalScore", "final_score"], "0");
    const attendanceScore = Portal.pick(performance, ["monthlyAttendanceScore", "monthly_attendance_score", "attendanceScore", "monthlyScore"], "0");
    const kpiScore = Portal.pick(performance, ["kpiDisplay", "kpi_score_out_of_5", "kpi", "kpiScore", "score"], "0");
    const quarterScore = Portal.pick(performance, ["quarterScore", "quarter_score", "final_score", "quarter"], finalScore);
    const rank = Portal.pick(performance, ["rank", "rankPosition", "position"], "--");
    Portal.setText("summaryAttendanceScore", scoreText(attendanceScore));
    Portal.setText("kpiScore", scoreText(kpiScore));
    Portal.setText("summaryFinalScore", scoreText(finalScore));
    Portal.setText("quarterScore", scoreText(quarterScore));
    Portal.setText("summaryRank", rank);
    Portal.setText("scoreUpdated", `Final score: ${finalScore}`);
    setScoreBar("summaryAttendanceBar", attendanceScore);
    setScoreBar("kpiScoreBar", kpiScore);
    setScoreBar("summaryFinalBar", finalScore);
    setScoreBar("quarterScoreBar", quarterScore);
    setScoreBar("rankScoreBar", rank === "--" ? 0 : 5);

    const loginKey = String(Portal.pick(staff, ["login_id", "email"], session.loginId || session.staffId || "")).toLowerCase();
    renderLeaderboard(leaderboard, loginKey);
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

  const scoreText = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? String(Number(number.toFixed(2))) : "0";
  };

  const setScoreBar = (id, value) => {
    const el = document.getElementById(id);
    if (!el) return;
    const number = Number(value);
    const percent = Number.isFinite(number) ? Portal.percent((number / 5) * 100) : 0;
    el.style.background = `linear-gradient(90deg, var(--cyan) 0%, var(--green) ${percent}%, rgba(255,255,255,.08) ${percent}%)`;
  };

  const renderLeaderboard = (rows, loginKey = "") => {
    const host = document.getElementById("leaderboardPreview");
    if (!host) return;
    if (!rows.length) {
      host.innerHTML = `<div class="empty-state">Leaderboard data will appear after the API returns ranking records.</div>`;
      return;
    }
    const panelTitle = host.closest(".glass-panel")?.querySelector(".panel-title");
    if (panelTitle && !panelTitle.querySelector("[data-view-team-leaderboard]")) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mini-btn";
      btn.dataset.viewTeamLeaderboard = "1";
      btn.textContent = "View All";
      panelTitle.appendChild(btn);
    }
    const viewAll = panelTitle?.querySelector("[data-view-team-leaderboard]");
    if (viewAll) viewAll.onclick = () => openLeaderboardModal(rows, loginKey);

    host.innerHTML = rows.slice(0, previewLimit).map((row, index) => {
      const rowLogin = String(Portal.pick(row, ["login_id", "email"], "")).toLowerCase();
      return `
      <div class="leader-row ${rowLogin && rowLogin === loginKey ? "is-current-user" : ""}">
        <span class="leader-rank">${Portal.pick(row, ["rank", "position"], index + 1)}</span>
        <div><strong>${Portal.pick(row, ["name", "staffName", "full_name", "staff"], "Staff")}</strong><br><small>${Portal.pick(row, ["department", "team"], "")}</small></div>
        <strong>${Portal.pick(row, ["final_score", "score", "kpi", "kpi_score_out_of_5", "quarterScore"], "0")}</strong>
      </div>`;
    }).join("");
  };

  const renderTimeline = (rows) => {
    const host = document.getElementById("activityTimeline");
    if (!host) return;
    ensureStaffViewButton("activityTimeline", "View All", !rows.length, () => openStaffTableModal("Activity Timeline", rows, [
      { label: "Time", render: (row) => Portal.formatTime(Portal.pick(row, ["event_time", "time", "created_at", "createdAt", "timestamp"], "")) },
      { label: "Action", keys: ["event_type", "action", "event", "title"] },
      { label: "Break / Detail", keys: ["break_type", "message", "note", "details", "ip"] },
      { label: "Status", render: (row) => badge(Portal.pick(row, ["status", "state"], "ok"), statusTone(Portal.pick(row, ["status", "state"], ""))) }
    ]));
    if (!rows.length) {
      host.innerHTML = `<div class="empty-state">No activity events received yet.</div>`;
      return;
    }
    host.innerHTML = rows.slice(0, previewLimit).map((row) => `
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
    const historyColumns = [
      { label: "Date", render: (row) => Portal.formatDate(Portal.pick(row, ["score_date", "event_date", "date", "day"], "")) },
      { label: "In", render: (row) => {
        const eventType = String(Portal.pick(row, ["event_type", "action", "event"], "")).toUpperCase();
        const eventTime = Portal.pick(row, ["event_time", "time", "created_at", "createdAt", "timestamp"], "");
        return Portal.formatTime(eventType && /CHECK_IN|BREAK_START/.test(eventType) ? eventTime : Portal.pick(row, ["checkIn", "in", "check_in", "firstCheckIn"], ""));
      } },
      { label: "Out", render: (row) => {
        const eventType = String(Portal.pick(row, ["event_type", "action", "event"], "")).toUpperCase();
        const eventTime = Portal.pick(row, ["event_time", "time", "created_at", "createdAt", "timestamp"], "");
        return Portal.formatTime(eventType && /CHECK_OUT|BREAK_END/.test(eventType) ? eventTime : Portal.pick(row, ["checkOut", "out", "check_out", "lastCheckOut"], ""));
      } },
      { label: "Status", render: (row) => {
        const eventType = String(Portal.pick(row, ["event_type", "action", "event"], "")).toUpperCase();
        const status = eventType ? eventType.replaceAll("_", " ") : Portal.pick(row, ["status", "state"], "--");
        return badge(status, statusTone(status));
      } },
      { label: "Break", render: (row) => {
        const eventType = String(Portal.pick(row, ["event_type", "action", "event"], "")).toUpperCase();
        return eventType ? Portal.pick(row, ["break_type", "shift_code", "ip"], "--") : Portal.pick(row, ["breakDuration", "break", "breakTotal", "penalty", "final_attendance_score"], "--");
      } }
    ];
    ensureStaffViewButton("attendanceHistory", "View All", !rows.length, () => openStaffTableModal("Attendance History", rows, historyColumns));
    if (!rows.length) {
      host.innerHTML = empty("Attendance history is empty.");
      return;
    }
    host.innerHTML = rows.slice(0, previewLimit).map((row) => {
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
        <td>${formatShiftTime12h(Portal.pick(row, ["start_time", "start"], ""))}</td>
        <td>${formatShiftTime12h(Portal.pick(row, ["end_time", "end"], ""))}</td>
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
    const blocked = Boolean(today.actionBlocked);
    const blockMessage = Portal.pick(today, ["actionBlockMessage"], noScheduleMessage);
    const checkedIn = today.hasCheckIn === true;
    const checkedOut = today.hasCheckOut === true;
    const activeBreak = Portal.pick(today, ["activeBreak"], "");
    const onBreak = Boolean(activeBreak);
    const selectedBreak = document.getElementById("breakTypeSelect")?.value || "BREAK";
    const counts = today.counts || {};
    const selectedCount = Number(counts[selectedBreak] || 0);
    const selectedRule = BREAK_RULES[selectedBreak] || BREAK_RULES.BREAK;
    const selectedLimitReached = selectedCount >= selectedRule.limit;
    Portal.setText("checkInState", blocked ? blockMessage : checkedIn ? "Completed" : "Ready");
    Portal.setText("checkOutState", blocked ? "Blocked" : checkedOut ? "Completed" : checkedIn ? "Ready" : "Pending");
    Portal.setText("breakStartState", blocked ? "Blocked" : onBreak ? "Running" : selectedLimitReached ? "Limit reached" : checkedIn ? "Available" : "Check in first");
    Portal.setText("breakEndState", blocked ? "Blocked" : onBreak ? "Ready" : "Inactive");
    Portal.setText("breakLimitHint", `${selectedRule.label}: ${selectedCount}/${selectedRule.limit} used, ${selectedRule.minutes} min limit`);
    breakStartedAt = Portal.pick(today, ["breakStartedAt", "breakStart", "currentBreakStart"], breakStartedAt);
    document.querySelector('[data-action="checkIn"]').disabled = blocked || checkedIn;
    document.querySelector('[data-action="checkOut"]').disabled = blocked || !checkedIn || checkedOut;
    document.querySelector('[data-action="breakStart"]').disabled = blocked || !checkedIn || onBreak || checkedOut || selectedLimitReached;
    document.querySelector('[data-action="breakEnd"]').disabled = blocked || !onBreak;
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
    if (refreshInFlight) return;
    refreshInFlight = true;
    if (!silent) Portal.setStatus(false, "Loading");
    try {
      const month = document.getElementById("scheduleMonth")?.value || new Date().toISOString().slice(0, 7);
      const data = await Portal.api.dashboard("staff", { month });
      state = mergeStableDashboard(state, normalizeDashboard(data), data);
      writeCachedDashboard(data);
      renderProfile(state);
    } catch (error) {
      Portal.setStatus(false, "API issue");
      if (!Portal.isAbortLike(error) && !/invalid action/i.test(String(error.message))) Portal.toast(error.message || "Unable to load staff dashboard", "error");
      if (!Object.keys(state || {}).length) {
        state = normalizeDashboard(readCachedDashboard() || {});
        renderProfile(state);
      }
    } finally {
      refreshInFlight = false;
    }
  };

  const bindActions = () => {
    document.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        const action = button.dataset.action;
        if (state.today?.actionBlocked) {
          Portal.toast(state.today.actionBlockMessage || noScheduleMessage, "error");
          return;
        }
        const eventMap = {
          checkIn: { event_type: "CHECK_IN" },
          checkOut: { event_type: "CHECK_OUT" },
          breakStart: { event_type: "BREAK_START", break_type: document.getElementById("breakTypeSelect")?.value || "BREAK" },
          breakEnd: { event_type: "BREAK_END", break_type: state.today?.activeBreak || "BREAK" }
        };
        button.disabled = true;
        try {
          const ip = await Portal.api.detectIp();
          const result = await Portal.api.action("attendance_action", {
            login_id: session.loginId || session.staffId,
            ip,
            user_agent: navigator.userAgent,
            ...(eventMap[action] || {})
          });
          if (result?.ok === false) throw new Error(result.message || "Action failed");
          Portal.toast(`${button.firstChild.textContent.trim()} recorded`);
          await load(true);
        } catch (error) {
          if (!Portal.isAbortLike(error)) Portal.toast(error.message || "Action failed", "error");
        } finally {
          button.disabled = false;
        }
      });
    });
  };

  const applyDisplayOnlyLabels = () => {
    const bioBreakOption = document.querySelector('#breakTypeSelect option[value="BIO_BREAK"]');
    if (bioBreakOption) bioBreakOption.textContent = "Bio Break - 10 min, 3 times";
  };

  applyDisplayOnlyLabels();
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
