import { createHash, randomUUID } from "node:crypto";
import { contextFor, datesFor, key } from "../js/roster-model.js";
import { prepareRosterSource, publicationConfiguration, sourceDraft } from "../js/roster-source.js";
import { validate } from "../js/roster-generator.js";

const digest = value => createHash("sha256").update(JSON.stringify(value, (_, item) =>
  item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest("hex");
const leave = new Set(["AL", "SL", "UL"]);
const reply = (status, body) => ({ status, body: { ok: status < 400, ...body } });
const deny = (status, message) => reply(status, { message });
const exact = (a, b) => digest(a) === digest(b);
const dateInScope = (date, month) => datesFor(month).includes(date);

export function createRosterPublisher({ readSource, readConfiguration, windowVerified, commitBatch, reconcileBatch,
  rollbackBatch, journal, invalidate = () => {}, now = Date.now }) {
  const previews = new Map();
  let busy = false;
  const allowed = (actor, team) => actor?.active && ["SUPER_ADMIN", "CSP_ADMIN"].includes(actor.role) &&
    (team === "CSP" || team === "Affiliate" && actor.role === "SUPER_ADMIN");
  function plan(source, model, records) {
    const context = contextFor(model, source.team, source.month);
    const eligible = new Set(source.staff.filter(p => !p.exclusion).map(p => p.id));
    const loginById = new Map(), loginIds = new Set();
    for (const p of source.staff) {
      const login = p.login.trim().toLowerCase();
      if (!login || loginIds.has(login)) throw Error("Ambiguous login alias.");
      loginIds.add(login); loginById.set(p.id, login);
    }
    const before = new Map(source.rows.map(row => [key(row.id, row.date), row]));
    const shifts = new Map(source.catalog.map(shift => [shift.id, shift]));
    const cells = { ...context.draft.cells }, seen = new Set();
    const configured = new Set(context.people.map(p => p.id));
    const changes = [], summary = { new: 0, updated: 0, unchanged: 0, conflicting: 0 };
    for (const row of records) {
      if (!row || Object.keys(row).sort().join(",") !== "date,shift,staffId" || !eligible.has(row.staffId) ||
        !configured.has(row.staffId) || !loginById.has(row.staffId) || !dateInScope(row.date, source.month) || !shifts.has(row.shift)) {
        throw Error("Invalid staff, date, or shift in this scope.");
      }
      const id = key(row.staffId, row.date), old = before.get(id), shift = shifts.get(row.shift);
      if (seen.has(id)) throw Error("Duplicate staff/date in draft.");
      seen.add(id);
      if (old && leave.has(old.code) && old.code !== row.shift) throw Error("Published leave cannot be replaced.");
      cells[id] = row.shift;
      if (old?.code === row.shift) { summary.unchanged++; continue; }
      summary[old ? "updated" : "new"]++;
      changes.push({ before: old || null, after: { team: source.team, staff_id: row.staffId, schedule_month: source.month,
        schedule_date: row.date, shift_code: shift.id, start_time: shift.start, end_time: shift.end,
        status: shift.kind === "work" ? "WORKING" : shift.id } });
    }
    const result = validate(context, cells);
    return { summary: { ...summary, conflicting: result.errors.length }, changes, errors: result.errors.map(e => e.label).slice(0, 15) };
  }
  async function inputs(actor, team, month, records, configuration) {
    const payload = await readSource(team, month);
    const source = prepareRosterSource(payload, team, month);
    if (!source.usable) throw Error("Ambiguous or inconsistent schedule source.");
    const model = await readConfiguration(source);
    if (!configuration || !exact(configuration, publicationConfiguration(contextFor(model, team, month)))) {
      throw Error("Draft configuration does not match the server-approved configuration.");
    }
    return { ...plan(source, model, records), revision: source.revision, fingerprint: digest([actor.id, payload, model, records, configuration]) };
  }
  function publicOperation(operation) {
    return { id: operation.id, state: operation.state, counts: operation.summary };
  }
  return async function publish(actor, request) {
    if (!request || !allowed(actor, request.team)) return deny(403, "Publishing is not authorized for this team.");
    if (typeof request.month !== "string" || !/^20\d\d-(0[1-9]|1[0-2])$/.test(request.month)) return deny(400, "Invalid month.");
    const { action, team, month } = request;
    const known = request.id && await journal.get(request.id);
    if (known && (known.actor !== actor.id || known.team !== team || known.month !== month)) return deny(403, "Operation is outside this scope.");
    if (action === "status") return known ? reply(200, publicOperation(known)) : deny(404, "Operation not found.");
    if (action === "preview") {
      if (!Array.isArray(request.records) || !request.records.length || request.records.length > 6200) return deny(400, "Invalid roster size.");
      try {
        const data = await inputs(actor, team, month, request.records, request.configuration);
        if (request.sourceRevision !== data.revision) return deny(409, "Source schedule is stale. Reopen the source and review again.");
        if (data.errors.length) return reply(409, { message: "Mandatory roster conflicts remain.", counts: data.summary, conflicts: data.errors });
        for (const [id, item] of previews) if (item.until <= now()) previews.delete(id);
        if (previews.size >= 100) return deny(429, "Too many pending previews.");
        const id = randomUUID();
        previews.set(id, { ...data, id, team, month, actor: actor.id, records: structuredClone(request.records),
          configuration: structuredClone(request.configuration), until: now() + 300000 });
        return reply(200, { id, counts: data.summary, changes: data.changes });
      } catch (error) { return reply(409, { message: error.message, counts: { new: 0, updated: 0, unchanged: 0, conflicting: 1 } }); }
    }
    if (!["commit", "recover", "rollback"].includes(action)) return deny(400, "Invalid publishing action.");
    if (known && action === "commit") return reply(200, publicOperation(known));
    const preview = previews.get(request.id);
    if (action === "commit" && (!preview || preview.until <= now() || preview.actor !== actor.id || preview.month !== month || preview.team !== team)) {
      return deny(409, "Preview expired or changed. Review the roster again.");
    }
    if (action === "commit" && request.acknowledged !== true) return deny(400, "Confirm the manual leave verification first.");
    if (action === "recover" && (actor.role !== "SUPER_ADMIN" || !known || !["uncertain", "pending", "rollback-pending"].includes(known.state))) {
      return deny(403, "Recovery is not authorized.");
    }
    if (action === "rollback" && (actor.role !== "SUPER_ADMIN" || known?.state !== "verified" ||
      request.acknowledged !== true || !rollbackBatch)) return deny(403, "Rollback is not authorized.");
    if (busy) return deny(409, "A schedule write is already in progress.");
    busy = true;
    let operation;
    try {
      if (!await windowVerified(team, month)) return deny(409, "No verified publishing window.");
      if (action === "recover") {
        const outcome = await reconcileBatch(known.changes, team, month);
        if (!["verified", "not-written"].includes(outcome)) return deny(409, "Schedule differs from both expected states; keep publishing paused.");
        const state = known.state === "rollback-pending" && outcome === "not-written" ? "rolled-back" : outcome;
        await invalidate(team, month);
        await journal.put({ ...known, state });
        return reply(200, publicOperation({ ...known, state }));
      }
      if (await journal.unresolved()) return deny(409, "Resolve the previous uncertain schedule write first.");
      if (action === "rollback") {
        if (known.changes.length && await reconcileBatch(known.changes, team, month) !== "verified") {
          return deny(409, "Rows no longer match the operation. Nothing was restored.");
        }
        operation = { ...known, state: "rollback-pending" };
        await journal.put(operation);
        if (known.changes.length) {
          await rollbackBatch(known.changes, team, month);
          if (await reconcileBatch(known.changes, team, month) !== "not-written") throw Error("Rollback read-back differed");
        }
        await invalidate(team, month);
        await journal.put({ ...operation, state: "rolled-back" });
        return reply(200, publicOperation({ ...operation, state: "rolled-back" }));
      }
      const fresh = await inputs(actor, team, month, preview.records, preview.configuration);
      if (!exact(fresh.fingerprint, preview.fingerprint) || fresh.errors.length) return deny(409, "Schedule or rules changed. Review again.");
      operation = { ...fresh, id: preview.id, team, month, actor: actor.id, state: "pending", timestamp: now() };
      await journal.put(operation);
      if (fresh.changes.length) {
        await commitBatch(fresh.changes, team, month);
        if (await reconcileBatch(fresh.changes, team, month) !== "verified") throw Error("Read-back differed");
      }
      await invalidate(team, month);
      await journal.put({ ...operation, state: "verified" });
      previews.delete(preview.id);
      return reply(200, publicOperation({ ...operation, state: "verified" }));
    } catch {
      if (!operation) return deny(409, "Schedule or validation inputs unavailable. Review again.");
      try { await journal.put({ ...operation, state: operation.state === "rollback-pending" ? "rollback-pending" : "uncertain" }); } catch { /* retain pending journal */ }
      return reply(503, { id: operation.id, state: "uncertain", message: "Write outcome is uncertain. Reconcile before trying again." });
    } finally { busy = false; }
  };
}

export function fixturePublishConfiguration(source) {
  return sourceDraft(source, source.staff.filter(p => !p.exclusion).map(p => p.id));
}
