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

function resolveScoreMonth(month) {
  const requestedMonth = normalizeMonthKey(month);
  if (requestedMonth) return requestedMonth;

  const settings = getSettings();
  const defaultMonth = normalizeMonthKey(settings.DEFAULT_MONTH);
  return defaultMonth || monthNow();
}

function normalizeMonthKey(v) {
  if (Object.prototype.toString.call(v) === "[object Date]") {
    return Utilities.formatDate(v, TZ, "yyyy-MM");
  }
  if (isSheetSerialDate(v)) return Utilities.formatDate(sheetSerialDate(v), TZ, "yyyy-MM");

  const s = clean(v);
  if (!s) return "";
  if (/^\d+(\.\d+)?$/.test(s) && isSheetSerialDate(Number(s))) return Utilities.formatDate(sheetSerialDate(Number(s)), TZ, "yyyy-MM");

  if (/^\d{4}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{1}$/.test(s)) return s.substring(0, 5) + "0" + s.substring(5);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 7);

  const mdy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (mdy) return mdy[3] + "-" + pad2(Number(mdy[1]));

  const named = s.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (named) {
    const month = monthNameToNumber(named[1]);
    if (month) return named[2] + "-" + month;
  }

  const dayNamed = s.match(/^(?:[A-Za-z]{3,9}\s+)?([A-Za-z]{3,9})\s+\d{1,2}\s+(\d{4})(?:\s|$)/);
  if (dayNamed) {
    const dayNamedMonth = monthNameToNumber(dayNamed[1]);
    if (dayNamedMonth) return dayNamed[2] + "-" + dayNamedMonth;
  }

  const longDate = new Date(s);
  if (!isNaN(longDate.getTime()) && /[A-Za-z]/.test(s)) {
    return Utilities.formatDate(longDate, TZ, "yyyy-MM");
  }

  if (s.indexOf("GMT") > -1 || s.indexOf("T") > -1) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return Utilities.formatDate(d, TZ, "yyyy-MM");
  }

  return s.substring(0, 7);
}

function monthNameToNumber(name) {
  const months = {
    january: "01", jan: "01", february: "02", feb: "02", march: "03", mar: "03",
    april: "04", apr: "04", may: "05", june: "06", jun: "06", july: "07", jul: "07",
    august: "08", aug: "08", september: "09", sep: "09", sept: "09", october: "10", oct: "10",
    november: "11", nov: "11", december: "12", dec: "12"
  };
  return months[clean(name).toLowerCase()] || "";
}

function normalizeMonth(v) {
  return normalizeMonthKey(v);
}

function normalizeHeaderKey(v) {
  return clean(v).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function buildHeaderMap(headers) {
  const map = {};
  for (let i = 0; i < headers.length; i++) {
    const key = normalizeHeaderKey(headers[i]);
    if (key && map[key] == null) map[key] = i;
  }
  return map;
}

function valueByHeader(row, headerMap, keys, fallbackIndex) {
  for (let i = 0; i < keys.length; i++) {
    const key = normalizeHeaderKey(keys[i]);
    if (headerMap[key] != null) return row[headerMap[key]];
  }
  if (fallbackIndex != null && fallbackIndex >= 0) return row[fallbackIndex];
  return "";
}

function getSheetHeaders(sheetName) {
  const values = getValues(sheetName);
  return values.length ? values[0] : [];
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

function isSheetSerialDate(v) {
  return typeof v === "number" && isFinite(v) && v > 20000;
}

function sheetSerialDate(v) {
  return new Date(Math.round((Number(v) - 25569) * 86400000));
}

function normalizeDateKey(v) {
  if (Object.prototype.toString.call(v) === "[object Date]") return Utilities.formatDate(v, TZ, "yyyy-MM-dd");
  if (isSheetSerialDate(v)) return Utilities.formatDate(sheetSerialDate(v), TZ, "yyyy-MM-dd");
  const s = clean(v);
  if (!s) return "";
  if (/^\d+(\.\d+)?$/.test(s) && isSheetSerialDate(Number(s))) return Utilities.formatDate(sheetSerialDate(Number(s)), TZ, "yyyy-MM-dd");
  if (s.indexOf("GMT") > -1 || s.indexOf("T") > -1) {
    try {
      return Utilities.formatDate(new Date(s), TZ, "yyyy-MM-dd");
    } catch (err) {
      logInternalError("normalizeDateKey", err);
    }
  }
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime()) && /[A-Za-z]/.test(s)) return Utilities.formatDate(parsed, TZ, "yyyy-MM-dd");
  return s.substring(0, 10);
}

function getTeamTimezone(team) {
  const value = safeUpper(team);
  if (value === "CSP") return "Asia/Manila";
  if (value === "AFFILIATE") return "Asia/Colombo";
  return "Asia/Colombo";
}

function todayDateForTimezone(timezone) {
  return Utilities.formatDate(new Date(), timezone || TZ, "yyyy-MM-dd");
}

function nowTimeForTimezone(timezone) {
  return Utilities.formatDate(new Date(), timezone || TZ, "HH:mm:ss");
}

function normalizeSheetTime(v) {
  if (Object.prototype.toString.call(v) === "[object Date]") return Utilities.formatDate(v, TZ, "HH:mm:ss");
  const s = clean(v).replace(/^'/, "").replace(/\s+/g, " ").replace(/(\d)(AM|PM)$/i, "$1 $2");
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

function normalizeScheduleTimeForSheet(value) {
  if (Object.prototype.toString.call(value) === "[object Date]") {
    return forcePlainTimeText(Utilities.formatDate(value, "GMT", "HH:mm:ss"));
  }

  const raw = clean(value).replace(/^'/, "").replace(/\s+/g, " ").replace(".", ":").replace(/(\d)(AM|PM)$/i, "$1 $2");
  if (!raw) return "";

  const strict = raw.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (strict) {
    return forcePlainTimeText(pad2(Number(strict[1])) + ":" + pad2(Number(strict[2])) + ":" + pad2(Number(strict[3])));
  }

  const short = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (short) {
    return forcePlainTimeText(pad2(Number(short[1])) + ":" + pad2(Number(short[2])) + ":00");
  }

  const ampm = raw.match(/^(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?\s*(AM|PM)$/i);
  if (ampm) {
    let hour = Number(ampm[1]);
    const minute = Number(ampm[2] || 0);
    const second = Number(ampm[3] || 0);
    const meridiem = ampm[4].toUpperCase();
    if (meridiem === "PM" && hour < 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;
    return forcePlainTimeText(pad2(hour) + ":" + pad2(minute) + ":" + pad2(second));
  }

  return forcePlainTimeText(normalizeSheetTime(raw));
}

function forcePlainTimeText(v) {
  if (!v) return "";
  let s = String(v).trim().replace(/^'/, "");
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return s;
  return "'" + String(m[1]).padStart(2, "0") + ":" + m[2] + ":" + (m[3] || "00");
}

function parseScheduleTimeRange(value) {
  const text = clean(value).replace(/[\u2013\u2014]/g, "-");
  if (!text || text.indexOf("-") === -1) return { start_time: "", end_time: "" };
  const parts = text.split(/\s*-\s*/).map(function (part) {
    return clean(part);
  }).filter(Boolean);
  return {
    start_time: normalizeSheetTime(parts[0] || ""),
    end_time: normalizeSheetTime(parts[1] || "")
  };
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

function getAdminByLogin(loginId) {
  const values = getValues(SHEETS.ADMIN);
  const target = clean(loginId).toLowerCase();
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (clean(row[2]).toLowerCase() === target || clean(row[6]).toLowerCase() === target || clean(row[0]).toLowerCase() === target) {
      return {
        ok: true,
        admin_id: row[0],
        admin_name: row[1],
        login_id: row[2],
        role: row[5],
        email: row[6]
      };
    }
  }
  return { ok: false, role: "" };
}

function getAdminAccess(data) {
  const loginId = clean(data.admin_login_id || data.login_id || data.admin_id);
  const admin = getAdminByLogin(loginId);
  const role = safeUpper(admin.role || data.admin_role || data.account_role || "");
  const access = {
    admin_login_id: loginId,
    role: role || "SUPER_ADMIN",
    allowed_team: role === "CSP_ADMIN" ? "CSP" : ""
  };
  if (access.allowed_team) {
    Logger.log("CSP_ADMIN filtering: admin_login_id=" + access.admin_login_id + ", role=" + access.role + ", allowed_team=" + access.allowed_team);
  }
  return access;
}

function getStaffByLogin(loginId) {
  return getStaffByIdentifier(loginId);
}

function getStaffByIdentifier(identifier) {
  const values = getValues(SHEETS.STAFF);
  const target = clean(identifier).toLowerCase();
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
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (clean(row[0]).toLowerCase() === target) {
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
  const targetMonth = normalizeMonthKey(month);
  const list = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (normalizeMonthKey(row[1]) === targetMonth && clean(row[4]).toLowerCase() === target) {
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

  const staffTimezone = getTeamTimezone(staff.team);
  const requestedDate = clean(data.date || todayDateForTimezone(staffTimezone));
  const resolved = resolveAttendanceSchedule(staff, eventType, requestedDate);
  const today = resolved.date;
  const schedule = resolved.schedule;
  if (!schedule.ok) {
    Logger.log("Attendance blocked: login_id=" + staff.login_id + ", team=" + staff.team + ", action=" + eventType + ", result=NO_SCHEDULE");
    return { ok: false, code: "NO_SCHEDULE", message: "No schedule found for this day. Please contact admin." };
  }

  const shiftCode = safeUpper(schedule.shift_code);
  const scheduleStatus = safeUpper(schedule.status);
  if (isNonWorkingDay(shiftCode, scheduleStatus)) return { ok: false, code: "NON_WORKING_DAY", message: dayOffMessage(shiftCode, scheduleStatus) };
  if (scheduleStatus !== "WORKING") return { ok: false, message: "Today is not a working day: " + scheduleStatus };

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
    nowTimeForTimezone(staffTimezone),
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

  let daily_score = null;
  if (eventType === "CHECK_OUT") {
    try {
      daily_score = calculateDailyScore({ login_id: staff.login_id, date: today });
    } catch (err) {
      logInternalError("attendanceActionLocked.dailyScore", err);
    }
  }

  return {
    ok: true,
    message: eventType + " saved successfully",
    event_id: eventId,
    staff: staff,
    schedule: schedule,
    state: getAttendanceState(staff.login_id, today),
    daily_score: daily_score
  };
}

function resolveAttendanceSchedule(staff, eventType, requestedDate) {
  const dateKey = normalizeDateKey(requestedDate);
  const schedule = getScheduleForDate(staff.login_id, dateKey);
  if (schedule.ok) return { date: dateKey, schedule: schedule };

  if (eventType === "CHECK_OUT" || eventType === "BREAK_START" || eventType === "BREAK_END") {
    const previousDate = addDays(dateKey, -1);
    const previousSchedule = getScheduleForDate(staff.login_id, previousDate);
    if (previousSchedule.ok) {
      const state = getAttendanceState(staff.login_id, previousDate);
      if (state.hasCheckIn && !state.hasCheckOut) return { date: previousDate, schedule: previousSchedule };
    }
  }

  return { date: dateKey, schedule: schedule };
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

  const today = todayDateForTimezone(getTeamTimezone(staff.team));
  const month = resolveScoreMonth(data.month);
  const performanceDetails = getPerformanceDetails(month, staff.team);
  const leaderboard = performanceDetails.map(function (row) {
    return {
      login_id: row.login_id,
      full_name: row.full_name,
      team: row.team,
      attendance_score: row.attendance_score,
      kpi_score_out_of_5: row.kpi_score_out_of_5,
      kpi_score: row.kpi_score,
      final_score: row.final_score,
      monthly_final_score: row.monthly_final_score,
      quarter_score: row.quarter_score,
      ranking_score: row.ranking_score,
      rank: row.rank,
      current_rank: row.current_rank || row.rank,
      grade: row.grade,
      kpi_status: row.kpi_status
    };
  });
  const ownKpi = getOwnKPI(staff.login_id, month);
  const attendanceEvents = listAttendanceRows("", 300).filter(function (row) {
    return clean(row.login_id).toLowerCase() === clean(staff.login_id).toLowerCase();
  });
  const dailyScores = listDailyScoreRows(month, 300).filter(function (row) {
    return rowMatchesStaffIdentity(row, staff);
  });
  const quarterScores = listQuarterScoreRows(300).filter(function (row) {
    return rowMatchesStaffIdentity(row, staff);
  });
  const ownPerformance = performanceDetails.filter(function (row) {
    return rowMatchesStaffIdentity(row, staff);
  })[0] || {};
  const monthlyAttendanceScore = clean(ownPerformance.attendance_score) !== "" ? ownPerformance.attendance_score : 0;
  const kpiScore = clean(ownPerformance.kpi_score_out_of_5) !== "" ? ownPerformance.kpi_score_out_of_5 : 0;
  const finalScore = clean(ownPerformance.final_score) !== "" ? ownPerformance.final_score : calculateFinalScore(monthlyAttendanceScore, kpiScore);
  const quarterScoreValue = clean(ownPerformance.quarter_score) !== "" ? ownPerformance.quarter_score : 0;
  const scoreDebug = buildScoreDebug(month, listDailyScoreRows(month, 0), listKpiRows(month), performanceDetails);
  const quarterLabel = getQuarterLabelForMonth(month);
  const selectedQuarterScore = quarterScores.filter(function (row) {
    const fromMonth = normalizeMonth(row.from_month);
    const toMonth = normalizeMonth(row.to_month);
    return clean(row.quarter).toLowerCase() === clean(quarterLabel).toLowerCase() ||
      (fromMonth && toMonth && month >= fromMonth && month <= toMonth);
  })[0];
  const fallbackQuarter = {
    quarter: quarterLabel,
    login_id: staff.login_id,
    full_name: staff.full_name,
    attendance_avg: monthlyAttendanceScore,
    kpi_avg: kpiScore,
    final_score: quarterScoreValue,
    final_grade: getGrade(quarterScoreValue),
    rank: ownPerformance.rank || "",
    calculated: true
  };

  return {
    ok: true,
    selected_month: month,
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
    quarter_score: selectedQuarterScore || fallbackQuarter,
    quarter_score_value: quarterScoreValue,
    current_rank: ownPerformance.rank || "",
    rank: ownPerformance.rank || "",
    monthly_attendance_score: monthlyAttendanceScore,
    attendance_score: monthlyAttendanceScore,
    kpi_score: kpiScore,
    kpi_status: ownPerformance.kpi_status || (ownKpi ? "Scored" : "Not scored yet"),
    final_score: finalScore,
    performance_details: performanceDetails,
    leaderboard: leaderboard,
    own_kpi: ownKpi,
    score_debug: scoreDebug
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

function getNextShiftStaffRows(access, staffIndex) {
  const today = todayDate();
  const nowMinutes = parseTimeToMinutesSafe(nowTime());
  const nonWorkingCodes = ["OFF", "AL", "UL", "SL", "NP", "LEAVE", "HOLIDAY"];
  const rows = filterRowsForAdmin(listScheduleRows("", ""), access, staffIndex).filter(function (row) {
    const status = safeUpper(row.status);
    const shift = safeUpper(row.shift_code);
    if (status !== "WORKING") return false;
    if (nonWorkingCodes.indexOf(status) > -1 || nonWorkingCodes.indexOf(shift) > -1) return false;
    if (isNonWorkingDay(row.shift_code, row.status)) return false;
    const dateKey = normalizeDateKey(row.schedule_date);
    if (!dateKey || dateKey < today) return false;
    if (dateKey === today && parseTimeToMinutesSafe(row.start_time) < nowMinutes) return false;
    return true;
  });

  rows.sort(function (a, b) {
    const dateCompare = normalizeDateKey(a.schedule_date).localeCompare(normalizeDateKey(b.schedule_date));
    if (dateCompare) return dateCompare;
    const timeCompare = parseTimeToMinutesSafe(a.start_time) - parseTimeToMinutesSafe(b.start_time);
    if (timeCompare) return timeCompare;
    return clean(a.full_name).localeCompare(clean(b.full_name));
  });

  const byLogin = {};
  rows.forEach(function (row) {
    const key = clean(row.login_id).toLowerCase() || clean(row.staff_id).toLowerCase() || clean(row.full_name).toLowerCase();
    if (!key || byLogin[key]) return;
    byLogin[key] = {
      staff: row.full_name,
      full_name: row.full_name,
      login_id: row.login_id,
      team: row.team,
      date: normalizeDateKey(row.schedule_date),
      schedule_date: normalizeDateKey(row.schedule_date),
      shift: row.shift_code,
      shift_code: row.shift_code,
      start: row.start_time,
      start_time: row.start_time,
      end: row.end_time,
      end_time: row.end_time,
      status: row.status
    };
  });

  return Object.keys(byLogin).map(function (key) { return byLogin[key]; }).sort(function (a, b) {
    const dateCompare = normalizeDateKey(a.schedule_date).localeCompare(normalizeDateKey(b.schedule_date));
    if (dateCompare) return dateCompare;
    return parseTimeToMinutesSafe(a.start_time) - parseTimeToMinutesSafe(b.start_time);
  });
}

function getActiveBreakRows(dateStr, access, staffIndex) {
  const targetDate = normalizeDateKey(dateStr || todayDate());
  const rows = filterRowsForAdmin(listAttendanceRows(targetDate, 0), access, staffIndex);
  const closed = {};
  const active = {};

  rows.forEach(function (row) {
    const key = clean(row.login_id).toLowerCase() || clean(row.staff_id).toLowerCase();
    if (!key || active[key]) return;
    const eventType = safeUpper(row.event_type);
    if (eventType === "BREAK_END") {
      closed[key] = true;
      return;
    }
    if (eventType !== "BREAK_START" || closed[key]) return;
    const staff = staffIndex.byLogin[clean(row.login_id).toLowerCase()] || staffIndex.byStaffId[clean(row.staff_id).toLowerCase()] || {};
    active[key] = {
      staff_id: row.staff_id || staff.staff_id,
      login_id: row.login_id || staff.login_id,
      full_name: row.full_name || staff.full_name,
      name: row.full_name || staff.full_name,
      team: row.team || staff.team || "",
      event_date: row.event_date,
      event_time: row.event_time,
      break_type: row.break_type || "BREAK",
      breakStart: row.event_time,
      start: row.event_time,
      status: "ON_BREAK",
      ip: row.ip
    };
  });

  return Object.keys(active).map(function (key) { return active[key]; }).sort(function (a, b) {
    return (normalizeDateKey(b.event_date) + " " + normalizeSheetTime(b.event_time)).localeCompare(normalizeDateKey(a.event_date) + " " + normalizeSheetTime(a.event_time));
  });
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

function averageScoreRows(rows, key) {
  let total = 0;
  let count = 0;
  rows.forEach(function (row) {
    const raw = row && row[key];
    if (clean(raw) === "") return;
    total += clampScore(raw);
    count++;
  });
  return count ? round2(total / count) : 0;
}

function getQuarterScoreForMonth(loginId, month, fallbackScore) {
  const staff = getStaffByIdentifier(loginId);
  const identity = staff.ok ? staff : { login_id: loginId };
  return getQuarterScoreForStaff(identity, month, fallbackScore);
}

function getQuarterRowsForStaff(staff, month) {
  const targetMonth = normalizeMonth(month);
  const targetQuarter = getQuarterLabelForMonth(targetMonth);
  return listQuarterScoreRows(0).filter(function (row) {
    if (!rowMatchesStaffIdentity(row, staff)) return false;
    const fromMonth = normalizeMonth(row.from_month);
    const toMonth = normalizeMonth(row.to_month);
    if (targetQuarter && clean(row.quarter).toLowerCase() === clean(targetQuarter).toLowerCase()) return true;
    return fromMonth && toMonth && targetMonth >= fromMonth && targetMonth <= toMonth;
  });
}

function getQuarterScoreForStaff(staff, month, fallbackScore) {
  const rows = getQuarterRowsForStaff(staff, month);
  if (!rows.length) return round2(fallbackScore);
  const row = rows[0];
  const score = clean(row.quarter_score) !== "" ? row.quarter_score : row.final_score;
  return clean(score) !== "" ? round2(score) : round2(fallbackScore);
}

function buildScoreDebug(month, dailyRows, kpiRows, performanceRows) {
  return {
    selected_month: normalizeMonth(month),
    selected_quarter: getQuarterLabelForMonth(month),
    daily_rows_found: (dailyRows || []).length,
    kpi_rows_found: (kpiRows || []).length,
    quarter_rows_found: listQuarterScoreRows(0).length,
    sample_daily_headers: getSheetHeaders(SHEETS.DAILY).slice(0, 30),
    sample_kpi_headers: getSheetHeaders(SHEETS.KPI).slice(0, 30),
    sample_quarter_headers: getSheetHeaders(SHEETS.QUARTER).slice(0, 30),
    sample_score_rows: (performanceRows || []).slice(0, 5).map(function (row) {
      return {
        login_id: row.login_id,
        full_name: row.full_name,
        attendance_score: row.attendance_score,
        kpi_score: row.kpi_score,
        final_score: row.final_score,
        quarter_score: row.quarter_score,
        rank: row.rank
      };
    })
  };
}

function buildPerformanceDetails(month, teamFilter) {
  return buildCanonicalPerformanceDetails(resolveScoreMonth(month), teamFilter);
}

function identityKeys(row) {
  const keys = [];
  const login = clean(row && row.login_id).toLowerCase();
  const staffId = clean(row && row.staff_id).toLowerCase();
  if (login) keys.push("login:" + login);
  if (staffId) keys.push("staff:" + staffId);
  return keys;
}

function lookupKeysForStaff(staff) {
  const login = clean(staff && staff.login_id).toLowerCase();
  const staffId = clean(staff && staff.staff_id).toLowerCase();
  const keys = [];
  if (login) keys.push("login:" + login);
  if (staffId) keys.push("staff:" + staffId);
  return keys;
}

function addScoreRowToMap(map, row) {
  identityKeys(row).forEach(function (key) {
    if (!map[key]) map[key] = [];
    map[key].push(row);
  });
}

function getScoreRowsForStaff(map, staff) {
  const seen = {};
  const rows = [];
  lookupKeysForStaff(staff).forEach(function (key) {
    (map[key] || []).forEach(function (row) {
      const rowKey = identityKeys(row).join("|") || JSON.stringify(row);
      if (seen[rowKey]) return;
      seen[rowKey] = true;
      rows.push(row);
    });
  });
  return rows;
}

function setLatestScoreRow(map, row) {
  identityKeys(row).forEach(function (key) {
    map[key] = row;
  });
}

function getLatestScoreRowForStaff(map, staff) {
  const keys = lookupKeysForStaff(staff);
  for (let i = 0; i < keys.length; i++) {
    if (map[keys[i]]) return map[keys[i]];
  }
  return null;
}

function rowMatchesStaffIdentity(row, staff) {
  return getScoreRowsForStaff((function () {
    const map = {};
    addScoreRowToMap(map, row);
    return map;
  })(), staff).length > 0;
}

function getPerformanceDetails(month, teamFilter) {
  return buildCanonicalPerformanceDetails(month, teamFilter);
}

function buildCanonicalPerformanceDetails(month, teamFilter) {
  month = resolveScoreMonth(month);
  const teamKey = clean(teamFilter).toLowerCase();
  const activeStaff = listStaffRows().filter(function (staff) {
    if (safeUpper(staff.status) !== "ACTIVE" || isAdminStaff(staff)) return false;
    return !teamKey || clean(staff.team).toLowerCase() === teamKey;
  });
  const dailyRows = listDailyScoreRows(month, 0);
  const kpiRows = listKpiRows(month);
  const dailyMap = {};
  const kpiMap = {};

  dailyRows.forEach(function (row) {
    addScoreRowToMap(dailyMap, row);
  });

  kpiRows.forEach(function (row) {
    setLatestScoreRow(kpiMap, row);
  });

  const rows = activeStaff.map(function (staff) {
    const staffDaily = getScoreRowsForStaff(dailyMap, staff);
    const kpi = getLatestScoreRowForStaff(kpiMap, staff);
    const workingDailyRows = staffDaily.filter(isWorkingDailyScoreRow);
    const attendanceScore = averageScoreRows(workingDailyRows, "final_attendance_score");
    const kpiScore = kpi ? safeNumber(kpi.kpi_score_out_of_5, 0) : 0;
    const monthlyFinalScore = calculateFinalScore(attendanceScore, kpiScore);
    const quarterRows = getQuarterRowsForStaff(staff, month);
    const quarterScore = getQuarterScoreForStaff(staff, month, monthlyFinalScore);
    Logger.log("Score pipeline: " + JSON.stringify({
      selected_month: month,
      selected_quarter: getQuarterLabelForMonth(month),
      login_id: staff.login_id,
      staff_id: staff.staff_id,
      matched_daily_rows: staffDaily.length,
      matched_working_daily_rows: workingDailyRows.length,
      matched_kpi_rows: kpi ? 1 : 0,
      matched_quarter_rows: quarterRows.length,
      attendance_score: attendanceScore,
      kpi_score: kpiScore,
      monthly_final_score: monthlyFinalScore,
      quarter_score: quarterScore
    }));

    return {
      staff_id: staff.staff_id,
      login_id: staff.login_id,
      full_name: staff.full_name,
      team: staff.team,
      role: staff.role,
      status: staff.status,
      month: month,
      kpi_month: month,
      attendance_score: attendanceScore,
      monthly_attendance_score: attendanceScore,
      kpi_score_out_of_5: kpiScore,
      kpi_score: kpiScore,
      kpi_status: kpi ? "Scored" : "Not scored yet",
      quarter_score: quarterScore,
      quarter: getQuarterLabelForMonth(month),
      final_score: monthlyFinalScore,
      monthly_final_score: monthlyFinalScore,
      ranking_score: quarterScore,
      grade: getGrade(monthlyFinalScore),
      daily_score_count: workingDailyRows.length,
      has_kpi: Boolean(kpi),
      has_quarter_score: quarterRows.length > 0
    };
  });

  rows.sort(function (a, b) {
    return safeNumber(b.ranking_score, 0) - safeNumber(a.ranking_score, 0) ||
      safeNumber(b.final_score, 0) - safeNumber(a.final_score, 0) ||
      safeNumber(b.attendance_score, 0) - safeNumber(a.attendance_score, 0) ||
      safeNumber(b.kpi_score, 0) - safeNumber(a.kpi_score, 0) ||
      clean(a.full_name).localeCompare(clean(b.full_name));
  });
  rows.forEach(function (row, index) {
    row.rank = index + 1;
    row.current_rank = row.rank;
  });
  return rows;
}

function isAdminStaff(staff) {
  const role = safeUpper(staff && staff.role);
  const team = safeUpper(staff && staff.team);
  return role === "ADMIN" || team === "ADMIN" || role.indexOf("ADMIN") > -1 || team.indexOf("ADMIN") > -1;
}

function isNonWorkingDay(shiftCode, status) {
  const shift = safeUpper(shiftCode);
  const state = safeUpper(status);
  return ["OFF", "AL", "UL", "SL", "HOLIDAY"].indexOf(shift) !== -1 ||
    ["OFF", "AL", "UL", "SL", "HOLIDAY", "LEAVE"].indexOf(state) !== -1;
}

function dayOffMessage(shiftCode, status) {
  const shift = safeUpper(shiftCode);
  const state = safeUpper(status);
  const value = ["OFF", "AL", "UL", "SL", "HOLIDAY"].indexOf(shift) !== -1 ? shift : state;
  if (["OFF", "AL", "UL", "SL", "HOLIDAY"].indexOf(value) !== -1) return "Today is your " + value + " day.";
  return "Today is not a working day";
}

function buildStaffAccessIndex(staffRows) {
  const index = { byLogin: {}, byStaffId: {}, byEmail: {}, byName: {} };
  (staffRows || listStaffRows()).forEach(function (staff) {
    const login = clean(staff.login_id).toLowerCase();
    const staffId = clean(staff.staff_id).toLowerCase();
    const email = clean(staff.email).toLowerCase();
    const name = clean(staff.full_name).toLowerCase();
    if (login) index.byLogin[login] = staff;
    if (staffId) index.byStaffId[staffId] = staff;
    if (email) index.byEmail[email] = staff;
    if (name) index.byName[name] = staff;
  });
  return index;
}

function rowMatchesAllowedTeam(row, allowedTeam, staffIndex) {
  const teamKey = clean(allowedTeam).toLowerCase();
  if (!teamKey) return true;
  if (clean(row.team || row.department).toLowerCase() === teamKey) return true;

  const candidates = [
    staffIndex.byLogin[clean(row.login_id).toLowerCase()],
    staffIndex.byLogin[clean(row.admin_login_id).toLowerCase()],
    staffIndex.byLogin[clean(row.updated_by).toLowerCase()],
    staffIndex.byStaffId[clean(row.staff_id).toLowerCase()],
    staffIndex.byStaffId[clean(row.actor_id).toLowerCase()],
    staffIndex.byStaffId[clean(row.target_id).toLowerCase()],
    staffIndex.byEmail[clean(row.email).toLowerCase()],
    staffIndex.byName[clean(row.full_name).toLowerCase()],
    staffIndex.byName[clean(row.actor_name).toLowerCase()]
  ].filter(Boolean);

  return candidates.some(function (staff) {
    return clean(staff.team).toLowerCase() === teamKey;
  });
}

function filterRowsForAdmin(rows, access, staffIndex) {
  if (!access || !access.allowed_team) return rows;
  return rows.filter(function (row) {
    return rowMatchesAllowedTeam(row, access.allowed_team, staffIndex);
  });
}

/***** ADMIN DASHBOARD + LIST ACTIONS *****/

function getAdminDashboardFull(data) {
  const ip = clean(data.ip);
  const ipError = requireAllowedIp(ip);
  if (ipError) return ipError;

  const access = getAdminAccess(data);
  const month = resolveScoreMonth(data.month);
  const today = todayDate();
  const allStaff = listStaffRows();
  const staffIndex = buildStaffAccessIndex(allStaff);
  const staffList = filterRowsForAdmin(allStaff, access, staffIndex);
  let scheduleList = listScheduleRows(month, clean(data.date));
  if (!scheduleList.length && !clean(data.date)) {
    scheduleList = listScheduleRows("", "").filter(function (row) {
      return normalizeMonthKey(row.schedule_month) === month || normalizeDateKey(row.schedule_date) >= today;
    }).slice(0, 500);
  }
  scheduleList = filterRowsForAdmin(scheduleList, access, staffIndex);
  const attendanceEvents = filterRowsForAdmin(listAttendanceRows(clean(data.date) || today, safeNumber(data.limit, 250)), access, staffIndex);
  const breakBoard = getActiveBreakRows(clean(data.date) || today, access, staffIndex);
  const dailyScores = filterRowsForAdmin(listDailyScoreRows(month, safeNumber(data.limit, 250)), access, staffIndex);
  const kpiList = filterRowsForAdmin(listKpiRows(month), access, staffIndex);
  const quarterScores = filterRowsForAdmin(listQuarterScoreRows(safeNumber(data.limit, 250)), access, staffIndex);
  const auditLogs = filterRowsForAdmin(listAuditRows(safeNumber(data.limit, 100)), access, staffIndex);
  const telegramLogs = filterRowsForAdmin(listTelegramRows(safeNumber(data.limit, 100)), access, staffIndex);
  const ipAllowlist = listIpRows();
  const summary = getTodaySummary(today, access.allowed_team);
  const performanceDetails = buildPerformanceDetails(month, access.allowed_team);
  const nextShiftStaff = getNextShiftStaffRows(access, staffIndex);
  const scoreDebug = buildScoreDebug(month, dailyScores, kpiList, performanceDetails);
  const leaderboard = performanceDetails.map(function (row) {
    return {
      login_id: row.login_id,
      full_name: row.full_name,
      team: row.team,
      attendance_score: row.attendance_score,
      kpi_score_out_of_5: row.kpi_score_out_of_5,
      kpi_score: row.kpi_score,
      final_score: row.final_score,
      monthly_final_score: row.monthly_final_score,
      quarter_score: row.quarter_score,
      ranking_score: row.ranking_score,
      rank: row.rank,
      current_rank: row.current_rank || row.rank,
      grade: row.grade,
      kpi_status: row.kpi_status
    };
  });

  summary.total_staff = staffList.filter(function (row) { return safeUpper(row.status) === "ACTIVE"; }).length;
  summary.online_staff = summary.currently_working;
  summary.missing_checkout = Math.max(Number(summary.checked_in || 0) - Number(summary.checked_out || 0), 0);

  return {
    ok: true,
    selected_month: month,
    today: today,
    summary: summary,
    today_summary: summary,
    staff_count: summary.total_staff,
    staff_list: staffList,
    schedule_list: scheduleList,
    next_shift_staff: nextShiftStaff,
    attendance_events: attendanceEvents,
    breakBoard: breakBoard,
    breaks: breakBoard,
    daily_scores: dailyScores,
    kpi_list: kpiList,
    quarter_scores: quarterScores,
    audit_logs: auditLogs,
    telegram_logs: telegramLogs,
    ip_allowlist: ipAllowlist,
    leaderboard: leaderboard,
    topPerformers: leaderboard.slice(0, 10),
    worstPerformers: leaderboard.slice().reverse().slice(0, 10),
    performance_details: performanceDetails,
    score_debug: scoreDebug
  };
}

function getStaffList(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  const access = getAdminAccess(data);
  const staffRows = listStaffRows();
  return { ok: true, staff_list: filterRowsForAdmin(staffRows, access, buildStaffAccessIndex(staffRows)) };
}

function getScheduleList(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  const access = getAdminAccess(data);
  const staffIndex = buildStaffAccessIndex();
  return { ok: true, schedule_list: filterRowsForAdmin(listScheduleRows(normalizeMonthKey(data.month), clean(data.date)), access, staffIndex) };
}

function getAttendanceLogs(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  const access = getAdminAccess(data);
  const staffIndex = buildStaffAccessIndex();
  return { ok: true, attendance_events: filterRowsForAdmin(listAttendanceRows(clean(data.date), safeNumber(data.limit, 250)), access, staffIndex) };
}

function getAuditLogs(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  const access = getAdminAccess(data);
  const staffIndex = buildStaffAccessIndex();
  return { ok: true, audit_logs: filterRowsForAdmin(listAuditRows(safeNumber(data.limit, 100)), access, staffIndex) };
}

function getTelegramLogs(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  const access = getAdminAccess(data);
  const staffIndex = buildStaffAccessIndex();
  return { ok: true, telegram_logs: filterRowsForAdmin(listTelegramRows(safeNumber(data.limit, 100)), access, staffIndex) };
}

function getIpAllowlist(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  return { ok: true, ip_allowlist: listIpRows() };
}

function getKpiList(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  const access = getAdminAccess(data);
  const staffIndex = buildStaffAccessIndex();
  return { ok: true, selected_month: resolveScoreMonth(data.month), kpi_list: filterRowsForAdmin(listKpiRows(resolveScoreMonth(data.month)), access, staffIndex) };
}

function getQuarterScores(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  const access = getAdminAccess(data);
  const staffIndex = buildStaffAccessIndex();
  return { ok: true, quarter_scores: filterRowsForAdmin(listQuarterScoreRows(safeNumber(data.limit, 250)), access, staffIndex) };
}

function getDailyScores(data) {
  const ipError = requireAllowedIp(clean(data.ip));
  if (ipError) return ipError;
  const access = getAdminAccess(data);
  const staffIndex = buildStaffAccessIndex();
  return { ok: true, selected_month: resolveScoreMonth(data.month), daily_scores: filterRowsForAdmin(listDailyScoreRows(resolveScoreMonth(data.month), safeNumber(data.limit, 250)), access, staffIndex) };
}

function uploadScheduleCsv(data) {
  const ip = clean(data.ip);
  const ipError = requireAllowedIp(ip);
  if (ipError) return ipError;

  const adminLoginId = clean(data.admin_login_id || data.login_id || "Admin");
  const access = getAdminAccess({ admin_login_id: adminLoginId });
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const skipped = safeNumber(data.skipped, 0);
  if (!rows.length) return { ok: false, message: "No schedule rows found in CSV", inserted: 0, updated: 0, failed: 0, skipped: skipped };

  const staffByLogin = {};
  const staffByName = {};
  const staffRows = listStaffRows();
  staffRows.forEach(function (staff) {
    staffByLogin[clean(staff.login_id).toLowerCase()] = staff;
    staffByLogin[clean(staff.email).toLowerCase()] = staff;
    staffByName[normalizePersonName(staff.full_name)] = staff;
  });

  const sheet = sh(SHEETS.SCHEDULE);
  sheet.getRange("I:J").setNumberFormat("@");
  sheet.getRange(2, 9, sheet.getMaxRows(), 2).setNumberFormat("@");
  const existing = sheet.getDataRange().getValues();
  const existingMap = {};
  for (let i = 1; i < existing.length; i++) {
    existingMap[normalizeDateKey(existing[i][2]) + "|" + clean(existing[i][4]).toLowerCase()] = i + 1;
  }

  let inserted = 0;
  let updated = 0;
  let failed = 0;
  const errors = [];
  const insertRecords = [];
  const updateRecords = [];
  const frontendDebugRows = Array.isArray(data.frontend_first_10_rows) ? data.frontend_first_10_rows.slice(0, 10) : [];
  const backendReceivedDebugRows = [];
  const backendWrittenDebugRows = [];
  const pendingInsertIndex = {};

  rows.forEach(function (raw, index) {
    const row = normalizeScheduleImportRow(raw);
    if (backendReceivedDebugRows.length < 10) {
      backendReceivedDebugRows.push({
        shift_code: row.shift_code,
        start_time: row.start_time,
        end_time: row.end_time,
        status: row.status
      });
    }

    if (!row.schedule_date) {
      failed++;
      errors.push({ row: index + 2, message: "Missing schedule_date" });
      return;
    }

    const staff = staffByLogin[clean(row.login_id).toLowerCase()] || staffByName[normalizePersonName(row.full_name)];
    if (!staff || !staff.login_id) {
      failed++;
      errors.push({ row: index + 2, message: "Staff not found: " + (row.full_name || row.login_id || "blank") });
      return;
    }
    if (access.allowed_team && clean(staff.team).toLowerCase() !== clean(access.allowed_team).toLowerCase()) {
      failed++;
      errors.push({ row: index + 2, message: "Staff outside allowed team: " + clean(staff.full_name) });
      return;
    }

    const scheduleDate = normalizeDateKey(row.schedule_date);
    if (!scheduleDate) {
      failed++;
      errors.push({ row: index + 2, message: "Invalid schedule_date" });
      return;
    }

    const range = parseScheduleTimeRange(row.time_range || row.shift_time || row.working_hours || "");
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
      isWorking ? normalizeScheduleTimeForSheet(row.start_time || range.start_time || "09:00:00") : "",
      isWorking ? normalizeScheduleTimeForSheet(row.end_time || range.end_time || "18:00:00") : "",
      status,
      adminLoginId,
      nowDateTime(),
      clean(row.notes)
    ];

    record[8] = forcePlainTimeText(record[8]);
    record[9] = forcePlainTimeText(record[9]);

    if (backendWrittenDebugRows.length < 10) {
      backendWrittenDebugRows.push({
        shift_code: record[7],
        start_time: record[8],
        end_time: record[9],
        status: record[10]
      });
    }

    const key = record[2] + "|" + clean(record[4]).toLowerCase();
    if (existingMap[key] && existingMap[key] > 0) {
      updateRecords.push({ rowIndex: existingMap[key], values: record });
      updated++;
    } else if (pendingInsertIndex[key] != null) {
      insertRecords[pendingInsertIndex[key]] = record;
      updated++;
    } else {
      pendingInsertIndex[key] = insertRecords.length;
      insertRecords.push(record);
      inserted++;
    }
  });

  if (insertRecords.length) {
    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 9, insertRecords.length, 2).setNumberFormat("@");
    sheet.getRange(startRow, 1, insertRecords.length, insertRecords[0].length).setValues(insertRecords);
  }
  writeScheduleUpdateRecords(sheet, updateRecords);

  clearSheetCache(SHEETS.SCHEDULE);
  appendAudit("ADMIN", adminLoginId, adminLoginId, "UPLOAD_SCHEDULE_CSV", "SCHEDULE", "", "", JSON.stringify({ inserted, updated, failed, skipped }), ip, clean(data.fileName));
  return {
    ok: true,
    message: "Schedule CSV processed",
    inserted: inserted,
    updated: updated,
    failed: failed,
    skipped: skipped,
    errors: errors,
    frontend_first_10_rows: frontendDebugRows,
    backend_first_10_received_rows: backendReceivedDebugRows,
    backend_first_10_written_rows: backendWrittenDebugRows,
    written_debug_rows: backendWrittenDebugRows
  };
}

function normalizePersonName(value) {
  return clean(value).toLowerCase().replace(/\s+/g, " ");
}

function writeScheduleUpdateRecords(sheet, records) {
  if (!records.length) return;
  records.sort(function (a, b) {
    return a.rowIndex - b.rowIndex;
  });

  let batchStart = records[0].rowIndex;
  let batchRows = [records[0].values];
  let previous = records[0].rowIndex;

  for (let i = 1; i < records.length; i++) {
    const item = records[i];
    if (item.rowIndex === previous + 1) {
      batchRows.push(item.values);
    } else {
      sheet.getRange(batchStart, 9, batchRows.length, 2).setNumberFormat("@");
      sheet.getRange(batchStart, 1, batchRows.length, batchRows[0].length).setValues(batchRows);
      batchStart = item.rowIndex;
      batchRows = [item.values];
    }
    previous = item.rowIndex;
  }

  if (batchRows.length) {
    sheet.getRange(batchStart, 9, batchRows.length, 2).setNumberFormat("@");
    sheet.getRange(batchStart, 1, batchRows.length, batchRows[0].length).setValues(batchRows);
  }
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

function getTodaySummary(dateStr, teamFilter) {
  const schedule = getValues(SHEETS.SCHEDULE);
  const events = getValues(SHEETS.EVENTS);
  const targetDate = normalizeDateKey(dateStr);
  const teamKey = clean(teamFilter).toLowerCase();
  const staffIndex = buildStaffAccessIndex();

  let working = 0;
  let checkedIn = {};
  let checkedOut = {};
  let activeBreak = {};
  let firstIn = {};

  for (let i = 1; i < schedule.length; i++) {
    if (normalizeDateKey(schedule[i][2]) !== targetDate || safeUpper(schedule[i][10]) !== "WORKING") continue;
    const scheduleRow = mapScheduleRow(schedule[i]);
    if (teamKey && !rowMatchesAllowedTeam(scheduleRow, teamKey, staffIndex)) continue;
    working++;
  }

  for (let i = 1; i < events.length; i++) {
    if (normalizeDateKey(events[i][1]) !== targetDate) continue;
    if (teamKey && !rowMatchesAllowedTeam({
      staff_id: events[i][3],
      login_id: events[i][4],
      full_name: events[i][5]
    }, teamKey, staffIndex)) continue;
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
    late_staff: countLateStaff(targetDate, firstIn, teamFilter),
    not_checked_in: Math.max(working - Object.keys(checkedIn).length, 0)
  };
}

function countLateStaff(dateStr, firstIn, teamFilter) {
  const staffIndex = buildStaffAccessIndex();
  const schedules = filterRowsForAdmin(listScheduleRows("", dateStr), { allowed_team: clean(teamFilter) }, staffIndex);
  let count = 0;
  schedules.forEach(function (row) {
    const inTime = firstIn[row.login_id];
    if (!inTime) return;
    const grace = 5;
    const scheduleWindow = getScheduleWindowMinutes(row);
    if (alignEventMinutesToSchedule(inTime, scheduleWindow) - scheduleWindow.start_minutes > grace) count++;
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
  const targetMonth = normalizeMonthKey(month);
  const values = getValues(SHEETS.SCHEDULE);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = mapScheduleRow(values[i]);
    if (targetMonth && normalizeMonthKey(row.schedule_month) !== targetMonth) continue;
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
  const targetMonth = normalizeMonth(month);
  const values = getValues(SHEETS.DAILY);
  const headers = values[0] || [];
  const headerMap = buildHeaderMap(headers);
  const rows = [];
  for (let i = values.length - 1; i >= 1; i--) {
    const rowValues = values[i];
    const scoreDate = valueByHeader(rowValues, headerMap, ["score_date"], null);
    const scoreMonth = valueByHeader(rowValues, headerMap, ["score_month", "schedule_month", "month"], null);
    const rowMonth = normalizeMonth(scoreDate) || normalizeMonth(scoreMonth);
    if (targetMonth && rowMonth !== targetMonth) continue;
    rows.push({
      daily_score_id: valueByHeader(rowValues, headerMap, ["score_id", "daily_score_id"], null),
      score_date: normalizeDateKey(scoreDate),
      score_month: rowMonth || scoreMonth,
      staff_id: valueByHeader(rowValues, headerMap, ["staff_id"], null),
      login_id: valueByHeader(rowValues, headerMap, ["login_id"], null),
      full_name: valueByHeader(rowValues, headerMap, ["full_name", "name"], null),
      shift_code: valueByHeader(rowValues, headerMap, ["shift_code"], null),
      start_time: normalizeSheetTime(valueByHeader(rowValues, headerMap, ["scheduled_start", "start_time"], null)),
      end_time: normalizeSheetTime(valueByHeader(rowValues, headerMap, ["scheduled_end", "end_time"], null)),
      check_in: normalizeSheetTime(valueByHeader(rowValues, headerMap, ["first_check_in", "check_in"], null)),
      check_out: normalizeSheetTime(valueByHeader(rowValues, headerMap, ["last_check_out", "check_out"], null)),
      status: valueByHeader(rowValues, headerMap, ["attendance_status", "status"], null),
      base_score: valueByHeader(rowValues, headerMap, ["base_score"], null),
      penalty: valueByHeader(rowValues, headerMap, ["total_penalty", "penalty"], null),
      final_attendance_score: valueByHeader(rowValues, headerMap, ["final_attendance_score", "final_attendance", "attendance_score"], null),
      created_at: valueByHeader(rowValues, headerMap, ["calculated_at", "created_at"], null),
      notes: valueByHeader(rowValues, headerMap, ["notes"], null)
    });
    if (limit && rows.length >= limit) break;
  }
  return rows;
}

function listKpiRows(month) {
  const targetMonth = normalizeMonth(month);
  const values = getValues(SHEETS.KPI);
  const headers = values[0] || [];
  const headerMap = buildHeaderMap(headers);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const rowValues = values[i];
    const kpiMonth = valueByHeader(rowValues, headerMap, ["kpi_month", "month"], null);
    const rowMonth = normalizeMonth(kpiMonth);
    if (targetMonth && rowMonth !== targetMonth) continue;
    rows.push({
      kpi_id: valueByHeader(rowValues, headerMap, ["kpi_id"], null),
      kpi_month: rowMonth || kpiMonth,
      staff_id: valueByHeader(rowValues, headerMap, ["staff_id"], null),
      login_id: valueByHeader(rowValues, headerMap, ["login_id"], null),
      full_name: valueByHeader(rowValues, headerMap, ["full_name", "name"], null),
      team: valueByHeader(rowValues, headerMap, ["team"], null),
      L_Leadership: valueByHeader(rowValues, headerMap, ["L_Leadership", "Leadership"], null),
      E_Effectiveness: valueByHeader(rowValues, headerMap, ["E_Effectiveness", "Effectiveness"], null),
      P_ProblemSolving: valueByHeader(rowValues, headerMap, ["P_ProblemSolving", "ProblemSolving", "Problem_Solving"], null),
      C_Communication: valueByHeader(rowValues, headerMap, ["C_Communication", "Communication"], null),
      PR_Productivity: valueByHeader(rowValues, headerMap, ["PR_Productivity", "Productivity"], null),
      I_Initiative: valueByHeader(rowValues, headerMap, ["I_Initiative", "Initiative"], null),
      Penalty: valueByHeader(rowValues, headerMap, ["Penalty"], null),
      raw_score: valueByHeader(rowValues, headerMap, ["kpi_total_raw", "raw_score"], null),
      kpi_score_out_of_5: valueByHeader(rowValues, headerMap, ["kpi_score_out_of_5", "kpi_score"], null),
      updated_by: valueByHeader(rowValues, headerMap, ["submitted_by", "updated_by"], null),
      created_at: valueByHeader(rowValues, headerMap, ["submitted_at", "created_at"], null),
      updated_at: valueByHeader(rowValues, headerMap, ["updated_at"], null),
      notes: valueByHeader(rowValues, headerMap, ["notes"], null)
    });
  }
  rows.forEach(function (row, index) { row.rank = index + 1; });
  return rows;
}

function listQuarterScoreRows(limit) {
  const values = getValues(SHEETS.QUARTER);
  const headers = values[0] || [];
  const headerMap = buildHeaderMap(headers);
  const rows = [];
  for (let i = values.length - 1; i >= 1; i--) {
    const rowValues = values[i];
    rows.push({
      quarter_score_id: valueByHeader(rowValues, headerMap, ["quarter_id", "quarter_score_id"], null),
      quarter: valueByHeader(rowValues, headerMap, ["quarter_label", "quarter"], null),
      from_month: valueByHeader(rowValues, headerMap, ["quarter_start_month", "quarter_start_mo", "from_month"], null),
      to_month: valueByHeader(rowValues, headerMap, ["quarter_end_month", "quarter_end_mo", "to_month"], null),
      staff_id: valueByHeader(rowValues, headerMap, ["staff_id"], null),
      login_id: valueByHeader(rowValues, headerMap, ["login_id"], null),
      full_name: valueByHeader(rowValues, headerMap, ["full_name", "name"], null),
      team: valueByHeader(rowValues, headerMap, ["team"], null),
      attendance_avg: valueByHeader(rowValues, headerMap, ["attendance_avg"], null),
      kpi_avg: valueByHeader(rowValues, headerMap, ["kpi_avg"], null),
      attendance_weight: valueByHeader(rowValues, headerMap, ["attendance_weight"], null),
      kpi_weight: valueByHeader(rowValues, headerMap, ["kpi_weight"], null),
      quarter_score: valueByHeader(rowValues, headerMap, ["quarter_score"], null),
      final_score: valueByHeader(rowValues, headerMap, ["final_score"], null),
      final_grade: valueByHeader(rowValues, headerMap, ["final_grade"], null),
      rank: valueByHeader(rowValues, headerMap, ["rank"], null),
      created_at: valueByHeader(rowValues, headerMap, ["calculated_at", "created_at"], null),
      notes: valueByHeader(rowValues, headerMap, ["notes"], null)
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
    time_range: out.time_range || out.shift_time || out.working_hours || out.hours,
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
  const staffIdentifier = clean(data.login_id || data.staff_id || data.staffId || data.email);
  const month = normalizeMonthKey(data.kpi_month || data.month);
  if (!adminLoginId || !staffIdentifier || !month) return { ok: false, message: "Missing admin, staff, or month" };

  const staff = getStaffByIdentifier(staffIdentifier);
  if (!staff.ok) return staff;
  const access = getAdminAccess({ admin_login_id: adminLoginId });
  if (access.allowed_team && clean(staff.team).toLowerCase() !== clean(access.allowed_team).toLowerCase()) {
    return { ok: false, message: "This admin can only update CSP team KPI records" };
  }

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
  const headers = values[0] || [];
  const headerMap = buildHeaderMap(headers);
  for (let i = 1; i < values.length; i++) {
    const rowStaffId = valueByHeader(values[i], headerMap, ["staff_id"], 2);
    const rowLoginId = valueByHeader(values[i], headerMap, ["login_id"], 3);
    if (normalizeMonthKey(values[i][1]) === month &&
      (clean(rowLoginId).toLowerCase() === clean(staff.login_id).toLowerCase() || clean(rowStaffId).toLowerCase() === clean(staff.staff_id).toLowerCase())) {
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
  const targetMonth = normalizeMonth(month);
  const staff = getStaffByIdentifier(loginId);
  const identity = staff.ok ? staff : { login_id: loginId };
  const rows = listKpiRows(targetMonth).filter(function (row) {
    return rowMatchesStaffIdentity(row, identity);
  });
  return rows.length ? rows[rows.length - 1] : null;
}

/***** DAILY + QUARTER SCORE *****/

function round2(value) {
  return Number(safeNumber(value, 0).toFixed(2));
}

function clampScore(value) {
  return Math.max(0, Math.min(5, round2(value)));
}

function isWorkingDailyScoreRow(row) {
  if (!row) return false;
  const status = safeUpper(row.status);
  const workingStatuses = ["WORKING", "PRESENT", "LATE", "EARLY_CHECKOUT", "BREAK_OVERUSE", "MISSING_CHECK_IN", "MISSING_CHECK_OUT"];
  return workingStatuses.indexOf(status) !== -1 && !isNonWorkingDay(row.shift_code, row.status);
}

function calculateMonthlyAttendanceScore(loginId, month) {
  const staff = getStaffByIdentifier(loginId);
  const identity = staff.ok ? staff : { login_id: loginId };
  const targetMonth = resolveScoreMonth(month);
  const rows = listDailyScoreRows(targetMonth, 0).filter(function (row) {
    return rowMatchesStaffIdentity(row, identity) && isWorkingDailyScoreRow(row);
  });
  let total = 0;
  rows.forEach(function (row) {
    total += clampScore(row.final_attendance_score);
  });
  const score = rows.length ? round2(total / rows.length) : 0;
  Logger.log("Monthly score calculation: " + JSON.stringify({
    login_id: clean(loginId),
    month: targetMonth,
    row_count: rows.length,
    attendance_score: score
  }));
  return score;
}

function calculateFinalScore(attendanceScore, kpiScore) {
  const score = round2((safeNumber(attendanceScore, 0) * 0.4) + (safeNumber(kpiScore, 0) * 0.6));
  Logger.log("Final score calculation: " + JSON.stringify({
    attendance_score: safeNumber(attendanceScore, 0),
    kpi_score: safeNumber(kpiScore, 0),
    final_score: score
  }));
  return score;
}

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
    const score = calculateDailyAttendanceScore(staff, schedule, state, settings, dateStr);
    const dailyRow = [
      makeId("DAS"), dateStr, clean(schedule.schedule_month), staff.staff_id, staff.login_id, staff.full_name,
      schedule.shift_code, schedule.start_time, schedule.end_time, state.firstCheckIn, state.lastCheckOut,
      "", "", "", "", "", state.hasCheckIn ? "NO" : "YES", state.hasCheckOut ? "NO" : "YES", "",
      score.status, score.base_score, score.penalty, score.final_attendance_score, nowDateTime(), score.notes
    ];
    const sheet = sh(SHEETS.DAILY);
    const values = sheet.getDataRange().getValues();
    let existingRow = 0;
    for (let i = 1; i < values.length; i++) {
      if (normalizeDateKey(values[i][1]) === normalizeDateKey(dateStr) && clean(values[i][4]).toLowerCase() === clean(staff.login_id).toLowerCase()) {
        existingRow = i + 1;
        dailyRow[0] = clean(values[i][0]) || dailyRow[0];
        break;
      }
    }
    if (existingRow) {
      sheet.getRange(existingRow, 1, 1, dailyRow.length).setValues([dailyRow]);
    } else {
      sheet.appendRow(dailyRow);
    }
    clearSheetCache(SHEETS.DAILY);
    return {
      ok: true,
      message: existingRow ? "Daily score updated" : "Daily score calculated",
      final_attendance_score: score.final_attendance_score,
      penalty: score.penalty,
      status: score.status,
      late_minutes: score.late_minutes,
      early_checkout_minutes: score.early_checkout_minutes,
      break_overuse_minutes: score.break_overuse_minutes
    };
  } catch (err) {
    logInternalError("calculateDailyScore", err);
    return { ok: false, message: "Daily score calculation failed. Please try again." };
  }
}

function calculateDailyAttendanceScore(staff, schedule, state, settings, dateStr) {
  settings = settings || getSettings();
  const base = clampScore(safeNumber(settings.ATTENDANCE_BASE_SCORE, 5));
  const shiftCode = safeUpper(schedule && schedule.shift_code);
  const scheduleStatus = safeUpper(schedule && schedule.status);
  let penalty = 0;
  let status = "PRESENT";
  let lateMinutes = 0;
  let earlyCheckoutMinutes = 0;
  let breakOveruseMinutes = 0;

  if (isNonWorkingDay(shiftCode, scheduleStatus) || scheduleStatus !== "WORKING") {
    status = isNonWorkingDay(shiftCode, scheduleStatus) ? (shiftCode || scheduleStatus) : scheduleStatus;
    const nonWorkingResult = {
      base_score: base,
      penalty: 0,
      final_attendance_score: base,
      status: status,
      late_minutes: 0,
      early_checkout_minutes: 0,
      break_overuse_minutes: 0,
      notes: "Non-working day"
    };
    Logger.log("Daily score calculation: " + JSON.stringify({
      login_id: staff && staff.login_id,
      date: normalizeDateKey(dateStr),
      shift_code: shiftCode,
      schedule_status: scheduleStatus,
      result: nonWorkingResult
    }));
    return nonWorkingResult;
  }

  if (!state.hasCheckIn) {
    penalty += safeNumber(settings.MISSING_SIGNIN_PENALTY, 1);
    status = "MISSING_CHECK_IN";
  }

  if (state.hasCheckIn && !state.hasCheckOut) {
    penalty += safeNumber(settings.MISSING_SIGNOUT_PENALTY, 0.5);
    if (status === "PRESENT") status = "MISSING_CHECK_OUT";
  }

  if (state.firstCheckIn) {
    const scheduleWindow = getScheduleWindowMinutes(schedule);
    const checkInMinutes = alignEventMinutesToSchedule(state.firstCheckIn, scheduleWindow);
    lateMinutes = Math.max(0, checkInMinutes - scheduleWindow.start_minutes);
    const grace = safeNumber(settings.LATE_GRACE_MINUTES, 5);
    if (lateMinutes > grace) {
      const step = Math.max(1, safeNumber(settings.LATE_STEP_MINUTES, 5));
      penalty += Math.ceil((lateMinutes - grace) / step) * safeNumber(settings.LATE_PENALTY_PER_STEP, 0.25);
      if (status === "PRESENT") status = "LATE";
    }
  }

  if (state.lastCheckOut) {
    const scheduleWindow = getScheduleWindowMinutes(schedule);
    const checkOutMinutes = alignEventMinutesToSchedule(state.lastCheckOut, scheduleWindow);
    earlyCheckoutMinutes = Math.max(0, scheduleWindow.end_minutes - checkOutMinutes);
    if (earlyCheckoutMinutes > 0) {
      const step = Math.max(1, safeNumber(settings.EARLY_CHECKOUT_STEP_MINUTES, safeNumber(settings.LATE_STEP_MINUTES, 5)));
      penalty += Math.ceil(earlyCheckoutMinutes / step) * safeNumber(settings.EARLY_CHECKOUT_PENALTY_PER_STEP, 0.25);
      if (status === "PRESENT") status = "EARLY_CHECKOUT";
    }
  }

  const breakUsage = calculateBreakOveruse(staff.login_id, dateStr, schedule, settings);
  breakOveruseMinutes = breakUsage.overuse_minutes;
  if (breakOveruseMinutes > 0) {
    penalty += breakUsage.penalty;
    if (status === "PRESENT") status = "BREAK_OVERUSE";
  }

  const finalScore = clampScore(base - penalty);
  const result = {
    base_score: base,
    penalty: round2(penalty),
    final_attendance_score: finalScore,
    status: status,
    late_minutes: lateMinutes,
    early_checkout_minutes: earlyCheckoutMinutes,
    break_overuse_minutes: breakOveruseMinutes,
    notes: JSON.stringify({
      late_minutes: lateMinutes,
      early_checkout_minutes: earlyCheckoutMinutes,
      break_overuse_minutes: breakOveruseMinutes
    })
  };

  Logger.log("Daily score calculation: " + JSON.stringify({
    login_id: staff && staff.login_id,
    date: normalizeDateKey(dateStr),
    shift_code: shiftCode,
    schedule_status: scheduleStatus,
    has_check_in: state.hasCheckIn,
    has_check_out: state.hasCheckOut,
    result: result
  }));

  return result;
}

function getScheduleWindowMinutes(schedule) {
  const startMinutes = parseTimeToMinutesSafe(schedule && schedule.start_time);
  let endMinutes = parseTimeToMinutesSafe(schedule && schedule.end_time);
  if (endMinutes <= startMinutes) endMinutes += 1440;
  return {
    start_minutes: startMinutes,
    end_minutes: endMinutes,
    overnight: endMinutes > 1440
  };
}

function alignEventMinutesToSchedule(eventTime, scheduleWindow) {
  let minutes = parseTimeToMinutesSafe(eventTime);
  if (scheduleWindow && scheduleWindow.overnight && minutes < scheduleWindow.start_minutes) minutes += 1440;
  return minutes;
}

function calculateBreakOveruse(loginId, dateStr, schedule, settings) {
  const usage = getBreakUsage(loginId, dateStr, schedule);
  const rule = getShiftRule(schedule.shift_code);
  const limits = {
    BREAK: rule.ok ? safeNumber(rule.break_limit_min, 60) : 60,
    PRAYER_BREAK: rule.ok ? safeNumber(rule.prayer_break_limit_min, 15) : 15,
    BIO_BREAK: 10
  };
  const countLimits = {
    BREAK: rule.ok ? safeNumber(rule.break_count_limit, 1) : 1,
    PRAYER_BREAK: rule.ok ? safeNumber(rule.prayer_break_count_limit, 3) : 3,
    BIO_BREAK: rule.ok ? safeNumber(rule.bio_break_count_limit, 3) : 3
  };
  const step = Math.max(1, safeNumber(settings.BREAK_OVERUSE_STEP_MINUTES, safeNumber(settings.LATE_STEP_MINUTES, 5)));
  let overuseMinutes = 0;

  Object.keys(limits).forEach(function (type) {
    const item = usage[type] || { minutes: 0, count: 0 };
    overuseMinutes += Math.max(0, item.minutes - limits[type]);
    if (item.count > countLimits[type]) overuseMinutes += (item.count - countLimits[type]) * step;
  });

  return {
    overuse_minutes: overuseMinutes,
    penalty: overuseMinutes > 0 ? Math.ceil(overuseMinutes / step) * safeNumber(settings.BREAK_OVERUSE_PENALTY_PER_STEP, 0.25) : 0
  };
}

function getBreakUsage(loginId, dateStr, schedule) {
  const values = getValues(SHEETS.EVENTS);
  const targetDate = normalizeDateKey(dateStr);
  const targetLogin = clean(loginId).toLowerCase();
  const scheduleWindow = getScheduleWindowMinutes(schedule || {});
  const usage = {
    BREAK: { minutes: 0, count: 0 },
    PRAYER_BREAK: { minutes: 0, count: 0 },
    BIO_BREAK: { minutes: 0, count: 0 }
  };
  const activeStarts = {};

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (normalizeDateKey(row[1]) !== targetDate) continue;
    if (clean(row[4]).toLowerCase() !== targetLogin) continue;

    const eventType = safeUpper(row[6]);
    const breakType = safeUpper(row[7]);
    if (!usage[breakType]) continue;

    const eventMinutes = alignEventMinutesToSchedule(row[2], scheduleWindow);
    if (eventType === "BREAK_START") {
      usage[breakType].count++;
      activeStarts[breakType] = eventMinutes;
    }
    if (eventType === "BREAK_END" && activeStarts[breakType] != null) {
      usage[breakType].minutes += Math.max(0, eventMinutes - activeStarts[breakType]);
      delete activeStarts[breakType];
    }
  }

  Object.keys(activeStarts).forEach(function (breakType) {
    usage[breakType].minutes += Math.max(0, alignEventMinutesToSchedule(nowTimeForTimezone(getTeamTimezone(schedule && schedule.team)), scheduleWindow) - activeStarts[breakType]);
  });

  return usage;
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
      const staff = { staff_id: staffValues[i][0], full_name: staffValues[i][1], login_id: staffValues[i][2], team: staffValues[i][4], role: staffValues[i][5] };
      if (isAdminStaff(staff)) continue;
      const attendanceAvg = averageAttendance(staff.login_id, months);
      const kpiAvg = averageKPI(staff.login_id, months);
      const finalScore = calculateQuarterScoreValue(staff.login_id, months);
      Logger.log("Quarter score calculation: " + JSON.stringify({
        login_id: staff.login_id,
        quarter: quarter + "-" + year,
        months: months,
        attendance_avg: attendanceAvg,
        kpi_avg: kpiAvg,
        final_score: finalScore
      }));
      results.push({ staff: staff, attendance_avg: attendanceAvg, kpi_avg: kpiAvg, final_score: finalScore, final_grade: getGrade(finalScore) });
    }

    results.sort(function (a, b) {
      return safeNumber(b.final_score, 0) - safeNumber(a.final_score, 0) ||
        safeNumber(b.attendance_avg, 0) - safeNumber(a.attendance_avg, 0) ||
        safeNumber(b.kpi_avg, 0) - safeNumber(a.kpi_avg, 0) ||
        clean(a.staff.full_name).localeCompare(clean(b.staff.full_name));
    });
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
  q = safeUpper(q);
  if (q === "Q1") return [(year - 1) + "-12", year + "-01", year + "-02"];
  if (q === "Q2") return [year + "-03", year + "-04", year + "-05"];
  if (q === "Q3") return [year + "-06", year + "-07", year + "-08"];
  return [year + "-09", year + "-10", year + "-11"];
}

function getQuarterMonthsForMonth(month) {
  const key = resolveScoreMonth(month);
  const year = safeNumber(key.substring(0, 4), new Date().getFullYear());
  const monthNumber = safeNumber(key.substring(5, 7), 1);
  if (monthNumber === 12) return getQuarterMonths(year + 1, "Q1");
  if (monthNumber <= 2) return getQuarterMonths(year, "Q1");
  if (monthNumber <= 5) return getQuarterMonths(year, "Q2");
  if (monthNumber <= 8) return getQuarterMonths(year, "Q3");
  return getQuarterMonths(year, "Q4");
}

function getQuarterLabelForMonth(month) {
  const key = resolveScoreMonth(month);
  const year = safeNumber(key.substring(0, 4), new Date().getFullYear());
  const monthNumber = safeNumber(key.substring(5, 7), 1);
  if (monthNumber === 12) return "Q1-" + (year + 1);
  if (monthNumber <= 2) return "Q1-" + year;
  if (monthNumber <= 5) return "Q2-" + year;
  if (monthNumber <= 8) return "Q3-" + year;
  return "Q4-" + year;
}

function calculateQuarterScoreValue(loginId, months) {
  const monthKeys = (months || []).map(normalizeMonthKey).filter(Boolean);
  if (!monthKeys.length) return 0;

  let total = 0;
  monthKeys.forEach(function (month) {
    const attendanceScore = calculateMonthlyAttendanceScore(loginId, month);
    const kpi = getOwnKPI(loginId, month);
    const kpiScore = kpi ? safeNumber(kpi.kpi_score_out_of_5, 0) : 0;
    total += calculateFinalScore(attendanceScore, kpiScore);
  });

  const score = round2(total / monthKeys.length);
  Logger.log("Quarter score calculation: " + JSON.stringify({
    login_id: clean(loginId),
    months: monthKeys,
    quarter_score: score
  }));
  return score;
}

function averageAttendance(loginId, months) {
  const monthKeys = months.map(normalizeMonthKey).filter(Boolean);
  let total = 0;
  monthKeys.forEach(function (month) {
    total += calculateMonthlyAttendanceScore(loginId, month);
  });
  return monthKeys.length ? round2(total / monthKeys.length) : 0;
}

function averageKPI(loginId, months) {
  const monthKeys = months.map(normalizeMonthKey).filter(Boolean);
  let total = 0;
  monthKeys.forEach(function (month) {
    const kpi = getOwnKPI(loginId, month);
    total += kpi ? safeNumber(kpi.kpi_score_out_of_5, 0) : 0;
  });
  return monthKeys.length ? round2(total / monthKeys.length) : 0;
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
  const list = getPerformanceDetails(resolveScoreMonth(month)).map(function (row) {
    return {
      login_id: row.login_id,
      full_name: row.full_name,
      team: row.team,
      attendance_score: row.attendance_score,
      kpi_score_out_of_5: safeNumber(row.kpi_score_out_of_5, 0),
      kpi_score: safeNumber(row.kpi_score, 0),
      final_score: row.final_score,
      monthly_final_score: row.monthly_final_score,
      quarter_score: row.quarter_score,
      ranking_score: row.ranking_score,
      rank: row.rank,
      current_rank: row.current_rank || row.rank,
      grade: row.grade,
      kpi_status: row.kpi_status
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
  const chatId = getTelegramChatIdForStaff(settings, staff);
  if (!token || !chatId) return;

  let text =
    "Staff attendance update\n\n" +
    "Event: " + eventType + (breakType ? " / " + breakType : "") + "\n" +
    "Name: " + staff.full_name + "\n" +
    "Team: " + staff.team + "\n" +
    "Date: " + todayDate() + "\n" +
    "Shift: " + schedule.shift_code + "\n" +
    "Shift Time: " + formatShiftTime(schedule.start_time) + " - " + formatShiftTime(schedule.end_time) + "\n" +
    "Time: " + nowDateTime() + "\n" +
    "Office IP: " + ip;

  if (eventType === "BREAK_START") {
    text =
      "Break Started\n" +
      "Name: " + staff.full_name + "\n" +
      "Break: " + getTelegramBreakName(breakType) + "\n" +
      "Time: " + nowDateTime();
  }

  if (eventType === "BREAK_END") {
    const usage = getTelegramBreakUsage(staff.login_id, normalizeDateKey(schedule.schedule_date || todayDate()), breakType, schedule.shift_code);
    text =
      "Break Ended\n" +
      "Name: " + staff.full_name + "\n" +
      "Break: " + getTelegramBreakName(breakType) + "\n" +
      "Back Time: " + nowDateTime() + "\n" +
      "Used: " + usage.minutes + " min\n" +
      "Status: " + (usage.overused ? "Overused" : "Normal");
  }

  if (eventType === "CHECK_OUT") {
    text =
      "Check Out\n" +
      "Name: " + staff.full_name + "\n" +
      "Time: " + nowDateTime() + "\n" +
      "Status: " + getTelegramCheckoutStatus(staff.login_id, normalizeDateKey(schedule.schedule_date || todayDate()));
  }

  try {
    const url = "https://api.telegram.org/bot" + token + "/sendMessage";
    const res = UrlFetchApp.fetch(url, { method: "post", muteHttpExceptions: true, payload: { chat_id: chatId, text: text } });
    sh(SHEETS.TG).appendRow([makeId("TG"), nowDateTime(), "ATTENDANCE", staff.staff_id, staff.login_id, staff.full_name, eventType, text, "SENT", res.getContentText(), "chat_id=" + chatId]);
    clearSheetCache(SHEETS.TG);
  } catch (err) {
    logInternalError("sendTelegramAttendance", err);
    sh(SHEETS.TG).appendRow([makeId("TG"), nowDateTime(), "ATTENDANCE", staff.staff_id, staff.login_id, staff.full_name, eventType, text, "FAILED", String(err), "chat_id=" + chatId]);
    clearSheetCache(SHEETS.TG);
  }
}

function getTelegramBreakName(breakType) {
  const type = safeUpper(breakType);
  if (type === "PRAYER_BREAK") return "Prayer Break";
  if (type === "BIO_BREAK") return "Bio Break";
  return "Break";
}

function getTelegramBreakUsage(loginId, dateStr, breakType, shiftCode) {
  const values = getValues(SHEETS.EVENTS);
  const targetLogin = clean(loginId).toLowerCase();
  const targetDate = normalizeDateKey(dateStr);
  const targetBreak = safeUpper(breakType);
  let startTime = "";
  let usedMinutes = 0;

  for (let i = 1; i < values.length; i++) {
    if (normalizeDateKey(values[i][1]) !== targetDate) continue;
    if (clean(values[i][4]).toLowerCase() !== targetLogin) continue;
    if (safeUpper(values[i][7]) !== targetBreak) continue;

    const eventType = safeUpper(values[i][6]);
    const eventTime = normalizeSheetTime(values[i][2]);
    if (eventType === "BREAK_START") startTime = eventTime;
    if (eventType === "BREAK_END" && startTime) {
      usedMinutes = diffMinutes(startTime, eventTime);
      if (usedMinutes < 0) usedMinutes += 1440;
      startTime = "";
    }
  }

  const rule = getShiftRule(shiftCode);
  const limit = targetBreak === "PRAYER_BREAK"
    ? (rule.ok ? safeNumber(rule.prayer_break_limit_min, 15) : 15)
    : targetBreak === "BIO_BREAK"
      ? (rule.ok ? safeNumber(rule.bio_break_limit_min, 11) : 11)
      : (rule.ok ? safeNumber(rule.break_limit_min, 60) : 60);

  return { minutes: Math.max(0, Math.round(usedMinutes)), overused: usedMinutes > limit };
}

function getTelegramCheckoutStatus(loginId, dateStr) {
  const rows = listDailyScoreRows(normalizeDateKey(dateStr).substring(0, 7), 250);
  const targetLogin = clean(loginId).toLowerCase();
  const targetDate = normalizeDateKey(dateStr);
  for (let i = 0; i < rows.length; i++) {
    if (clean(rows[i].login_id).toLowerCase() === targetLogin && normalizeDateKey(rows[i].score_date) === targetDate) {
      return clean(rows[i].status) || "Completed";
    }
  }
  return "Completed";
}

function getTelegramChatIdForStaff(settings, staff) {
  const teamKey = safeUpper(staff && staff.team).replace(/[^A-Z0-9]/g, "_");
  const teamChatId = clean(settings["TG_GROUP_CHAT_ID_" + teamKey]);
  return teamChatId || clean(settings.TG_GROUP_CHAT_ID);
}
