import { randomUUID } from "node:crypto";
import { datesFor } from "../js/roster-model.js";

const api = "https://sheets.googleapis.com/v4/spreadsheets";
const name = "04_Schedule_Master";
const sheetId = 401;
export const scheduleColumns = ["schedule_id", "schedule_month", "schedule_date", "staff_id", "login_id", "full_name",
  "team", "shift_code", "start_time", "end_time", "status", "uploaded_by", "uploaded_at", "notes"];
const rowKey = row => String(row[3] || "").trim().toUpperCase() + "|" + row[2];
const projection = row => row && [row[1], row[2], row[3], row[6], ...row.slice(7, 11)];
const loginKey = value => String(value || "").trim().toLowerCase();
const expected = row => row && [row.schedule_month, row.schedule_date, row.staff_id, row.team, row.shift_code,
  row.start_time, row.end_time, row.status];
const original = (row, team) => row && [row.date.slice(0, 7), row.date, row.id, team, row.code, row.start, row.end, row.status];
const equal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const padded = row => scheduleColumns.map((_, i) => row[i] ?? "");
const cells = values => ({ values: values.map(value => value === "" ? {} : { userEnteredValue: { stringValue: value } }) });
const update = (rowIndex, columnIndex, rows) => ({ updateCells: {
  start: { sheetId, rowIndex, columnIndex }, rows: rows.map(cells), fields: "userEnteredValue"
} });

// This adapter has no entry point for an existing workbook ID, including in tests.
export async function createDisposableRosterSheet({ accessToken, fetchImpl = globalThis.fetch, initialRows = [] }) {
  if (typeof accessToken !== "string" || !accessToken.trim() || !Array.isArray(initialRows) ||
    initialRows.length > 1000 || initialRows.some(row => row.length !== scheduleColumns.length || row.some(v => typeof v !== "string"))) {
    throw Error("Invalid staging credentials or seed rows.");
  }
  async function request(url, body) {
    const response = await fetchImpl(url, {
      method: body ? "POST" : "GET",
      headers: { Authorization: "Bearer " + accessToken, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error", signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw Error("Staging Sheets request failed (HTTP " + response.status + ").");
    return response.json();
  }
  const title = "DISPOSABLE ROSTER STAGING " + randomUUID();
  const created = await request(api, {
    properties: { title, timeZone: "Asia/Colombo" },
    sheets: [{ properties: { sheetId, title: name, gridProperties: { rowCount: 2500, columnCount: scheduleColumns.length } } }]
  });
  if (!/^[A-Za-z0-9_-]+$/.test(created.spreadsheetId || "") || created.properties?.title !== title ||
    created.sheets?.length !== 1 || created.sheets[0].properties?.sheetId !== sheetId ||
    created.sheets[0].properties?.title !== name) throw Error("Unverified disposable workbook.");
  const book = api + "/" + created.spreadsheetId;
  const batch = requests => request(book + ":batchUpdate", { requests });
  const textTimes = { repeatCell: { range: { sheetId, startRowIndex: 1, startColumnIndex: 8, endColumnIndex: 10 },
    cell: { userEnteredFormat: { numberFormat: { type: "TEXT" } } }, fields: "userEnteredFormat.numberFormat" } };
  await batch([textTimes, update(0, 0, [scheduleColumns, ...initialRows])]);

  async function readRows() {
    const { values } = await request(book + "/values/" + encodeURIComponent(name + "!A1:N2500") + "?valueRenderOption=UNFORMATTED_VALUE");
    if (!Array.isArray(values) || !equal(values[0], scheduleColumns)) throw Error("Unexpected staging schedule schema.");
    return values.slice(1).map(padded);
  }
  async function targets(changes, team, month) {
    if (!Array.isArray(changes) || changes.length > 1000 || !["Affiliate", "CSP"].includes(team) || !/^20\d\d-(0[1-9]|1[0-2])$/.test(month)) {
      throw Error("Unsupported staging batch.");
    }
    const rows = await readRows(), existing = new Map(), aliases = new Map(), seen = new Set();
    const dates = new Set(datesFor(month));
    rows.forEach((row, index) => {
      const id = rowKey(row);
      existing.set(id, existing.has(id) ? null : { row, index: index + 1 });
      const alias = loginKey(row[4]) + "|" + row[2];
      aliases.set(alias, aliases.has(alias) ? null : id);
    });
    const planned = changes.map(change => {
      const row = change.after, id = row.staff_id + "|" + row.schedule_date;
      if (!/^[A-Z0-9_.-]{1,64}$/.test(row.staff_id) || row.team !== team || row.schedule_month !== month ||
        !dates.has(row.schedule_date) || seen.has(id) || existing.get(id) === null) throw Error("Ambiguous or out-of-scope staging row.");
      seen.add(id);
      return { change, existing: existing.get(id) };
    });
    return { planned, aliases, count: rows.length };
  }
  async function commitBatch(changes, team, month, directory) {
    if (!changes.length) return;
    const { planned, aliases, count } = await targets(changes, team, month);
    const staff = new Map(), logins = new Set();
    for (const person of directory) {
      const login = loginKey(person.login);
      if (!login || staff.has(person.id) || logins.has(login)) throw Error("Ambiguous staging directory.");
      staff.set(person.id, person); logins.add(login);
    }
    const requests = [], inserts = [];
    for (const { change, existing } of planned) {
      const { after, before } = change;
      const person = staff.get(after.staff_id);
      if (!person || person.team !== team || !person.login || !person.name ||
        !equal(projection(existing?.row), original(before, team))) throw Error("Staging staff or before-image changed.");
      const alias = loginKey(person.login) + "|" + after.schedule_date;
      const canonical = person.id + "|" + after.schedule_date;
      if (aliases.has(alias) && aliases.get(alias) !== canonical) throw Error("Ambiguous staging login/date.");
      if (existing && (loginKey(existing.row[4]) !== loginKey(person.login) ||
        ["AL", "SL", "UL"].includes(existing.row[7]))) throw Error("Protected leave or mismatched login.");
      const fields = [after.shift_code, after.start_time, after.end_time, after.status];
      if (existing) requests.push(update(existing.index, 7, [fields]));
      else inserts.push(["SCH-" + randomUUID(), month, after.schedule_date, person.id, person.login, person.name,
        team, ...fields, "Staging fixture", new Date().toISOString(), "Disposable staging test"]);
    }
    if (count + inserts.length >= 2500) throw Error("Staging sheet capacity exceeded.");
    if (inserts.length) requests.push(update(count + 1, 0, inserts));
    await batch(requests);
  }
  async function reconcileBatch(changes, team, month) {
    const { planned } = await targets(changes, team, month);
    if (planned.every(({ change, existing }) => equal(projection(existing?.row), expected(change.after)))) return "verified";
    if (planned.every(({ change, existing }) => equal(projection(existing?.row), original(change.before, team)))) return "not-written";
    return "uncertain";
  }
  return { id: created.spreadsheetId, title, readRows, commitBatch, reconcileBatch };
}
