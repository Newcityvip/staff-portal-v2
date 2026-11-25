// Shared only by roster mutations. Spreadsheet-scoped metadata IDs are unique.
const ROSTER_MUTEX_ID_ = 1743905601;
const ROSTER_MUTEX_KEY_ = 'leave.v1.roster_mutex';
const ROSTER_RECEIPT_ACTION_ = 'APPROVED_LEAVE_APPLIED';

function rosterMetadata_(book, lookup) {
  const result = Sheets.Spreadsheets.DeveloperMetadata.search(
    {dataFilters:[{developerMetadataLookup:lookup}]},book);
  return (result.matchedDeveloperMetadata || []).map(hit => hit.developerMetadata);
}
function rosterMarker_(key, value, id) {
  const metadata = {metadataKey:key,metadataValue:value,location:{spreadsheet:true},visibility:'PROJECT'};
  if (id) metadata.metadataId = id;
  return {createDeveloperMetadata:{developerMetadata:metadata}};
}
function withRosterWriter_(work) {
  const book = ss().getId(), owner = Utilities.getUuid();
  const lookup = {metadataId:ROSTER_MUTEX_ID_,metadataKey:ROSTER_MUTEX_KEY_,metadataValue:owner,visibility:'PROJECT'};
  // No lease expiry: a slow importer cannot lose ownership mid-write.
  for (let attempt=0;;attempt++) {
    try {
      Sheets.Spreadsheets.batchUpdate({requests:[rosterMarker_(ROSTER_MUTEX_KEY_,owner,ROSTER_MUTEX_ID_)]},book);
      break;
    } catch (error) {
      const locks = rosterMetadata_(book,{metadataId:ROSTER_MUTEX_ID_});
      if (locks.length===1 && locks[0].metadataKey===ROSTER_MUTEX_KEY_ && locks[0].metadataValue===owner) break;
      if (!locks.length || locks[0].metadataKey!==ROSTER_MUTEX_KEY_) throw error;
      if (attempt>=4) return {ok:false,error:'roster_busy',message:'Roster update in progress. Please retry.'};
      Utilities.sleep(250 + Math.floor(Math.random()*200));
    }
  }
  // Exceptions after a write was issued can mean an uncertain commit. Retain
  // the marker for reconciliation; never let a timeout admit another writer.
  let uncertain=false;
  function beginWrite() {
    uncertain=true;
    return function confirmed() { uncertain=false; };
  }
  try {
    const result=work(book,beginWrite);
    SpreadsheetApp.flush();
    uncertain=false;
    return result;
  } finally {
    if (!uncertain) Sheets.Spreadsheets.batchUpdate({requests:[{deleteDeveloperMetadata:{dataFilter:{developerMetadataLookup:lookup}}}]},book);
  }
}
// Existing audit layout from appendAudit(): F action, G module, H target, J new value.
function rosterReceipts_(book) {
  const rows=Sheets.Spreadsheets.Values.get(book,"'11_Audit_Log'!F:J",{valueRenderOption:'UNFORMATTED_VALUE'}).values || [];
  const header=(rows[0] || []).map(v=>clean(v).toLowerCase());
  if(header[0]!=='action'||header[1]!=='module'||header[2]!=='target_id'||header[4]!=='new_value') throw Error('Audit schema mismatch');
  return rows.slice(1).filter(r=>r[0]===ROSTER_RECEIPT_ACTION_ && r[1]==='LEAVE').map(r=>{
    const value=JSON.parse(r[4]);
    if(!r[2] || !/^[a-f0-9]{64}$/.test(value.hash) || !value.staff || !value.login ||
        !Array.isArray(value.dates) || !value.dates.length || !value.dates.every(d=>/^\d{4}-\d\d-\d\d$/.test(d))) throw Error('Invalid leave receipt');
    return {...value,decision:r[2]};
  });
}
function rosterReceiptAppend_(change,login,hash) {
  const evidence={hash,staff:change.staffId,login,dates:change.days.map(day=>day.date)};
  const cells=['AUD-'+Utilities.getUuid(),new Date().toISOString(),'SYSTEM','leave-management','Leave Management',
    ROSTER_RECEIPT_ACTION_,'LEAVE',change.decisionId,'',JSON.stringify(evidence),'','Verified leave write'];
  return {appendCells:{sheetId:sh(SHEETS.AUDIT).getSheetId(),fields:'userEnteredValue',
    rows:[{values:cells.map(text=>({userEnteredValue:{stringValue:text}}))}]}};
}
function protectedRosterDays_(book,receipts) {
  // The completed standalone pilot has no workbook marker. Preserve it without
  // replaying the decision, claiming a new receipt or modifying historical data.
  const keys = new Set([JSON.stringify(['staff','M00277','2026-11-27'])]);
  for (const entry of receipts || rosterReceipts_(book)) {
    for (const date of entry.dates) {
      keys.add(JSON.stringify(['staff',entry.staff,date]));
      keys.add(JSON.stringify(['login',entry.login,date]));
    }
  }
  return (staff,login,date) => keys.has(JSON.stringify(['staff',clean(staff),date])) ||
    keys.has(JSON.stringify(['login',clean(login).toLowerCase(),date]));
}
