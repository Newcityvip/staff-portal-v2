// Phase 2A fixture contract; no connection to Apps Script, Cloudflare or Sheets.
export const rosterSessionMaxAge = 10 * 60 * 1000;
const roles = Object.freeze({ SUPER_ADMIN: ["Affiliate", "CSP"], CSP_ADMIN: ["CSP"] });
const denied = status => ({ status, body: { ok: false } });
const validMonth = value => typeof value === "string" && /^20\d\d-(0[1-9]|1[0-2])$/.test(value);
const commonFields = ["staff", "shifts", "schedule"];
const fields = {
  staff: ["staff_id", "full_name", "login_id", "team", "status", "joining_date"],
  shifts: ["team", "shift_code", "start_time", "end_time", "active"],
  schedule: ["team", "staff_id", "schedule_date", "schedule_month", "shift_code", "start_time", "end_time", "status"]
};

export function rosterReadContract({ verifyGateway, resolveSession, resolveAdmin, allowedIp, readSource, now = Date.now }) {
  return async function read(request) {
    if (request.method !== "GET") return denied(405);
    if (request.operation !== "roster_snapshot") return denied(404);
    if (!await verifyGateway(request)) return denied(403);
    const session = await resolveSession(request.sessionId);
    const time = now();
    if (!session || session.audience !== "roster-read" || !Number.isFinite(session.issuedAt) ||
      !Number.isFinite(session.expiresAt) || session.issuedAt > time || session.expiresAt <= time ||
      session.expiresAt - session.issuedAt > rosterSessionMaxAge || session.ip !== request.gatewayIp) return denied(401);
    const admin = await resolveAdmin(session.subject);
    const teams = admin?.active === true && Object.hasOwn(roles, admin.role) ? roles[admin.role] : [];
    if (!teams.length || typeof admin.draftNamespace !== "string" || !await allowedIp(request.gatewayIp)) return denied(403);
    if (!validMonth(request.month)) return denied(400);
    if (!teams.includes(request.team)) return denied(403);
    try {
      const source = await readSource(request.team, request.month);
      if (!commonFields.every(field => Array.isArray(source[field])) ||
        commonFields.some(field => source[field].some(row => row.team !== request.team))) return denied(502);
      return { status: 200, body: { ok: true, team: request.team, month: request.month, teams: [...teams],
        principal: admin.draftNamespace, ...Object.fromEntries(commonFields.map(field => [field, source[field].map(row =>
          Object.fromEntries(fields[field].filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])))])),
        excludedStaffIds: source.excludedStaffIds || [], revision: source.revision, timeZone: source.timeZone } };
    } catch {
      return denied(503);
    }
  };
}
