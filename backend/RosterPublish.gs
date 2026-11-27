// Roster-only publishing. Legacy upload and single-date mutations do not call this file.
function rosterVerifiedPublishingWindow() {
  // A script lock or editable property cannot establish exclusion of external writers.
  return false;
}

function rosterPublishRequest(props, admin, secret, data) {
  const { action, team, month } = data;
  const error = (status, message) => ({ status, body: { ok: false, message } });
  const digest = value => rosterMac(secret, "roster-publish\n" + JSON.stringify(value));
  const headerKey = "ROSTER_PUBLISH_RECEIPT";
  const readReceipt = () => JSON.parse(props.getProperty(headerKey) || "null");
  const saveReceipt = receipt => props.setProperty(headerKey, JSON.stringify(receipt));
  const recoverable = receipt => receipt?.state === "uncertain" ||
    ["pending", "reconciling"].includes(receipt?.state) && receipt.reconcileAfter <= Date.now();
  const publicReceipt = receipt => rosterReply(200, { id: receipt.id, state: recoverable(receipt) ? "uncertain" : receipt.state,
    counts: receipt.counts, canRecover: admin.role === "SUPER_ADMIN" && recoverable(receipt) });
  const owns = receipt => receipt && receipt.actor === admin.id && receipt.team === team && receipt.month === month;
  if (props.getProperty("ROSTER_PUBLISH_ENABLED") !== "1") return error(503, "Roster publishing is disabled.");
  if (!["preview", "commit", "status", "recover"].includes(action)) return error(400, "Invalid publishing action.");
  if (action !== "preview" && !/^[a-f0-9-]{36}$/i.test(data.id || "")) return error(400, "Invalid operation ID.");
  const known = readReceipt();
  if (known && known.id === data.id && !owns(known)) return error(403, "Operation is outside this scope.");
  if (action === "status") return known?.id === data.id ? publicReceipt(known) : error(404, "Operation not found.");
  if (action === "commit" && known?.id === data.id) return publicReceipt(known);
  if (action === "recover" && (admin.role !== "SUPER_ADMIN" || known?.id !== data.id || !recoverable(known))) {
    return error(403, "Recovery is not authorized.");
  }
  if (!rosterVerifiedPublishingWindow(props, team, month, action)) return error(409, "No verified exclusive publishing window.");

  function review() {
    const snapshot = rosterSnapshot(props, team, month);
    if (typeof data.sourceRevision !== "string" || data.sourceRevision !== snapshot.revision) throw Error("Schedule changed. Reopen the source and review again.");
    const approval = JSON.parse(props.getProperty("ROSTER_PUBLISH_RULES_" + team.toUpperCase() + "_" + month) || "null");
    const result = RosterPublishValidator.prepare(snapshot, team, month, approval, data.configuration, data.records);
    if (result.counts.conflicting) return result;
    const today = todayDateForTimezone(getTeamTimezone(team));
    if (result.changed.some(change => change.date < today)) throw Error("Historical schedules cannot be changed by roster publishing.");
    return { ...result, targets: rosterPublishTargets(snapshot, result.changed) };
  }

  if (action === "preview") {
    let draft;
    try { draft = review(); } catch (e) { return error(409, e.message); }
    if (draft.conflicts.length) return { status: 409, body: { ok: false, message: "Mandatory roster conflicts remain.", conflicts: draft.conflicts } };
    const id = Utilities.getUuid(), until = Date.now() + 300000;
    const ticket = until + "." + digest([admin.id, team, month, id, until, data.sourceRevision, data.configuration, data.records, draft.targets]);
    return rosterReply(200, { id, ticket, counts: draft.counts, changes: draft.changed.map(change => ({
      before: change.before && { code: change.before[0] },
      after: { staff_id: change.id, schedule_date: change.date, shift_code: change.shift }
    })) });
  }

  // Hold the shared script lock only for the journal transition, never for sheet I/O.
  function claim(receipt) {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(50)) return false;
    try {
      const current = readReceipt();
      if (action === "recover") {
        if (current?.id !== data.id || !recoverable(current)) return false;
      } else if (+ticket[1] <= Date.now() ||
        current && (!["verified", "not-written"].includes(current.state) || current.keepUntil > Date.now())) return false;
      saveReceipt(receipt);
      return true;
    } finally { lock.releaseLock(); }
  }
  const chunkKey = i => "ROSTER_PUBLISH_BEFORE_" + i;
  if (action === "recover") {
    if (!claim({ ...known, state: "reconciling", reconcileAfter: Date.now() + 600000 })) return error(409, "A publishing operation is in progress.");
    try {
      const json = Array.from({ length: known.chunks }, (_, i) => props.getProperty(chunkKey(i))).join("");
      if (!json || digest(json) !== known.journalDigest) throw Error("Incomplete operation journal.");
      const outcome = rosterPublishReadBack(JSON.parse(json), team, month);
      if (outcome === "uncertain") throw Error("Mixed or unexpected rows.");
      if (outcome === "verified") clearSheetCache(SHEETS.SCHEDULE);
      const recovered = { ...known, state: outcome, keepUntil: Date.now() + 600000 };
      saveReceipt(recovered);
      return publicReceipt(recovered);
    } catch (_) {
      saveReceipt({ ...known, state: "uncertain" });
      return error(409, "Read-back is inconclusive. Keep schedule writes paused; do not resubmit.");
    }
  }

  if (data.acknowledged !== true) return error(400, "Confirm the manual leave verification first.");
  const ticket = /^(\d{13})\.([a-f0-9]{64})$/.exec(data.ticket || "");
  if (!ticket || +ticket[1] <= Date.now() || +ticket[1] > Date.now() + 300000) return error(409, "The preview expired. Review again.");
  let draft;
  try { draft = review(); } catch (e) { return error(409, e.message); }
  if (draft.conflicts.length || !rosterEqual(ticket[2], digest([admin.id, team, month, data.id, +ticket[1],
    data.sourceRevision, data.configuration, data.records, draft.targets]))) return error(409, "The reviewed schedule changed. Review again.");

  const beforeImages = JSON.stringify(draft.targets).replace(/[^\x20-\x7e]/g, c => "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4));
  if (beforeImages.length > 90000) return error(409, "The change set exceeds the safe journal size.");
  const chunks = beforeImages.match(/.{1,7000}/g) || [];
  const receipt = { id: data.id, team, month, actor: admin.id, counts: draft.counts, state: "pending", reconcileAfter: Date.now() + 600000,
    keepUntil: Date.now() + 600000, chunks: chunks.length, journalDigest: digest(beforeImages) };
  if (!claim(receipt)) return error(409, "Another publish or retained receipt is active. Check operation status before trying again.");
  try {
    for (let i = 0; i < chunks.length; i++) props.setProperty(chunkKey(i), chunks[i]);
    if (!rosterVerifiedPublishingWindow(props, team, month, action)) throw Error("The window closed.");
    // A full fresh review while holding the persisted claim also protects against pre-claim changes.
    const fresh = review();
    if (fresh.conflicts.length || digest(fresh.targets) !== digest(draft.targets)) throw Error("Rows changed before writing.");
    rosterApplyPublishedRows(draft.targets, team, month, admin.login);
    SpreadsheetApp.flush();
    if (rosterPublishReadBack(draft.targets, team, month) !== "verified") throw Error("Read-back did not match.");
    clearSheetCache(SHEETS.SCHEDULE);
    const verified = { ...receipt, state: "verified" };
    saveReceipt(verified);
    return publicReceipt(verified);
  } catch (_) {
    const uncertain = { ...receipt, state: "uncertain" };
    saveReceipt(uncertain);
    return { status: 503, body: { ok: false, id: data.id, state: uncertain.state,
      canRecover: admin.role === "SUPER_ADMIN", message: "Write not verified. Check status before any retry." } };
  }
}

function rosterPublishGrid() {
  const sheet = sh(SHEETS.SCHEDULE), grid = sheet.getDataRange(), rows = grid.getValues();
  const required = ["schedule_id", "schedule_month", "schedule_date", "staff_id", "login_id", "full_name", "team",
    "shift_code", "start_time", "end_time", "status", "uploaded_by", "uploaded_at", "notes"];
  if (required.some((header, i) => clean(rows[0]?.[i]).toLowerCase() !== header)) throw Error("Unverified Schedule Master layout.");
  const identities = new Map(), aliases = new Map();
  rows.slice(1).forEach(function (row, i) {
    const date = normalizeDateKey(row[2]);
    const id = safeUpper(row[3]) + "|" + date, alias = clean(row[4]).toLowerCase() + "|" + date;
    identities.set(id, identities.has(id) ? -1 : i + 2);
    aliases.set(alias, aliases.has(alias) ? -1 : i + 2);
  });
  return { sheet, rows, grid, identities, aliases };
}

function rosterPublishTargets(snapshot, changes) {
  const { rows, grid, identities, aliases } = rosterPublishGrid();
  const staff = new Map(), logins = new Set(), formulas = grid.getFormulas();
  const directory = rosterSheetValues(SHEETS.STAFF);
  const fields = rosterColumns(directory, ["staff_id", "login_id"]);
  const globalIds = new Map(), globalLogins = new Map();
  directory.slice(1).forEach(function (row) {
    const id = safeUpper(row[fields.staff_id]), login = clean(row[fields.login_id]).toLowerCase();
    if (id) globalIds.set(id, 1 + (globalIds.get(id) || 0));
    if (login) globalLogins.set(login, 1 + (globalLogins.get(login) || 0));
  });
  for (const p of snapshot.staff) {
    const id = safeUpper(p.staff_id), login = clean(p.login_id).toLowerCase();
    if (staff.has(id) || !login || logins.has(login) || globalLogins.get(login) !== 1 || globalIds.get(id) !== 1) {
      throw Error("Ambiguous staff ID or login.");
    }
    staff.set(id, p); logins.add(login);
  }
  return changes.map(function (change) {
    const person = staff.get(change.id), login = clean(person.login_id);
    const index = identities.get(change.id + "|" + change.date), alias = aliases.get(login.toLowerCase() + "|" + change.date);
    if (index === -1 || alias !== index || Boolean(index) !== Boolean(change.before)) throw Error("Ambiguous schedule identity.");
    const old = index && rows[index - 1];
    if (old && (clean(old[6]).toLowerCase() !== snapshot.team.toLowerCase() || normalizeMonthKey(old[1]) !== snapshot.month ||
      !clean(old[0]) || formulas[index - 1].slice(0, 11).some(Boolean) || ["AL", "SL", "UL"].includes(safeUpper(old[7])) ||
      JSON.stringify(rosterShiftValues(old)) !== JSON.stringify(change.before))) throw Error("Existing row changed or is protected.");
    for (const value of [person.staff_id, person.login_id, person.full_name]) {
      if (/^\s*[=+@-]/.test(value)) throw Error("Unsafe schedule cell text.");
    }
    return { id: change.id, login, name: person.full_name, staffId: person.staff_id, date: change.date,
      row: index || 0, scheduleId: old ? clean(old[0]) : "", before: old ? change.before : null,
      rawBefore: old ? old.slice(7, 11).map(value => Object.prototype.toString.call(value) === "[object Date]" ?
        { type: "date", millis: value.getTime() } : value) : null, after: [change.shift, change.start, change.end, change.status] };
  });
}

function rosterShiftValues(row) {
  return [safeUpper(row[7]), normalizeSheetTime(row[8]), normalizeSheetTime(row[9]), safeUpper(row[10])];
}

function rosterApplyPublishedRows(targets, team, month, actor) {
  if (!targets.length) return;
  const sheet = sh(SHEETS.SCHEDULE), inserted = [], updated = [];
  const values = target => [target.after[0], normalizeScheduleTimeForSheet(target.after[1]),
    normalizeScheduleTimeForSheet(target.after[2]), target.after[3]];
  const start = sheet.getLastRow() + 1;
  if (start - 1 + targets.filter(t => !t.row).length > sheet.getMaxRows()) throw Error("Schedule sheet has insufficient rows.");
  for (const target of targets) {
    if (target.row) updated.push({ row: target.row, values: values(target) });
    else inserted.push([makeId("SCH"), month, target.date, target.staffId, target.login, target.name, team,
      ...values(target), /^[\s]*[=+@-]/.test(actor) ? "'" + actor : actor, nowDateTime(), "Monthly roster publish"]);
  }
  updated.sort((a, b) => a.row - b.row);
  for (let i = 0; i < updated.length;) {
    const startRow = updated[i].row, batch = [updated[i++].values];
    while (i < updated.length && updated[i].row === startRow + batch.length) batch.push(updated[i++].values);
    sheet.getRange(startRow, 8, batch.length, 4).setValues(batch);
  }
  if (inserted.length) sheet.getRange(start, 1, inserted.length, 14).setValues(inserted);
}

function rosterPublishReadBack(targets, team, month) {
  const { rows, identities, aliases } = rosterPublishGrid();
  let before = true, after = true;
  for (const target of targets) {
    const index = identities.get(target.id + "|" + target.date);
    const alias = aliases.get(target.login.toLowerCase() + "|" + target.date);
    if (index === -1 || alias !== index) return "uncertain";
    if (!index) { if (target.before) before = false; after = false; continue; }
    const row = rows[index - 1];
    if (!clean(row[0]) || target.scheduleId && clean(row[0]) !== target.scheduleId ||
      clean(row[6]).toLowerCase() !== team.toLowerCase() || normalizeMonthKey(row[1]) !== month) return "uncertain";
    const actual = JSON.stringify(rosterShiftValues(row));
    before = before && actual === JSON.stringify(target.before);
    after = after && actual === JSON.stringify(target.after);
  }
  return after ? "verified" : before ? "not-written" : "uncertain";
}
