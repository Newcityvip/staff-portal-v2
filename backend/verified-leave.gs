// Install alongside Code.gs. Advanced Sheets service v4 is required only for write-back.
function leaveHash_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(value), Utilities.Charset.UTF_8)
    .map(b => (b & 255).toString(16).padStart(2,'0')).join('');
}
function leaveCheck_(ok) { if (!ok) throw new Error('roster_conflict'); }
function leaveDate_(v) {
  if (Number.isInteger(v)) return new Date(Date.UTC(1899,11,30)+v*86400000).toISOString().slice(0,10);
  return String(v || '').trim();
}
function leaveClock_(value) {
  if(typeof value==='number' && value>=0 && value<1)
    return new Date(Math.round(value*86400000)).toISOString().slice(11,23);
  const raw=String(value || '').trim().replace(/^'/,'');
  leaveCheck_(/^(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(raw)||/^(?:0?[1-9]|1[0-2]):[0-5]\d(?::[0-5]\d)?\s*(?:AM|PM)$/i.test(raw));
  return normalizeSheetTime(raw)+'.000';
}
function leavePlan_(rows, change, team, login, verified) {
  const zone=getTeamTimezone(team);
  const columns=['schedule_id','schedule_month','schedule_date','staff_id','login_id','full_name','team','shift_code','start_time','end_time','status','uploaded_by','uploaded_at','notes'];
  leaveCheck_(rows.length && columns.every((col,i)=>String(rows[0][i]).trim().toLowerCase()===col));
  const indexes=new Map();
  rows.slice(1).forEach((r,i)=>{
    const sameId=String(r[3]||'').trim()===change.staffId,sameLogin=String(r[4]||'').trim().toLowerCase()===login;
    if(!sameId&&!sameLogin)return;
    leaveCheck_(sameId&&sameLogin);
    const date=leaveDate_(r[2]);
    leaveCheck_(/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0,10)===date);
    if(!indexes.has(date))indexes.set(date,[]);
    indexes.get(date).push(i+1);
  });
  const seen=new Set();
  return change.days.map(day=>{
    leaveCheck_(day && /^\d{4}-\d\d-\d\d$/.test(day.date) && !seen.has(day.date) && ['AL','SL','UL'].includes(day.code));
    seen.add(day.date);
    const hits=indexes.get(day.date)||[];
    leaveCheck_(hits.length===1);
    const ix=hits[0],row=rows[ix],id=String(row[0]||'').trim();
    const status=String(row[10]||'').trim().toUpperCase(),shift=String(row[7]||'').trim().toUpperCase();
    leaveCheck_(id && String(row[6]).trim()===team && day.shiftId==='mirror-v1-'+leaveHash_([id,change.staffId,day.date]));
    if(verified){
      leaveCheck_(status===day.code && shift===day.code && (row[8]==='' || row[8]==null) && (row[9]==='' || row[9]==null));
    }else{
      leaveCheck_(status==='WORKING');
      const start=new Date(day.startsAt),end=new Date(day.endsAt);
      leaveCheck_(Number.isFinite(+start)&&Number.isFinite(+end)&&end>start&&end-start<86400000);
      leaveCheck_(Utilities.formatDate(start,zone,'yyyy-MM-dd')===day.date &&
        Utilities.formatDate(start,zone,'HH:mm:ss.SSS')===leaveClock_(row[8]) &&
        Utilities.formatDate(end,zone,'HH:mm:ss.SSS')===leaveClock_(row[9]));
      leaveCheck_(day.revision===leaveHash_(['shift-v1',id,change.staffId,team,zone,day.date,status,shift,day.startsAt,day.endsAt]));
    }
    return ix;
  });
}

function applyVerifiedLeave(body) {
  const change = body && body.change;
  if (!change || change.staffId !== 'M00277' || !Array.isArray(change.days) ||
      change.days.length !== 1 || !change.days[0] ||
      change.days[0].date !== '2026-11-27' || change.days[0].code !== 'SL') {
    return {ok:false,error:'write_disabled'};
  }
  return applyVerifiedLeave_(body, true);
}

function applyVerifiedLeave_(body, requirePilotBackup) {
  const props=PropertiesService.getScriptProperties(),secret=props.getProperty('LEAVE_WRITE_TOKEN'),team=props.getProperty('LEAVE_WRITE_TEAM');
  if(props.getProperty('LEAVE_WRITE_ENABLED')!=='true'||!team||!secret||!/^[a-f0-9]{64}$/i.test(secret)||
      typeof body.token!=='string'||body.token.length!==64)return {ok:false,error:'write_disabled'};
  let difference=0;
  for(let i=0;i<64;i++)difference|=secret.charCodeAt(i)^body.token.charCodeAt(i);
  if(difference)return {ok:false,error:'write_disabled'};
  const c=body.change;
  if(!c|| !/^[a-f0-9-]{36}$/.test(c.decisionId)|| !/^[a-f0-9-]{36}$/.test(c.requestId)||
    !Number.isSafeInteger(c.version)||c.version<1||typeof c.staffId!=='string'||!c.staffId||c.staffId.length>160||
    !Array.isArray(c.days)||!c.days.length||c.days.length>62)return {ok:false,error:'roster_conflict'};
  try {
    return withRosterLock_(function(){
      if(!Number.isSafeInteger(body.expires)||body.expires<=Date.now()||body.expires>Date.now()+60000)return {ok:false,error:'source_unavailable'};
      const book=ss(),sheet=sh(SHEETS.SCHEDULE),bookId=book.getId();
      clearSheetCache(SHEETS.STAFF);
      const staff=listStaffRows(),matches=staff.filter(s=>String(s.staff_id||'').trim()===c.staffId);
      leaveCheck_(matches.length===1 && String(matches[0].status).trim().toUpperCase()==='ACTIVE' && String(matches[0].team).trim()===team);
      const login=String(matches[0].login_id||'').trim().toLowerCase();
      leaveCheck_(login && staff.filter(s=>String(s.login_id||'').trim().toLowerCase()===login).length===1);
      const key='leave-v1:'+c.decisionId,receipt=leaveHash_(c);
      const read=()=>Sheets.Spreadsheets.Values.get(bookId,"'04_Schedule_Master'!A:N",
        {valueRenderOption:'UNFORMATTED_VALUE',dateTimeRenderOption:'SERIAL_NUMBER'}).values||[];
      const existing=Sheets.Spreadsheets.DeveloperMetadata.search({dataFilters:[{developerMetadataLookup:{metadataKey:key}}]},bookId).matchedDeveloperMetadata||[];
      if(existing.length){
        leaveCheck_(existing.length===1 && existing[0].developerMetadata.metadataValue===receipt);
      }else{
        if(requirePilotBackup) leaveCheck_(props.getProperty('NOV27_PILOT_BACKUP')===JSON.stringify(novemberPilotSnapshot_()));
        const indexes=leavePlan_(read(),c,team,login,false);
        const mutations=indexes.map((row,i)=>({updateCells:{
          range:{sheetId:sheet.getSheetId(),startRowIndex:row,endRowIndex:row+1,startColumnIndex:7,endColumnIndex:11},
          rows:[{values:[{userEnteredValue:{stringValue:c.days[i].code}},{},{},{userEnteredValue:{stringValue:c.days[i].code}}]}],
          fields:'userEnteredValue'}}));
        mutations.push({createDeveloperMetadata:{developerMetadata:{metadataId:1+(parseInt(leaveHash_(key).slice(0,8),16)%2147483646),metadataKey:key,metadataValue:receipt,
          visibility:'DOCUMENT',location:{spreadsheet:true}}}});
        if(body.expires<=Date.now())return {ok:false,error:'source_unavailable'};
        Sheets.Spreadsheets.batchUpdate({requests:mutations},bookId);
        clearSheetCache(SHEETS.SCHEDULE);
      }
      leavePlan_(read(),c,team,login,true);
      return {ok:true,verified:true,decisionId:c.decisionId};
    });
  }catch(error){return {ok:false,error:error.message==='roster_conflict'?'roster_conflict':'source_unavailable'};}
}

/** Run from the production bound editor before opening the pilot. Stores one protected before-image. */
function backupNovemberSickPilot() {
  return withRosterLock_(function () {
    const props = PropertiesService.getScriptProperties();
    const snapshot = novemberPilotSnapshot_();
    const previous = props.getProperty('NOV27_PILOT_BACKUP');
    if (previous) {
      leaveCheck_(previous === JSON.stringify(snapshot));
    } else {
      leaveCheck_(snapshot.row[10] === 'WORKING' && snapshot.row[8] && snapshot.row[9]);
      props.setProperty('NOV27_PILOT_BACKUP', JSON.stringify(snapshot));
    }
    return 'Pilot roster backup verified';
  });
}

function novemberPilotSnapshot_() {
  const book = ss().getId(), sheet = sh(SHEETS.SCHEDULE).getSheetId();
  const rows = Sheets.Spreadsheets.Values.get(book, "'04_Schedule_Master'!A:N",
    {valueRenderOption:'FORMULA',dateTimeRenderOption:'SERIAL_NUMBER'}).values || [];
  const hits = rows.map((r,i)=> String(r[3]).trim()==='M00277' && leaveDate_(r[2])==='2026-11-27' ? i : -1).filter(i=>i>=1);
  leaveCheck_(hits.length===1);
  const index=hits[0], row=rows[index];
  // Include headers, ordering and every other roster cell in the comparison.
  const protectedRows=rows.map((r,i)=>i===index ? r.slice(0,7).concat(r.slice(11)) : r);
  return {book,sheet,index,row,otherCellsHash:leaveHash_(protectedRows)};
}

function checkNovemberSickPilot() {
  const snapshot=novemberPilotSnapshot_();
  const prior=JSON.parse(PropertiesService.getScriptProperties().getProperty('NOV27_PILOT_BACKUP')||'null');
  leaveCheck_(prior && prior.book===snapshot.book && prior.sheet===snapshot.sheet &&
    prior.index===snapshot.index && prior.otherCellsHash===snapshot.otherCellsHash);
  leaveCheck_(snapshot.row[7]==='SL' && snapshot.row[10]==='SL' && !snapshot.row[8] && !snapshot.row[9]);
  return 'Verified pilot SL, cleared times and identical remaining roster cells';
}
