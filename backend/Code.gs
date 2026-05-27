/***** STAFF PERFORMANCE PORTAL V2 - SINGLE FILE BACKEND *****/

const TZ = "Asia/Colombo";

const SHEETS = {
  SETTINGS: "01_Settings",
  STAFF: "02_Staff_Master",
  SHIFT: "03_Shift_Rules",
  SCHEDULE: "04_Schedule_Master",
  EVENTS: "05_Attendance_Events",
  DAILY: "06_Daily_Attendance_Score",
  KPI: "07_Monthly_KPI",
  QUARTER: "08_Quarterly_Final_Score",
  ADMIN: "09_Admin_Users",
  IP: "10_IP_Allowlist",
  AUDIT: "11_Audit_Log",
  TG: "12_Telegram_Log"
};

const CACHE_SECONDS = 30;
const TG_QUEUE_PROPERTY = "TG_ATTENDANCE_QUEUE_V2";
const TG_TRIGGER_HANDLER = "processTelegramQueue";

let REQUEST_CACHE = { values: {}, settings: null };

function doGet(e) {
  return jsonOut({ ok: true, app: "Staff Performance Portal V2 API", time: nowDateTime() });
}

function doPost(e) {
  resetRequestCache();

  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const action = clean(body.action);

    if (!action) return jsonOut({ ok: false, message: "Missing action" });

    let result;

    switch (action) {
      case "staff_login":
        result = staffLogin(body);
        break;
      case "admin_login":
        result = adminLogin(body);
        break;
      case "get_staff_dashboard":
        result = getStaffDashboard(body);
        break;
      case "attendance_action":
        result = attendanceAction(body);
        break;
      case "get_admin_dashboard":
      case "get_admin_dashboard_full":
        result = getAdminDashboardFull(body);
        break;
      case "get_staff_list":
        result = getStaffList(body);
        break;
      case "get_schedule_list":
        result = getScheduleList(body);
        break;
      case "upload_schedule_csv":
        result = uploadScheduleCsv(body);
        break;
      case "get_attendance_logs":
        result = getAttendanceLogs(body);
        break;
      case "get_audit_logs":
        result = getAuditLogs(body);
        break;
      case "get_telegram_logs":
        result = getTelegramLogs(body);
        break;
      case "get_ip_allowlist":
        result = getIpAllowlist(body);
        break;
      case "save_ip_allowlist":
        result = saveIpAllowlist(body);
        break;
      case "get_kpi_list":
        result = getKpiList(body);
        break;
      case "get_quarter_scores":
        result = getQuarterScores(body);
        break;
      case "get_daily_scores":
        result = getDailyScores(body);
        break;
      case "save_monthly_kpi":
        result = saveMonthlyKPI(body);
        break;
      case "calculate_daily_score":
        result = calculateDailyScore(body);
        break;
      case "calculate_quarter_score":
        result = calculateQuarterScore(body);
        break;
      default:
        result = { ok: false, message: "Invalid action: " + action };
    }

    return jsonOut(result);
  } catch (err) {
    logInternalError("doPost", err);
    return jsonOut({ ok: false, message: "Server error. Please try again." });
  }
}

/***** BASIC HELPERS *****/

function resetRequestCache() {
  REQUEST_CACHE = { values: {}, settings: null };
}

function ss() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function sh(name) {
  const sheet = ss().getSheetByName(name);
  if (!sheet) throw new Error("Missing sheet: " + name);
  return sheet;
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function nowDateTime() {
  return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss");
}

function todayDate() {
  return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
}

function nowTime() {
  return Utilities.formatDate(new Date(), TZ, "HH:mm:ss");
}

function monthNow() {
  return Utilities.formatDate(new Date(), TZ, "yyyy-MM");
}

function makeId(prefix) {
  return prefix + "-" + new Date().getTime() + "-" + Math.floor(Math.random() * 1000);
}

function getValues(sheetName) {
  return getCachedValues(sheetName);
}

function getCachedValues(sheetName) {
  if (REQUEST_CACHE.values[sheetName]) return REQUEST_CACHE.values[sheetName];

  const cache = CacheService.getScriptCache();
  const cacheKey = "SHEET_VALUES_V2_" + sheetName;
  const cached = cache.get(cacheKey);

  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      REQUEST_CACHE.values[sheetName] = parsed;
      return parsed;
    } catch (err) {
      logInternalError("getCachedValues.parse." + sheetName, err);
    }
  }

  const values = sh(sheetName).getDataRange().getValues();
  REQUEST_CACHE.values[sheetName] = values;

  try {
    cache.put(cacheKey, JSON.stringify(values), CACHE_SECONDS);
  } catch (err) {
    logInternalError("getCachedValues.cache." + sheetName, err);
  }

  return values;
}

function clearSheetCache(sheetName) {
  if (sheetName) {
    delete REQUEST_CACHE.values[sheetName];
    CacheService.getScriptCache().remove("SHEET_VALUES_V2_" + sheetName);
    if (sheetName === SHEETS.SETTINGS) REQUEST_CACHE.settings = null;
    return;
  }

  resetRequestCache();
  const keys = Object.keys(SHEETS).map(function (k) {
    return "SHEET_VALUES_V2_" + SHEETS[k];
  });
  CacheService.getScriptCache().removeAll(keys);
}

function getSettings() {
  if (REQUEST_CACHE.settings) return REQUEST_CACHE.settings;

  const values = getValues(SHEETS.SETTINGS);
  const obj = {};
  for (let i = 1; i < values.length; i++) obj[clean(values[i][0])] = values[i][1];
  REQUEST_CACHE.settings = obj;
  return obj;
}

function appendAudit(actorType, actorId, actorName, action, module, targetId, oldValue, newValue, ip, notes) {
  sh(SHEETS.AUDIT).appendRow([
    makeId("AUD"),
    nowDateTime(),
    actorType || "",
    actorId || "",
    actorName || "",
    action || "",
    module || "",
    targetId || "",
    oldValue || "",
    newValue || "",
    ip || "",
    notes || ""
  ]);
  clearSheetCache(SHEETS.AUDIT);
}

function clean(v) {
  return String(v == null ? "" : v).trim();
}

function safeUpper(v) {
  return clean(v).toUpperCase();
}

function safeNumber(v, fallback) {
  const n = Number(v);
  return isNaN(n) ? Number(fallback || 0) : n;
}

function normalizeDateKey(v) {
  if (Object.prototype.toString.call(v) === "[object Date]") return Utilities.formatDate(v, TZ, "yyyy-MM-dd");
  const s = clean(v);
  if (!s) return "";
  if (s.indexOf("GMT") > -1 || s.indexOf("T") > -1) {
    try {
      return Utilities.formatDate(new Date(s), TZ, "yyyy-MM-dd");
    } catch (err) {
      logInternalError("normalizeDateKey", err);
    }
  }
  return s.substring(0, 10);
}

function normalizeSheetTime(v) {
  if (Object.prototype.toString.call(v) === "[object Date]") return Utilities.formatDate(v, TZ, "HH:mm:ss");
  const s = clean(v);
  if (!s) return "";
  if (s.indexOf("T") > -1 || s.indexOf("GMT") > -1) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return Utilities.formatDate(d, TZ, "HH:mm:ss");
  }
  const ampm = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (ampm) {
    let h = Number(ampm[1]);
    const m = Number(ampm[2]);
    const sec = Number(ampm[3] || 0);
    const meridiem = ampm[4].toUpperCase();
    if (meridiem === "PM" && h < 12) h += 12;
    if (meridiem === "AM" && h === 12) h = 0;
    return pad2(h) + ":" + pad2(m) + ":" + pad2(sec);
  }
  const parts = s.split(":");
  if (parts.length >= 2) return pad2(Number(parts[0] || 0)) + ":" + pad2(Number(parts[1] || 0)) + ":" + pad2(Number(parts[2] || 0));
  return s;
}

function formatShiftTime(v) {
  const normalized = normalizeSheetTime(v);
  if (!normalized) return "";
  const parts = normalized.split(":");
  let hour = Number(parts[0] || 0);
  const minute = Number(parts[1] || 0);
  const ampm = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return hour + ":" + pad2(minute) + " " + ampm;
}

function parseTimeToMinutesSafe(t) {
  const normalized = normalizeSheetTime(t);
  if (!normalized) return 0;
  const parts = normalized.split(":");
  return safeNumber(parts[0], 0) * 60 + safeNumber(parts[1], 0);
}

function pad2(n) {
  n = safeNumber(n, 0);
  return n < 10 ? "0" + n : String(n);
}

function logInternalError(context, err) {
  try {
    Logger.log(context + ": " + String(err && err.stack ? err.stack : err));
  } catch (e) {}
}

function requireAllowedIp(ip) {
  if (!isAllowedIP(ip)) return { ok: false, message: "IP not allowed", ip: clean(ip) };
  return null;
}

/***** IP SECURITY *****/

function isAllowedIP(ip) {
  const settings = getSettings();
  if (safeUpper(settings.IP_SECURITY_ENABLED || "YES") !== "YES") return true;

  ip = clean(ip);
  if (!ip) return false;

  const values = getValues(SHEETS.IP);
  for (let i = 1; i < values.length; i++) {
    const rowIp = clean(values[i][1]);
    const status = safeUpper(values[i][3]);
    if (rowIp === ip && status === "ACTIVE") return true;
  }
  return false;
}

/***** AUTH *****/

function staffLogin(data) {
  const loginId = clean(data.login_id);
  const ip = clean(data.ip);
  if (!loginId) return { ok: false, message: "Missing login ID" };
  const ipError = requireAllowedIp(ip);
  if (ipError) return ipError;

  const staff = getStaffByLogin(loginId);
  if (!staff.ok) return staff;

  appendAudit("STAFF", staff.staff_id, staff.full_name, "LOGIN", "STAFF_AUTH", staff.staff_id, "", "", ip, "");
  return { ok: true, message: "Login success", staff: staff };
}

function adminLogin(data) {
  const loginId = clean(data.login_id);
  const password = clean(data.password);
  const ip = clean(data.ip);
  if (!loginId || !password) return { ok: false, message: "Missing admin login or password" };
  const ipError = requireAllowedIp(ip);
  if (ipError) return ipError;

  const values = getValues(SHEETS.ADMIN);
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (clean(row[2]) === loginId && clean(row[3]) === password && safeUpper(row[4]) === "ACTIVE") {
      appendAudit("ADMIN", row[0], row[1], "LOGIN", "ADMIN_AUTH", row[0], "", "", ip, "");
      return {
        ok: true,
        message: "Admin login success",
        admin: {
          admin_id: row[0],
          admin_name: row[1],
          login_id: row[2],
          role: row[5],
          email: row[6]
        }
      };
    }
  }
  return { ok: false, message: "Invalid admin login" };
}

function getStaffByLogin(loginId) {
  const values = getValues(SHEETS.STAFF);
  const target = clean(loginId).toLowerCase();
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (clean(row[2]).toLowerCase() === target || clean(row[3]).toLowerCase() === target) {
      if (safeUpper(row[6]) !== "ACTIVE") return { ok: false, message: "Staff inactive" };
      return {
        ok: true,
        staff_id: row[0],
        full_name: row[1],
        login_id: row[2],
        email: row[3],
        team: row[4],
        role: row[5],
        status: row[6],
        manager: row[8],
        phone: row[9],
        telegram_user_id: row[10]
      };
    }
  }
  return { ok: false, message: "Staff not found" };
}

/***** SCHEDULE *****/

function getScheduleForDate(loginId, dateStr) {
  const values = getValues(SHEETS.SCHEDULE);
  const key = normalizeDateKey(dateStr);
  const target = clean(loginId).toLowerCase();

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (normalizeDateKey(row[2]) === key && clean(row[4]).toLowerCase() === target) {
      return mapScheduleRow(row);
    }
  }
  return { ok: false, message: "No schedule found" };
}

function getMonthlySchedule(loginId, month) {
  const values = getValues(SHEETS.SCHEDULE);
  const target = clean(loginId).toLowerCase();
  const list = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (clean(row[1]) === clean(month) && clean(row[4]).toLowerCase() === target) {
      const mapped = mapScheduleRow(row);
      list.push({
        date: mapped.schedule_date,
        schedule_date: mapped.schedule_date,
        shift_code: mapped.shift_code,
        start_time: mapped.start_time,
        end_time: mapped.end_time,
        status: mapped.status
      });
    }
  }
  return list;
}

function getShiftRule(shiftCode) {
  const values = getValues(SHEETS.SHIFT);
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (clean(row[0]) === clean(shiftCode)) {
      return {
        ok: true,
        shift_code: row[0],
        start_time: row[1],
        end_time: row[2],
        grace_minutes: safeNumber(row[3], 5),
        late_after_minutes: safeNumber(row[4], 5),
        break_limit_min: safeNumber(row[5], 60),
        prayer_break_limit_min: safeNumber(row[6], 15),
        bio_break_limit_min: safeNumber(row[7], 11),
        break_count_limit: safeNumber(row[8], 1),
        prayer_break_count_limit: safeNumber(row[9], 3),
        bio_break_count_limit: safeNumber(row[10], 3),
        active: row[11],
        notes: row[12]
      };
    }
  }
  return { ok: false, message: "Shift rule not found" };
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return Utilities.formatDate(d, TZ, "yyyy-MM-dd");
}

/***** ATTENDANCE *****/

function attendanceAction(data) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
  } catch (err) {
    logInternalError("attendanceAction.lock", err);
    return { ok: false, message: "Attendance system is busy. Please try again." };
  }

  try {
    return attendanceActionLocked(data);
  } catch (err) {
    logInternalError("attendanceAction", err);
    return { ok: false, message: "Attendance action failed. Please try again." };
  } finally {
    try {
      lock.releaseLock();
    } catch (err) {
      logInternalError("attendanceAction.releaseLock", err);
    }
  }
}

function attendanceActionLocked(data) {
  clearSheetCache(SHEETS.EVENTS);

  const loginId = clean(data.login_id);
  const eventType = safeUpper(data.event_type);
  const breakType = safeUpper(data.break_type);
  const ip = clean(data.ip);
  const userAgent = clean(data.user_agent);

  if (!loginId) return { ok: false, message: "Missing login ID" };
  if (!eventType) return { ok: false, message: "Missing event type" };
  const ipError = requireAllowedIp(ip);
  if (ipError) return ipError;

  const allowedEvents = ["CHECK_IN", "CHECK_OUT", "BREAK_START", "BREAK_END"];
  if (allowedEvents.indexOf(eventType) === -1) return { ok: false, message: "Invalid event type" };
  if ((eventType === "BREAK_START" || eventType === "BREAK_END") && !breakType) return { ok: false, message: "Missing break type" };

  const staff = getStaffByLogin(loginId);
  if (!staff.ok) return staff;

  const today = clean(data.date || normalizeDateKey(new Date()));
  const schedule = getScheduleForDate(staff.login_id, today);
  if (!schedule.ok) return { ok: false, message: "No schedule found for today" };

  const shiftCode = safeUpper(schedule.shift_code);
  const scheduleStatus = safeUpper(schedule.status);
  if (scheduleStatus !== "WORKING") return { ok: false, message: "Today is not a working day: " + scheduleStatus };
  if (["OFF", "AL", "UL", "HOLIDAY"].indexOf(shiftCode) !== -1) return { ok: false, message: "Today shift is " + shiftCode };

  const state = getAttendanceState(staff.login_id, today);
  if (eventType === "CHECK_IN" && state.hasCheckIn) return { ok: false, message: "Already checked in today" };
  if (eventType === "CHECK_OUT") {
    if (!state.hasCheckIn) return { ok: false, message: "Check-in required first" };
    if (state.hasCheckOut) return { ok: false, message: "Already checked out today" };
    if (state.activeBreak) return { ok: false, message: "End current break before checkout" };
  }
  if (eventType === "BREAK_START") {
    if (!state.hasCheckIn) return { ok: false, message: "Check-in required before break" };
    if (state.hasCheckOut) return { ok: false, message: "Already checked out" };
    if (state.activeBreak) return { ok: false, message: "End current break before starting another" };
    if (breakType === "BREAK" && state.counts.BREAK >= 1) return { ok: false, message: "Normal break already used" };
    if (breakType === "PRAYER_BREAK" && state.counts.PRAYER_BREAK >= 3) return { ok: false, message: "Prayer break limit reached" };
    if (breakType === "BIO_BREAK" && state.counts.BIO_BREAK >= 3) return { ok: false, message: "Bio break limit reached" };
  }
  if (eventType === "BREAK_END") {
    if (!state.hasCheckIn) return { ok: false, message: "Check-in required first" };
    if (!state.activeBreak) return { ok: false, message: "No active break found" };
    if (state.activeBreak !== breakType) return { ok: false, message: "You must end current break: " + state.activeBreak };
  }

  const eventId = makeId("EVT");
  sh(SHEETS.EVENTS).appendRow([
    eventId,
    today,
    nowTime(),
    staff.staff_id,
    staff.login_id,
    staff.full_name,
    eventType,
    breakType,
    schedule.shift_code,
    ip,
    userAgent,
    "PORTAL",
    nowDateTime(),
    ""
  ]);

  clearSheetCache(SHEETS.EVENTS);
  appendAudit("STAFF", staff.staff_id, staff.full_name, eventType, "ATTENDANCE", eventId, "", "", ip, "");
  queueTelegramAttendance(staff, schedule, eventType, breakType, ip);

  return {
    ok: true,
    message: eventType + " saved successfully",
    event_id: eventId,
    staff: staff,
    schedule: schedule,
    state: getAttendanceState(staff.login_id, today)
  };
}

function getAttendanceState(loginId, dateStr) {
  const values = getValues(SHEETS.EVENTS);
  const targetDate = normalizeDateKey(dateStr);
  const targetLogin = clean(loginId).toLowerCase();

  let hasCheckIn = false;
  let hasCheckOut = false;
  let activeBreak = "";
  let counts = { BREAK: 0, PRAYER_BREAK: 0, BIO_BREAK: 0 };
  let firstCheckIn = "";
  let lastCheckOut = "";

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (normalizeDateKey(row[1]) !== targetDate) continue;
    if (clean(row[4]).toLowerCase() !== targetLogin) continue;

    const eventType = safeUpper(row[6]);
    const breakType = safeUpper(row[7]);
    const eventTime = normalizeSheetTime(row[2]) || clean(row[2]);

    if (eventType === "CHECK_IN") {
      hasCheckIn = true;
      if (!firstCheckIn) firstCheckIn = eventTime;
    }
    if (eventType === "CHECK_OUT") {
      hasCheckOut = true;
      lastCheckOut = eventTime;
    }
    if (eventType === "BREAK_START") {
      activeBreak = breakType;
      if (counts[breakType] != null) counts[breakType]++;
    }
    if (eventType === "BREAK_END" && activeBreak === breakType) activeBreak = "";
  }

  return { hasCheckIn, hasCheckOut, activeBreak, counts, firstCheckIn, lastCheckOut };
}

/***** STAFF DASHBOARD *****/

function getStaffDashboard(data) {
  const loginId = clean(data.login_id);
  const ip = clean(data.ip);
  const ipError = requireAllowedIp(ip);
  if (ipError) return ipError;

  const staff = getStaffByLogin(loginId);
  if (!staff.ok) return staff;

  const today = todayDate();
  const month = clean(data.month) || monthNow();
  const leaderboard = getLeaderboard(month);
  const ownKpi = getOwnKPI(staff.login_id, month);
  const attendanceEvents = listAttendanceRows("", 300).filter(function (row) {
    return clean(row.login_id).toLowerCase() === clean(staff.login_id).toLowerCase();
  });
  const dailyScores = listDailyScoreRows(month, 300).filter(function (row) {
    return clean(row.login_id).toLowerCase() === clean(staff.login_id).toLowerCase();
  });
  const quarterScores = listQuarterScoreRows(300).filter(function (row) {
    return clean(row.login_id).toLowerCase() === clean(staff.login_id).toLowerCase();
  });
  const ownRank = leaderboard.filter(function (row) {
    return clean(row.login_id).toLowerCase() === clean(staff.login_id).toLowerCase();
  })[0];

  return {
    ok: true,
    staff: staff,
    today: today,
    today_schedule: getScheduleForDate(staff.login_id, today),
    tomorrow_schedule: getScheduleForDate(staff.login_id, addDays(today, 1)),
    attendance_state: getAttendanceState(staff.login_id, today),
    monthly_schedule: getMonthlySchedule(staff.login_id, month),
    next_7_schedule: getNextSchedule(staff.login_id, today, 7),
    attendance_events: attendanceEvents,
    daily_scores: dailyScores,
    quarter_scores: quarterScores,
    quarter_score: quarterScores[0] || null,
    rank: ownRank ? ownRank.rank : "",
    monthly_attendance_score: averageRows(dailyScores, "final_attendance_score"),
    leaderboard: leaderboard,
    own_kpi: ownKpi
  };
}

function getNextSchedule(loginId, fromDate, days) {
  const target = clean(loginId).toLowerCase();
  const from = normalizeDateKey(fromDate);
  const rows = listScheduleRows("", "").filter(function (row) {
    return clean(row.login_id).toLowerCase() === target && normalizeDateKey(row.schedule_date) >= from;
  });
  rows.sort(function (a, b) {
    return normalizeDateKey(a.schedule_date).localeCompare(normalizeDateKey(b.schedule_date));
  });
  return rows.slice(0, safeNumber(days, 7));
}

function averageRows(rows, key) {
  let total = 0;
  let count = 0;
  rows.forEach(function (row) {
    const n = Number(row[key]);
    if (!isNaN(n)) {
      total += n;
      count++;
    }
  });
  return count ? Number((total / count).toFixed(2)) : "";
}

/***** ADMIN DASHBOARD + LIST ACTIONS *****/

function getAdminDashboardFull(data) {
  const ip = clean(data.ip);
  const ipError = requireAllowedIp(ip);
  if (ipError) return ipError;

  const month = clean(data.month) || monthNow();
  const today = todayDate();
  const staffList = listStaffRows();
  const scheduleList = listScheduleRows(month, clean(data.date));
  const attendanceEvents = listAttendanceRows(clean(data.date) || today, safeNumber(data.limit, 250));
  const dailyScores = listDailyScoreRows(month, safeNumber(data.limit, 250));
  const kpiList = listKpiRows(month);
  const quarterScores = listQuarterScoreRows(safeNumber(data.limit, 250));
  const auditLogs = listAuditRows(safeNumber(data.limit, 100));
  const telegramLogs = listTelegramRows(safeNumber(data.limit, 100));
  const ipAllowlist = listIpRows();
  const summary = getTodaySummary(today);
  const leaderboard = getLeaderboard(month);

  summary.total_staff = staffList.filter(function (row) { return safeUpper(row.status) === "ACTIVE"; }).length;
  summary.online_staff = summary.currently_working;
  summary.missing_checkout = Math.max(Number(summary.checked_in || 0) - Number(summary.checked_out || 0), 0);

  return {
    ok: true,
    today: today,
    summary: summary,
    today_summary: summary,
    staff_count: summary.total_staff,
    staff_list: staffList,
    schedule_list: scheduleList,
    attendance_events: attendanceEvents,
    daily_scores: dailyScores,
    kpi_list: kpiList,
    quarter_scores: quarterScores,
    audit_logs: auditLogs,
    telegram_logs: telegramLogs,
    ip_allowlist: ipAllowlist,
    leaderboard: leaderboard,
    topPerformers: leaderboard.slice(0, 10),
    worstPerformers: leaderboard.slice().reverse().slice(0, 10)
  };
}

function getStaffList(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  return { ok: true, staff_list: listStaffRows() };
}

function getScheduleList(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  return { ok: true, schedule_list: listScheduleRows(clean(data.month), clean(data.date)) };
}

function getAttendanceLogs(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  return { ok: true, attendance_events: listAttendanceRows(clean(data.date), safeNumber(data.limit, 250)) };
}

function getAuditLogs(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  return { ok: true, audit_logs: listAuditRows(safeNumber(data.limit, 100)) };
}

function getTelegramLogs(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  return { ok: true, telegram_logs: listTelegramRows(safeNumber(data.limit, 100)) };
}

function getIpAllowlist(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  return { ok: true, ip_allowlist: listIpRows() };
}

function getKpiList(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  return { ok: true, kpi_list: listKpiRows(clean(data.month)) };
}

function getQuarterScores(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  return { ok: true, quarter_scores: listQuarterScoreRows(safeNumber(data.limit, 250)) };
}

function getDailyScores(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  return { ok: true, daily_scores: listDailyScoreRows(clean(data.month), safeNumber(data.limit, 250)) };
}

function uploadScheduleCsv(data) {
  const ip = clean(data.ip);
  const ipError = requireAllowedIp(ip);
  if (ipError) return ipError;

  const adminLoginId = clean(data.admin_login_id || data.login_id || "Admin");
  const rows = Array.isArray(data.rows) ? data.rows : [];
  if (!rows.length) return { ok: false, message: "No schedule rows found in CSV", inserted: 0, updated: 0, failed: 0 };

  const staffByLogin = {};
  const staffByName = {};
  const staffRows = listStaffRows();
  staffRows.forEach(function (staff) {
    staffByLogin[clean(staff.login_id).toLowerCase()] = staff;
    staffByLogin[clean(staff.email).toLowerCase()] = staff;
    staffByName[clean(staff.full_name).toLowerCase()] = staff;
  });

  const sheet = sh(SHEETS.SCHEDULE);
  const existing = sheet.getDataRange().getValues();
  const existingMap = {};
  for (let i = 1; i < existing.length; i++) {
    existingMap[normalizeDateKey(existing[i][2]) + "|" + clean(existing[i][4]).toLowerCase()] = i + 1;
  }

  let inserted = 0;
  let updated = 0;
  let failed = 0;
  const errors = [];

  rows.forEach(function (raw, index) {
    const row = normalizeScheduleImportRow(raw);
    if (!row.schedule_date) {
      failed++;
      errors.push({ row: index + 2, message: "Missing schedule_date" });
      return;
    }

    const staff = staffByLogin[clean(row.login_id).toLowerCase()] || staffByName[clean(row.full_name).toLowerCase()];
    if (!staff || !staff.login_id) {
      failed++;
      errors.push({ row: index + 2, message: "Staff not found: " + (row.full_name || row.login_id || "blank") });
      return;
    }

    const scheduleDate = normalizeDateKey(row.schedule_date);
    if (!scheduleDate) {
      failed++;
      errors.push({ row: index + 2, message: "Invalid schedule_date" });
      return;
    }

    const status = safeUpper(row.status || "WORKING");
    const isWorking = status === "WORKING";
    const scheduleMonth = clean(row.schedule_month) || scheduleDate.substring(0, 7);
    const record = [
      clean(row.schedule_id) || makeId("SCH"),
      scheduleMonth,
      scheduleDate,
      clean(row.staff_id) || clean(staff.staff_id),
      clean(staff.login_id),
      clean(row.full_name) || clean(staff.full_name),
      clean(row.team) || clean(staff.team),
      safeUpper(row.shift_code || "GENERAL"),
      isWorking ? normalizeSheetTime(row.start_time || "09:00:00") : "",
      isWorking ? normalizeSheetTime(row.end_time || "18:00:00") : "",
      status,
      adminLoginId,
      nowDateTime(),
      clean(row.notes)
    ];

    const key = record[2] + "|" + clean(record[4]).toLowerCase();
    if (existingMap[key]) {
      sheet.getRange(existingMap[key], 1, 1, record.length).setValues([record]);
      updated++;
    } else {
      sheet.appendRow(record);
      inserted++;
    }
  });

  clearSheetCache(SHEETS.SCHEDULE);
  appendAudit("ADMIN", adminLoginId, adminLoginId, "UPLOAD_SCHEDULE_CSV", "SCHEDULE", "", "", JSON.stringify({ inserted, updated, failed }), ip, clean(data.fileName));
  return { ok: true, message: "Schedule CSV processed", inserted: inserted, updated: updated, failed: failed, errors: errors };
}

function saveIpAllowlist(data) {
  const ip = clean(data.ip);
  const ipError = requireAllowedIp(ip);
  if (ipError) return ipError;

  const adminLoginId = clean(data.admin_login_id || data.login_id || "Admin");
  const ips = Array.isArray(data.ips) ? data.ips.map(clean).filter(Boolean) : [];
  if (!ips.length) return { ok: false, message: "No IP addresses provided" };

  const sheet = sh(SHEETS.IP);
  const existing = sheet.getDataRange().getValues();
  const existingMap = {};
  for (let i = 1; i < existing.length; i++) existingMap[clean(existing[i][1])] = i + 1;

  ips.forEach(function (allowedIp) {
    const row = [makeId("IP"), allowedIp, "Admin added", "ACTIVE", adminLoginId, nowDateTime(), ""];
    if (existingMap[allowedIp]) sheet.getRange(existingMap[allowedIp], 1, 1, row.length).setValues([row]);
    else sheet.appendRow(row);
  });

  clearSheetCache(SHEETS.IP);
  appendAudit("ADMIN", adminLoginId, adminLoginId, "SAVE_IP_ALLOWLIST", "SECURITY", "", "", ips.join(","), ip, "");
  return { ok: true, message: "IP allowlist saved", count: ips.length, ip_allowlist: listIpRows() };
}

function getActiveStaffCount() {
  return listStaffRows().filter(function (row) { return safeUpper(row.status) === "ACTIVE"; }).length;
}

function getTodaySummary(dateStr) {
  const schedule = getValues(SHEETS.SCHEDULE);
  const events = getValues(SHEETS.EVENTS);
  const targetDate = normalizeDateKey(dateStr);

  let working = 0;
  let checkedIn = {};
  let checkedOut = {};
  let activeBreak = {};
  let firstIn = {};

  for (let i = 1; i < schedule.length; i++) {
    if (normalizeDateKey(schedule[i][2]) === targetDate && safeUpper(schedule[i][10]) === "WORKING") working++;
  }

  for (let i = 1; i < events.length; i++) {
    if (normalizeDateKey(events[i][1]) !== targetDate) continue;
    const loginId = clean(events[i][4]);
    const eventType = safeUpper(events[i][6]);
    const breakType = safeUpper(events[i][7]);
    if (eventType === "CHECK_IN") {
      checkedIn[loginId] = true;
      if (!firstIn[loginId]) firstIn[loginId] = normalizeSheetTime(events[i][2]);
    }
    if (eventType === "CHECK_OUT") checkedOut[loginId] = true;
    if (eventType === "BREAK_START") activeBreak[loginId] = breakType;
    if (eventType === "BREAK_END") delete activeBreak[loginId];
  }

  return {
    working_staff: working,
    checked_in: Object.keys(checkedIn).length,
    checked_out: Object.keys(checkedOut).length,
    currently_working: Object.keys(checkedIn).length - Object.keys(checkedOut).length,
    on_break: Object.keys(activeBreak).length,
    late_staff: countLateStaff(targetDate, firstIn),
    not_checked_in: Math.max(working - Object.keys(checkedIn).length, 0)
  };
}

function countLateStaff(dateStr, firstIn) {
  const schedules = listScheduleRows("", dateStr);
  let count = 0;
  schedules.forEach(function (row) {
    const inTime = firstIn[row.login_id];
    if (!inTime) return;
    const grace = 5;
    if (parseTimeToMinutesSafe(inTime) - parseTimeToMinutesSafe(row.start_time) > grace) count++;
  });
  return count;
}

/***** LIST MAPPERS *****/

function listStaffRows() {
  const values = getValues(SHEETS.STAFF);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    rows.push({
      staff_id: values[i][0],
      full_name: values[i][1],
      login_id: values[i][2],
      email: values[i][3],
      team: values[i][4],
      role: values[i][5],
      status: values[i][6],
      joining_date: normalizeDateKey(values[i][7]),
      manager: values[i][8],
      phone: values[i][9],
      telegram_user_id: values[i][10],
      notes: values[i][11]
    });
  }
  return rows;
}

function listScheduleRows(month, dateStr) {
  const values = getValues(SHEETS.SCHEDULE);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = mapScheduleRow(values[i]);
    if (month && clean(row.schedule_month) !== clean(month)) continue;
    if (dateStr && normalizeDateKey(row.schedule_date) !== normalizeDateKey(dateStr)) continue;
    rows.push(row);
  }
  return rows;
}

function mapScheduleRow(row) {
  return {
    ok: true,
    schedule_id: row[0],
    schedule_month: row[1],
    schedule_date: normalizeDateKey(row[2]),
    staff_id: row[3],
    login_id: row[4],
    full_name: row[5],
    team: row[6],
    shift_code: row[7],
    start_time: normalizeSheetTime(row[8]),
    end_time: normalizeSheetTime(row[9]),
    status: row[10],
    uploaded_by: row[11] || "",
    uploaded_at: row[12] || "",
    notes: row[13] || ""
  };
}

function listAttendanceRows(dateStr, limit) {
  const values = getValues(SHEETS.EVENTS);
  const rows = [];
  const targetDate = normalizeDateKey(dateStr);
  for (let i = values.length - 1; i >= 1; i--) {
    if (targetDate && normalizeDateKey(values[i][1]) !== targetDate) continue;
    rows.push({
      event_id: values[i][0],
      event_date: normalizeDateKey(values[i][1]),
      event_time: normalizeSheetTime(values[i][2]),
      created_at: normalizeDateKey(values[i][1]) + " " + normalizeSheetTime(values[i][2]),
      staff_id: values[i][3],
      login_id: values[i][4],
      full_name: values[i][5],
      event_type: values[i][6],
      break_type: values[i][7],
      shift_code: values[i][8],
      ip: values[i][9],
      user_agent: values[i][10],
      source: values[i][11],
      server_time: values[i][12],
      notes: values[i][13],
      status: values[i][6]
    });
    if (limit && rows.length >= limit) break;
  }
  return rows;
}

function listDailyScoreRows(month, limit) {
  const values = getValues(SHEETS.DAILY);
  const rows = [];
  for (let i = values.length - 1; i >= 1; i--) {
    if (month && clean(values[i][2]) !== clean(month)) continue;
    rows.push({
      daily_score_id: values[i][0],
      score_date: normalizeDateKey(values[i][1]),
      score_month: values[i][2],
      staff_id: values[i][3],
      login_id: values[i][4],
      full_name: values[i][5],
      shift_code: values[i][6],
      start_time: normalizeSheetTime(values[i][7]),
      end_time: normalizeSheetTime(values[i][8]),
      check_in: normalizeSheetTime(values[i][9]),
      check_out: normalizeSheetTime(values[i][10]),
      status: values[i][19],
      base_score: values[i][20],
      penalty: values[i][21],
      final_attendance_score: values[i][22],
      created_at: values[i][23],
      notes: values[i][24]
    });
    if (limit && rows.length >= limit) break;
  }
  return rows;
}

function listKpiRows(month) {
  const values = getValues(SHEETS.KPI);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    if (month && clean(values[i][1]) !== clean(month)) continue;
    rows.push({
      kpi_id: values[i][0],
      kpi_month: values[i][1],
      staff_id: values[i][2],
      login_id: values[i][3],
      full_name: values[i][4],
      team: values[i][5],
      L_Leadership: values[i][6],
      E_Effectiveness: values[i][7],
      P_ProblemSolving: values[i][8],
      C_Communication: values[i][9],
      PR_Productivity: values[i][10],
      I_Initiative: values[i][11],
      Penalty: values[i][12],
      raw_score: values[i][13],
      kpi_score_out_of_5: values[i][14],
      updated_by: values[i][15],
      created_at: values[i][16],
      updated_at: values[i][17],
      notes: values[i][18]
    });
  }
  rows.sort(function (a, b) { return safeNumber(b.kpi_score_out_of_5, 0) - safeNumber(a.kpi_score_out_of_5, 0); });
  rows.forEach(function (row, index) { row.rank = index + 1; });
  return rows;
}

function listQuarterScoreRows(limit) {
  const values = getValues(SHEETS.QUARTER);
  const rows = [];
  for (let i = values.length - 1; i >= 1; i--) {
    rows.push({
      quarter_score_id: values[i][0],
      quarter: values[i][1],
      from_month: values[i][2],
      to_month: values[i][3],
      staff_id: values[i][4],
      login_id: values[i][5],
      full_name: values[i][6],
      team: values[i][7],
      attendance_avg: values[i][8],
      kpi_avg: values[i][9],
      attendance_weight: values[i][10],
      kpi_weight: values[i][11],
      final_score: values[i][12],
      final_grade: values[i][13],
      rank: values[i][14],
      created_at: values[i][15],
      notes: values[i][16]
    });
    if (limit && rows.length >= limit) break;
  }
  return rows;
}

function listAuditRows(limit) {
  const values = getValues(SHEETS.AUDIT);
  const rows = [];
  for (let i = values.length - 1; i >= 1; i--) {
    rows.push({
      audit_id: values[i][0],
      created_at: values[i][1],
      actor_type: values[i][2],
      actor_id: values[i][3],
      actor_name: values[i][4],
      action: values[i][5],
      module: values[i][6],
      target_id: values[i][7],
      old_value: values[i][8],
      new_value: values[i][9],
      ip: values[i][10],
      result: values[i][11] || "OK"
    });
    if (limit && rows.length >= limit) break;
  }
  return rows;
}

function listTelegramRows(limit) {
  const values = getValues(SHEETS.TG);
  const rows = [];
  for (let i = values.length - 1; i >= 1; i--) {
    rows.push({
      telegram_log_id: values[i][0],
      created_at: values[i][1],
      type: values[i][2],
      staff_id: values[i][3],
      login_id: values[i][4],
      full_name: values[i][5],
      event_type: values[i][6],
      message: values[i][7],
      status: values[i][8],
      response: values[i][9],
      notes: values[i][10]
    });
    if (limit && rows.length >= limit) break;
  }
  return rows;
}

function listIpRows() {
  const values = getValues(SHEETS.IP);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    if (!clean(values[i][1])) continue;
    rows.push({
      ip_id: values[i][0],
      ip_address: values[i][1],
      label: values[i][2],
      status: values[i][3],
      added_by: values[i][4],
      added_at: values[i][5],
      notes: values[i][6]
    });
  }
  return rows;
}

function normalizeScheduleImportRow(input) {
  const out = {};
  Object.keys(input || {}).forEach(function (key) {
    const normalizedKey = clean(key).toLowerCase().replace(/\s+/g, "_");
    out[normalizedKey] = clean(input[key]);
  });
  return {
    schedule_id: out.schedule_id || out.id,
    schedule_month: out.schedule_month || out.month,
    schedule_date: out.schedule_date || out.date || out.day,
    staff_id: out.staff_id,
    login_id: out.login_id || out.loginid || out.staff_login_id || out.email,
    full_name: out.full_name || out.name || out.staff_name,
    team: out.team || out.department,
    shift_code: out.shift_code || out.shift || out.shift_name,
    start_time: out.start_time || out.start || out.shift_start,
    end_time: out.end_time || out.end || out.shift_end,
    status: out.status || out.day_status,
    uploaded_by: out.uploaded_by,
    uploaded_at: out.uploaded_at,
    notes: out.notes
  };
}

/***** KPI *****/

function saveMonthlyKPI(data) {
  const ip = clean(data.ip);
  const ipError = requireAllowedIp(ip);
  if (ipError) return ipError;

  const adminLoginId = clean(data.admin_login_id);
  const staffLoginId = clean(data.login_id);
  const month = clean(data.kpi_month);
  if (!adminLoginId || !staffLoginId || !month) return { ok: false, message: "Missing admin, staff, or month" };

  const staff = getStaffByLogin(staffLoginId);
  if (!staff.ok) return staff;

  const L = safeNumber(data.L_Leadership, 0);
  const E = safeNumber(data.E_Effectiveness, 0);
  const P = safeNumber(data.P_ProblemSolving, 0);
  const C = safeNumber(data.C_Communication, 0);
  const PR = safeNumber(data.PR_Productivity, 0);
  const I = safeNumber(data.I_Initiative, 0);
  const Penalty = safeNumber(data.Penalty, 0);
  const raw = L + E + P + C + PR + I - Penalty;
  const score = Math.max(0, Math.min(5, raw / 6));

  const sheet = sh(SHEETS.KPI);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (clean(values[i][1]) === month && clean(values[i][3]) === staff.login_id) {
      sheet.getRange(i + 1, 7, 1, 13).setValues([[L, E, P, C, PR, I, Penalty, raw, score, adminLoginId, nowDateTime(), nowDateTime(), clean(data.notes)]]);
      clearSheetCache(SHEETS.KPI);
      appendAudit("ADMIN", adminLoginId, adminLoginId, "UPDATE_KPI", "KPI", staff.login_id, "", JSON.stringify(data), ip, "");
      return { ok: true, message: "KPI updated", kpi_score_out_of_5: score };
    }
  }

  sheet.appendRow([makeId("KPI"), month, staff.staff_id, staff.login_id, staff.full_name, staff.team, L, E, P, C, PR, I, Penalty, raw, score, adminLoginId, nowDateTime(), nowDateTime(), clean(data.notes)]);
  clearSheetCache(SHEETS.KPI);
  appendAudit("ADMIN", adminLoginId, adminLoginId, "SAVE_KPI", "KPI", staff.login_id, "", JSON.stringify(data), ip, "");
  return { ok: true, message: "KPI saved", kpi_score_out_of_5: score };
}

function getOwnKPI(loginId, month) {
  const values = getValues(SHEETS.KPI);
  for (let i = 1; i < values.length; i++) {
    if (clean(values[i][1]) === month && clean(values[i][3]) === clean(loginId)) {
      return {
        kpi_month: values[i][1],
        login_id: values[i][3],
        full_name: values[i][4],
        team: values[i][5],
        kpi_score_out_of_5: values[i][14]
      };
    }
  }
  return null;
}

/***** DAILY + QUARTER SCORE *****/

function calculateDailyScore(data) {
  try {
    const loginId = clean(data.login_id);
    const dateStr = clean(data.date) || todayDate();
    const staff = getStaffByLogin(loginId);
    if (!staff.ok) return staff;
    const schedule = getScheduleForDate(staff.login_id, dateStr);
    if (!schedule.ok) return schedule;

    const settings = getSettings();
    const state = getAttendanceState(staff.login_id, dateStr);
    let base = safeNumber(settings.ATTENDANCE_BASE_SCORE, 5);
    let penalty = 0;
    let status = "PRESENT";

    if (safeUpper(schedule.status) !== "WORKING") {
      status = safeUpper(schedule.status);
    } else {
      if (!state.hasCheckIn) {
        penalty += safeNumber(settings.MISSING_SIGNIN_PENALTY, 1);
        status = "MISSING_CHECK_IN";
      }
      if (state.hasCheckIn && !state.hasCheckOut) {
        penalty += safeNumber(settings.MISSING_SIGNOUT_PENALTY, 0.5);
        status = "MISSING_CHECK_OUT";
      }
      const lateMin = state.firstCheckIn ? diffMinutes(schedule.start_time, state.firstCheckIn) : 0;
      if (lateMin > safeNumber(settings.LATE_GRACE_MINUTES, 5)) {
        const step = safeNumber(settings.LATE_STEP_MINUTES, 5);
        penalty += Math.ceil((lateMin - safeNumber(settings.LATE_GRACE_MINUTES, 5)) / step) * safeNumber(settings.LATE_PENALTY_PER_STEP, 0.25);
        status = "LATE";
      }
    }

    const finalScore = Math.max(0, base - penalty);
    sh(SHEETS.DAILY).appendRow([
      makeId("DAS"), dateStr, clean(schedule.schedule_month), staff.staff_id, staff.login_id, staff.full_name,
      schedule.shift_code, schedule.start_time, schedule.end_time, state.firstCheckIn, state.lastCheckOut,
      "", "", "", "", "", state.hasCheckIn ? "NO" : "YES", state.hasCheckOut ? "NO" : "YES", "",
      status, base, penalty, finalScore, nowDateTime(), ""
    ]);
    clearSheetCache(SHEETS.DAILY);
    return { ok: true, message: "Daily score calculated", final_attendance_score: finalScore, penalty: penalty, status: status };
  } catch (err) {
    logInternalError("calculateDailyScore", err);
    return { ok: false, message: "Daily score calculation failed. Please try again." };
  }
}

function diffMinutes(startTime, endTime) {
  return parseTimeToMinutesSafe(endTime) - parseTimeToMinutesSafe(startTime);
}

function calculateQuarterScore(data) {
  try {
    const year = safeNumber(data.year, new Date().getFullYear());
    const quarter = safeUpper(data.quarter || "Q1");
    const months = getQuarterMonths(year, quarter);
    const staffValues = getValues(SHEETS.STAFF);
    const results = [];

    for (let i = 1; i < staffValues.length; i++) {
      if (safeUpper(staffValues[i][6]) !== "ACTIVE") continue;
      const staff = { staff_id: staffValues[i][0], full_name: staffValues[i][1], login_id: staffValues[i][2], team: staffValues[i][4] };
      const attendanceAvg = averageAttendance(staff.login_id, months);
      const kpiAvg = averageKPI(staff.login_id, months);
      const finalScore = Number(((attendanceAvg * 0.4) + (kpiAvg * 0.6)).toFixed(2));
      results.push({ staff: staff, attendance_avg: attendanceAvg, kpi_avg: kpiAvg, final_score: finalScore, final_grade: getGrade(finalScore) });
    }

    results.sort(function (a, b) { return b.final_score - a.final_score; });
    const sheet = sh(SHEETS.QUARTER);
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      sheet.appendRow([makeId("QFS"), quarter + "-" + year, months[0], months[2], r.staff.staff_id, r.staff.login_id, r.staff.full_name, r.staff.team, r.attendance_avg, r.kpi_avg, 40, 60, r.final_score, r.final_grade, i + 1, nowDateTime(), ""]);
    }
    clearSheetCache(SHEETS.QUARTER);
    return { ok: true, message: "Quarter score calculated", quarter: quarter + "-" + year, count: results.length, results: results };
  } catch (err) {
    logInternalError("calculateQuarterScore", err);
    return { ok: false, message: "Quarter score calculation failed. Please try again." };
  }
}

function getQuarterMonths(year, q) {
  if (q === "Q1") return [(year - 1) + "-12", year + "-01", year + "-02"];
  if (q === "Q2") return [year + "-03", year + "-04", year + "-05"];
  if (q === "Q3") return [year + "-06", year + "-07", year + "-08"];
  return [year + "-09", year + "-10", year + "-11"];
}

function averageAttendance(loginId, months) {
  const values = getValues(SHEETS.DAILY);
  let total = 0;
  let count = 0;
  for (let i = 1; i < values.length; i++) {
    if (clean(values[i][4]) === loginId && months.indexOf(clean(values[i][2])) !== -1) {
      total += safeNumber(values[i][22], 0);
      count++;
    }
  }
  return count ? Number((total / count).toFixed(2)) : 0;
}

function averageKPI(loginId, months) {
  const values = getValues(SHEETS.KPI);
  let total = 0;
  let count = 0;
  for (let i = 1; i < values.length; i++) {
    if (clean(values[i][3]) === loginId && months.indexOf(clean(values[i][1])) !== -1) {
      total += safeNumber(values[i][14], 0);
      count++;
    }
  }
  return count ? Number((total / count).toFixed(2)) : 0;
}

function getGrade(score) {
  if (score >= 4.5) return "Outstanding";
  if (score >= 4.0) return "Excellent";
  if (score >= 3.5) return "Very Good";
  if (score >= 3.0) return "Meet Expectation";
  if (score >= 2.5) return "Needs Improvement";
  return "Poor";
}

function getLeaderboard(month) {
  const list = listKpiRows(month).map(function (row) {
    return {
      login_id: row.login_id,
      full_name: row.full_name,
      team: row.team,
      kpi_score_out_of_5: safeNumber(row.kpi_score_out_of_5, 0),
      rank: row.rank
    };
  });
  return list;
}

/***** TELEGRAM ASYNC OPTIMIZATION *****/

function queueTelegramAttendance(staff, schedule, eventType, breakType, ip) {
  try {
    const settings = getSettings();
    if (safeUpper(settings.TG_NOTIFY_ENABLED) !== "YES") return;
    const payload = { id: makeId("TGQ"), created_at: nowDateTime(), staff: staff, schedule: schedule, eventType: eventType, breakType: breakType, ip: ip };
    const lock = LockService.getScriptLock();
    lock.waitLock(3000);
    try {
      const props = PropertiesService.getScriptProperties();
      const queue = JSON.parse(props.getProperty(TG_QUEUE_PROPERTY) || "[]");
      queue.push(payload);
      props.setProperty(TG_QUEUE_PROPERTY, JSON.stringify(queue));
      ensureTelegramTrigger();
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    logInternalError("queueTelegramAttendance", err);
    sendTelegramAttendance(staff, schedule, eventType, breakType, ip);
  }
}

function ensureTelegramTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === TG_TRIGGER_HANDLER) return;
  }
  ScriptApp.newTrigger(TG_TRIGGER_HANDLER).timeBased().after(1).create();
}

function processTelegramQueue() {
  resetRequestCache();
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
    const props = PropertiesService.getScriptProperties();
    const queue = JSON.parse(props.getProperty(TG_QUEUE_PROPERTY) || "[]");
    if (!queue.length) {
      props.deleteProperty(TG_QUEUE_PROPERTY);
      cleanupTelegramTriggers();
      return;
    }
    props.deleteProperty(TG_QUEUE_PROPERTY);
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      sendTelegramAttendance(item.staff, item.schedule, item.eventType, item.breakType, item.ip);
    }
    cleanupTelegramTriggers();
  } catch (err) {
    logInternalError("processTelegramQueue", err);
  } finally {
    try {
      lock.releaseLock();
    } catch (err) {
      logInternalError("processTelegramQueue.releaseLock", err);
    }
  }
}

function cleanupTelegramTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === TG_TRIGGER_HANDLER) ScriptApp.deleteTrigger(triggers[i]);
  }
}

function sendTelegramAttendance(staff, schedule, eventType, breakType, ip) {
  const settings = getSettings();
  if (safeUpper(settings.TG_NOTIFY_ENABLED) !== "YES") return;

  const token = clean(settings.TG_BOT_TOKEN);
  const chatId = clean(settings.TG_GROUP_CHAT_ID);
  if (!token || !chatId) return;

  const text =
    "Staff attendance update\n\n" +
    "Event: " + eventType + (breakType ? " / " + breakType : "") + "\n" +
    "Name: " + staff.full_name + "\n" +
    "Team: " + staff.team + "\n" +
    "Date: " + todayDate() + "\n" +
    "Shift: " + schedule.shift_code + "\n" +
    "Shift Time: " + formatShiftTime(schedule.start_time) + " - " + formatShiftTime(schedule.end_time) + "\n" +
    "Time: " + nowDateTime() + "\n" +
    "Office IP: " + ip;

  try {
    const url = "https://api.telegram.org/bot" + token + "/sendMessage";
    const res = UrlFetchApp.fetch(url, { method: "post", muteHttpExceptions: true, payload: { chat_id: chatId, text: text } });
    sh(SHEETS.TG).appendRow([makeId("TG"), nowDateTime(), "ATTENDANCE", staff.staff_id, staff.login_id, staff.full_name, eventType, text, "SENT", res.getContentText(), ""]);
    clearSheetCache(SHEETS.TG);
  } catch (err) {
    logInternalError("sendTelegramAttendance", err);
    sh(SHEETS.TG).appendRow([makeId("TG"), nowDateTime(), "ATTENDANCE", staff.staff_id, staff.login_id, staff.full_name, eventType, text, "FAILED", String(err), ""]);
    clearSheetCache(SHEETS.TG);
  }
}
