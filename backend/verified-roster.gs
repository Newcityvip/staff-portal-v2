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

function verifiedRosterRequest_(body) {
  const props=PropertiesService.getScriptProperties();
  const token=props.getProperty('LEAVE_WRITE_TOKEN');
  if(props.getProperty('LEAVE_WRITE_ENABLED')!=='true' || !/^[a-f0-9]{64}$/i.test(token||'') ||
      typeof body.token!=='string' || body.token.length!==64) return {ok:false,error:'write_disabled'};
  let delta=0;
  for(let i=0;i<64;i++) delta|=token.charCodeAt(i)^body.token.charCodeAt(i);
  if(delta) return {ok:false,error:'write_disabled'};
  const c=body.change, uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  try {
    leaveCheck_(c && uuid.test(c.decisionId) && uuid.test(c.requestId) && Number.isSafeInteger(c.version) &&
      c.version>=1 && typeof c.staffId==='string' && c.staffId===c.staffId.trim() && c.staffId.length>0 &&
      c.staffId.length<=160 && Array.isArray(c.days) && c.days.length>0 && c.days.length<=62);
    const fresh=()=>Number.isSafeInteger(body.expires) && body.expires>Date.now() && body.expires<=Date.now()+60000;
    if(!fresh()) return {ok:false,error:'source_unavailable'};
    const outcome=withRosterWriter_(function(book,beginWrite) {
      if(!fresh()) return {ok:false,error:'source_unavailable'};
      clearSheetCache(SHEETS.STAFF);
      const people=listStaffRows(),matches=people.filter(s=>clean(s.staff_id)===c.staffId);
      leaveCheck_(matches.length===1 && safeUpper(matches[0].status)==='ACTIVE');
      const team=clean(matches[0].team),login=clean(matches[0].login_id).toLowerCase();
      leaveCheck_(team && login && people.filter(s=>clean(s.login_id).toLowerCase()===login).length===1);
      const hash=leaveHash_(c), entries=rosterReceipts_(book);
      const forDecision=records=>records.filter(record=>record.decision===c.decisionId);
      const prior=forDecision(entries);
      if(prior.length) leaveCheck_(prior.length===1 && prior[0].hash===hash);
      else if(body.action!=='v2_dispatch_verified_leave') return {ok:false,error:'roster_conflict'};
      const sheet=sh(SHEETS.SCHEDULE), sheetId=sheet.getSheetId(),range="'04_Schedule_Master'!A:N";
      const read=()=>Sheets.Spreadsheets.Values.get(book,range,
        {valueRenderOption:'UNFORMATTED_VALUE',dateTimeRenderOption:'SERIAL_NUMBER'}).values||[];
      if(!prior.length) {
        const isProtected=protectedRosterDays_(book,entries);
        const rows=read(),indexes=leavePlan_(rows,c,team,login,false);
        const formulas=Sheets.Spreadsheets.Values.get(book,range,{valueRenderOption:'FORMULA'}).values||[];
        const merged=sheet.getRange(1,8,rows.length,4).getMergedRanges();
        const batch=[];
        indexes.forEach((ix,i)=>{
          const day=c.days[i];
          leaveCheck_(!isProtected(c.staffId,login,day.date) && formulas[ix] &&
            !formulas[ix].slice(7,11).some(v=>typeof v==='string' && v.startsWith('=')) &&
            !merged.some(r=>r.getRow()<=ix+1 && r.getLastRow()>=ix+1));
          batch.push({updateCells:{range:{sheetId,startRowIndex:ix,endRowIndex:ix+1,startColumnIndex:7,endColumnIndex:11},
            rows:[{values:[{userEnteredValue:{stringValue:day.code}},{},{},{userEnteredValue:{stringValue:day.code}}]}],fields:'userEnteredValue'}});
        });
        batch.push(rosterReceiptAppend_(c,login,hash));
        if(!fresh())return {ok:false,error:'source_unavailable'};
        const committed=beginWrite();
        Sheets.Spreadsheets.batchUpdate({requests:batch},book);
        committed();
        clearSheetCache(SHEETS.SCHEDULE);
      }
      leavePlan_(read(),c,team,login,true);
      const receipt=forDecision(rosterReceipts_(book));
      leaveCheck_(receipt.length===1 && receipt[0].hash===hash);
      return {ok:true,verified:true,hash,decisionId:c.decisionId};
    });
    if(outcome.error==='roster_busy') return {ok:false,error:'roster_busy',decisionId:c.decisionId,hash:leaveHash_(c)};
    return outcome;
  }catch(err){return {ok:false,error:err.message==='roster_conflict'?'roster_conflict':'source_unavailable'};}
}
