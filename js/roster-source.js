import { datesFor, draftFor, key, nextMonth, previousMonth } from "./roster-model.js";

const clean = value => String(value ?? "").trim();
const upper = value => clean(value).toUpperCase();
const time = value => /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(clean(value)) ?
  (clean(value).length === 5 ? clean(value) + ":00" : clean(value)) : "";
const calendarDate = value => /^20\d\d-\d\d-\d\d$/.test(value) && datesFor(value.slice(0, 7)).includes(value);
const leave = ["AL", "SL", "UL"];
const zones = { Affiliate: "Asia/Colombo", CSP: "Asia/Manila" };
const brandGroups = {
  Affiliate: [{ id: "old", name: "OLD Brands", team: "Affiliate" }, { id: "new", name: "NEW Brands", team: "Affiliate" }],
  CSP: [{ id: "csp", name: "CSP Operations", team: "CSP" }]
};
function uniqueRows(rows, id, onDuplicate) {
  const map = new Map(), duplicates = new Set();
  for (const row of rows) {
    const k = id(row);
    if (!k || duplicates.has(k)) continue;
    if (!map.has(k)) { map.set(k, row); continue; }
    duplicates.add(k); map.delete(k); onDuplicate(k);
  }
  return map;
}

export function prepareRosterSource(payload, team, month) {
  if (!payload || payload.ok !== true || payload.team !== team || payload.month !== month || !datesFor(month).length ||
    payload.timeZone !== zones[team] || !Array.isArray(payload.teams) || !payload.teams.includes(team) ||
    typeof payload.revision !== "string" || !payload.revision || !/^[a-z0-9_-]{1,80}$/i.test(payload.principal || "") ||
    !["staff", "shifts", "schedule"].every(field => Array.isArray(payload[field]) && payload[field].every(row => row?.team === team))) {
    throw new Error("The roster source response could not be verified.");
  }
  const issues = [], rows = [];
  const issue = (kind, date = "", staffId = "") => issues.push({ kind, date, staffId });
  if (payload.suppressedTeamConflicts !== undefined &&
    (!Number.isSafeInteger(payload.suppressedTeamConflicts) || payload.suppressedTeamConflicts < 0)) {
    throw new Error("Invalid roster conflict count.");
  }
  if (payload.suppressedTeamConflicts) issue(payload.suppressedTeamConflicts + " schedule rows suppressed due to conflicting team assignments");
  const excluded = new Set((payload.excludedStaffIds || []).map(upper));
  const directory = uniqueRows(payload.staff, row => {
    const id = upper(row.staff_id);
    if (!/^[A-Z0-9_.-]{1,64}$/.test(id) || !clean(row.full_name)) { issue("Invalid staff identity"); return ""; }
    return id;
  }, id => issue("Duplicate staff identity", "", id));
  const staff = [...directory].map(([id, row]) => {
    const joined = clean(row.joining_date), active = upper(row.status) === "ACTIVE";
    const exclusion = excluded.has(id) ? "Explicit exclusion" : !active ? "Inactive or unknown status" :
      joined && !calendarDate(joined) ? "Unknown joining date" : joined > month + "-01" ? "Joined after month start" : "";
    return { id, name: clean(row.full_name), login: clean(row.login_id), team, active, joined, exclusion };
  });
  const shiftRows = uniqueRows(payload.shifts.filter(r => ["YES", "TRUE", "ACTIVE"].includes(upper(r.active))), row => upper(row.shift_code),
    code => issue("Duplicate active shift " + code));
  const catalog = [...shiftRows].flatMap(([id, row]) => {
    const kind = id === "OFF" ? "off" : leave.includes(id) ? "leave" : "work";
    const start = kind === "work" ? time(row.start_time) : "", end = kind === "work" ? time(row.end_time) : "";
    if (!/^[A-Z][A-Z0-9]{0,7}$/.test(id) || kind === "work" && (!start || !end || start === end)) {
      issue("Unsupported active shift " + id);
      return [];
    }
    return [{ id, kind, start, end, color: kind === "work" ? "#82d9ee" : "#97dfab" }];
  });
  const shifts = new Map(catalog.map(s => [s.id, s]));
  const periods = new Set([previousMonth(month), month, nextMonth(month)]);
  const schedule = uniqueRows(payload.schedule, row => {
    const date = clean(row.schedule_date), id = upper(row.staff_id);
    if (!calendarDate(date) || !periods.has(date.slice(0, 7))) { issue("Date outside the source window"); return ""; }
    if (!directory.has(id)) { issue("Unknown staff ID", date, id); return ""; }
    return key(id, date);
  }, k => { const [id, date] = k.split("|"); issue("Duplicate staff/date schedule", date, id); });
  const cells = {};
  for (const [k, row] of schedule) {
    const [id, date] = k.split("|");
    const code = upper(row.shift_code), status = upper(row.status), shift = shifts.get(code);
    const start = clean(row.start_time), end = clean(row.end_time);
    let conflict = "";
    if (clean(row.schedule_month) !== date.slice(0, 7)) conflict = "Schedule month conflicts with date";
    else if (!shift) conflict = "Unknown or inactive shift";
    else if (shift.kind === "work" ? status !== "WORKING" || time(start) !== shift.start || time(end) !== shift.end :
      !["OFF", code].includes(status) || start || end) conflict = "Published times or status differ from the source catalog";
    if (conflict) issue(conflict, date, id); else cells[k] = code;
    rows.push({ id, date, code, start, end, status, conflict });
  }
  return { team, month, teams: payload.teams, timeZone: payload.timeZone, principal: payload.principal, revision: payload.revision,
    staff, catalog, rows, cells, issues, usable: issues.length === 0 && catalog.some(s => s.kind === "off") && catalog.some(s => s.kind === "work") };
}

export function sourceDraft(source, include = [], usePublished = true, generationShifts) {
  if (!source.usable) throw new Error("Resolve source conflicts before preparing a draft.");
  const selected = new Set(include);
  const people = source.staff.filter(p => !p.exclusion && selected.has(p.id));
  const { team, month, catalog, cells } = source;
  const model = { people, groups: structuredClone(brandGroups[team]), catalogs: { [team]: catalog },
    memberships: team === "CSP" ? people.map(p => ({ id: p.id, group: "csp", from: month })) : [],
    drafts: {}, snapshots: [], leave: {}, leaveOrigin: "published", transitions: { [team]: [] } };
  for (const period of [previousMonth(month), month, nextMonth(month)]) {
    const draft = draftFor(model, team, period);
    for (const person of people) for (const date of datesFor(period)) {
      const k = key(person.id, date), code = cells[k];
      if (!code) continue;
      if (period === month && leave.includes(code)) model.leave[k] = code;
      if (period !== month || usePublished || leave.includes(code)) draft.cells[k] = code;
    }
  }
  if (generationShifts) {
    const draft = draftFor(model, team, month);
    for (const group of [...model.groups.map(g => g.id), "unassigned"]) for (const s of catalog) {
      if (s.kind === "work" && !generationShifts.includes(s.id)) draft.coverage[group + "|*|" + s.id] = { enabled: false };
    }
  }
  return model;
}

export const fixtureDraftKey = (...scope) => "spv2.roster.fixture-draft.v1." + scope.join(".");
export const liveDraftKey = (...scope) => "spv2.roster.live-draft.v1." + scope.join(".");
export const fixtureHandoffKey = "spv2.roster.fixture-handoff.v1";
export function publicationConfiguration(context) {
  const { rules, coverage, demand, preferences } = context.draft;
  return { rules, coverage, demand, preferences, transitions: context.transitions,
    groups: context.groups.map(({ id, name }) => ({ id, name })),
    memberships: context.people.map(({ id, group }) => ({ id, group })).sort((a, b) => a.id.localeCompare(b.id)) };
}
export function draftComparison(localCells, sourceCells, teamPeople, dates) {
  let added = 0, removed = 0, changed = 0;
  for (const person of teamPeople) for (const date of dates) {
    const k = key(person.id, date), a = localCells[k], b = sourceCells[k];
    if (a === b) continue;
    if (!a) added++; else if (!b) removed++; else changed++;
  }
  return { added, removed, changed };
}

export function createSourceReader({ request, deadline = 8000, timers = globalThis, now = Date.now }) {
  let last, generation = 0, running;
  return {
    get last() { return last; },
    refresh(team, month) {
      const scope = team + "|" + month;
      if (running?.scope === scope) return running.promise;
      const attempt = ++generation;
      const previous = last?.scope === scope ? last : null, controller = new AbortController();
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = timers.setTimeout(() => { reject(Object.assign(new Error("Roster read timed out."), { status: "timeout" })); controller.abort(); }, deadline);
      });
      const read = Promise.resolve().then(() => request(team, month, controller.signal)).then(async response => {
        if (!response.ok) throw Object.assign(new Error("Roster read failed."), { status: response.status });
        return prepareRosterSource(await response.json(), team, month);
      });
      const promise = Promise.race([read, timeout]).then(source => {
        if (attempt !== generation) return null;
        last = { scope, source, refreshedAt: now(), changed: Boolean(previous && previous.source.revision !== source.revision) };
        return { state: "ready", ...last };
      }, error => {
        if (attempt !== generation) return null;
        const denied = [401, 403].includes(error.status);
        if (denied) last = null;
        return { state: denied ? "denied" : error.status === "timeout" ? "timeout" : "error", previous: denied ? null : previous };
      }).finally(() => { timers.clearTimeout(timer); if (generation === attempt) running = null; });
      running = { scope, promise };
      return promise;
    }
  };
}
