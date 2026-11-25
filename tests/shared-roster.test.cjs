const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path')
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex')
const token='a'.repeat(64),date='2026-11-23',staffId='TEST',team='Pilot',zone='Asia/Colombo'
function fixture(){
 const rows=[['schedule_id','schedule_month','schedule_date','staff_id','login_id','full_name','team','shift_code','start_time','end_time','status','uploaded_by','uploaded_at','notes']]
 const days=[date,'2026-11-24'].map((d,i)=>{
   rows.push(['shared','2026-11',d,staffId,'fixture','Test',team,'AM','09:30:00','18:30:00','WORKING','','','retain'])
   const startsAt=d+'T04:00:00.000Z',endsAt=d+'T13:00:00.000Z'
   return {date:d,code:i?'UL':'AL',shiftId:'mirror-v1-'+hash(['shared',staffId,d]),revision:hash(['shift-v1','shared',staffId,team,zone,d,'WORKING','AM',startsAt,endsAt]),startsAt,endsAt}
 })
 const change={decisionId:crypto.randomUUID(),requestId:crypto.randomUUID(),version:1,staffId,days}
 const props={LEAVE_WRITE_ENABLED:'true',LEAVE_WRITE_TEAM:team,LEAVE_WRITE_TOKEN:token}
 let commits=0,reads=0; const markers=new Map(),audit=[['action','module','target_id','old_value','new_value']]; let serial=1
 const ctx={listStaffRows:()=>[{staff_id:staffId,login_id:'fixture',team,status:'ACTIVE'}],TZ:zone,getTeamTimezone:()=>zone,ss:()=>({getId:()=>1}),sh:()=>({getSheetId:()=>2,getRange:()=>({getMergedRanges:()=>[]})}),SHEETS:{SCHEDULE:'roster'},clearSheetCache:()=>{},
   PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]})},withRosterLock_:fn=>fn(),normalizeSheetTime:s=>s,
   SpreadsheetApp:{flush:()=>{}},clean:v=>String(v??"").trim(),safeUpper:v=>String(v).toUpperCase(),Utilities:{getUuid:crypto.randomUUID,sleep:()=>{},DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(a,b)=>Array.from(crypto.createHash(a).update(b).digest()),formatDate:(d,z,f)=>new Date(+d+19800000).toISOString().slice(...(f==='yyyy-MM-dd'?[0,10]:[11,23]))},
   Sheets:{Spreadsheets:{Values:{get:(_,range)=>{if(range.includes('Audit_Log'))return {values:structuredClone(audit)};reads++;return {values:structuredClone(rows)}}},DeveloperMetadata:{search:({dataFilters})=>({matchedDeveloperMetadata:[...markers.values()].filter(m=>matches(m,dataFilters[0].developerMetadataLookup)).map(developerMetadata=>({developerMetadata}))})},batchUpdate:({requests})=>{
      for(const req of requests){
        if(req.appendCells)audit.push(req.appendCells.rows[0].values.slice(5,10).map(c=>c.userEnteredValue.stringValue));
        if(req.updateCells){const u=req.updateCells;rows[u.range.startRowIndex].splice(7,4,...u.rows[0].values.map(v=>v.userEnteredValue?.stringValue||''))}
        if(req.createDeveloperMetadata){const m={...req.createDeveloperMetadata.developerMetadata};m.metadataId??=serial++;if(markers.has(m.metadataId))throw Error('occupied');markers.set(m.metadataId,m)}
        if(req.deleteDeveloperMetadata){const lookup=req.deleteDeveloperMetadata.dataFilter.developerMetadataLookup;for(const [id,m] of markers)if(matches(m,lookup))markers.delete(id)}
      }
      if(requests.some(r=>r.updateCells))commits++
   }}}}
 function matches(m,lookup){return Object.entries(lookup).every(([k,v])=>m[k]===v)}
 for(const file of ['roster-coordination','verified-roster'])vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../backend/'+file+'.gs'),'utf8'),ctx)
 return {ctx,change,markers,audit,apply:(over={})=>ctx.verifiedRosterRequest_({action:'v2_dispatch_verified_leave',token,expires:Date.now()+45000,change,...over}),rows,days,props,get commits(){return commits},get reads(){return reads}}
}
test('atomic batch clears times, retains notes, independently reads source and only verifies a replay',()=>{
 const f=fixture();assert.equal(f.apply().verified,true);assert.equal(f.reads,3)
 assert.deepEqual(f.rows[1].slice(7,11),['AL','','','AL']);assert.deepEqual(f.rows[2].slice(7,11),['UL','','','UL'])
 assert.equal(f.rows[1][13],'retain');assert.equal(f.apply().verified,true);assert.equal(f.commits,1)
 f.rows[2][10]='OFF';assert.equal(f.apply().error,'roster_conflict');assert.equal(f.commits,1)
})
test('closed on invalid credentials, expiry, duplicate identity/date, changed revision and OFF',()=>{
 const f=fixture();assert.equal(f.apply({token:'bad'}).ok,false);assert.equal(f.apply({expires:1}).ok,false);assert.equal(f.reads,0)
 for(const alter of [g=>g.rows.push([...g.rows[2]]),g=>g.rows[2][10]='OFF',g=>g.rows[2][4]='different',g=>g.rows[1][8]='10:00:00',g=>g.days[0].revision='old',g=>g.days[0].code='VL']){
   const g=fixture();alter(g);assert.equal(g.apply().error,'roster_conflict');assert.equal(g.commits,0)
 }
})

test('read-back accepts cleared API cells and rejects any populated leave time',()=>{
 const f=fixture();assert.equal(f.apply().verified,true)
 f.rows[1][8]=null;f.rows[1][9]=null;assert.equal(f.apply().verified,true)
 f.rows[1][8]=0;assert.equal(f.apply().error,'roster_conflict');assert.equal(f.commits,1)
})


test('contended request cannot enter, verify cannot dispatch, owner releases independently of attendance',()=>{
 const f=fixture()
 f.ctx.withRosterWriter_(()=>{
   const busy=f.apply()
   assert.equal(busy.error,'roster_busy');assert.equal(busy.hash,hash(f.change));assert.equal(f.commits,0)
 })
 assert.equal(f.apply({action:'v2_verify_leave_receipt'}).error,'roster_conflict')
 assert.equal(f.apply().verified,true)
 const guards=f.ctx.protectedRosterDays_(1)
 assert.equal(guards('TEST','fixture',date),true);assert.equal(guards('M00277','','2026-11-27'),true)
 assert.equal(guards('OTHER','other',date),false)
 assert.equal(f.apply({action:'v2_verify_leave_receipt'}).verified,true)
 assert.equal(f.commits,1)
})
test('uncertain external write retains ownership and blocks subsequent mutations',()=>{
 const f=fixture();assert.throws(()=>f.ctx.withRosterWriter_((_,begin)=>{begin();throw Error('unknown commit')}))
 assert.equal(f.apply().error,'roster_busy');assert.equal(f.commits,0)
})
test('all three administrative entry points preserve approved leave and process ordinary rows',()=>{
 const f=fixture();assert.equal(f.apply().verified,true)
 const ctx=f.ctx;const staff={staff_id:'TEST',full_name:'Test',login_id:'fixture',email:'fixture@example.invalid',team}
 for(const file of ['Code','admin-backend-upgrade'])vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../backend/'+file+'.gs'),'utf8'),ctx)
 const writes=[]
 const sheet={getDataRange:()=>({getValues:()=>f.rows}),getLastRow:()=>f.rows.length,getRange:(...r)=>({setNumberFormat(){return this},setValues:v=>writes.push([r,v]),setValue:v=>writes.push([r,v])}),appendRow:r=>writes.push(r)}
 Object.assign(ctx,{ss:()=>({getId:()=>1}),sh:()=>sheet,clearSheetCache:()=>{},getValues:()=>[[],['TEST','Test','fixture','',team]],listStaffRows:()=>[staff],requireAllowedIp:()=>null,isAllowedIP:()=>true,appendAudit:()=>{},nowDateTime:()=>'',makeId:()=>'id',getScheduleUploadAccess:()=>({ok:true}),normalizeDateKey:x=>x})
 const rows=[date,'2026-11-25'].map(schedule_date=>({schedule_date,staff_id:'TEST',login_id:'fixture',shift_code:'OFF',status:'OFF'}))
 const legacy=ctx.importSchedule({rows});assert.equal(legacy.inserted,1);assert.equal(legacy.skipped.length,1)
 const single=ctx.updateSingleStaffSchedule({login_id:'fixture',schedule_date:date,shift_code:'OFF'})
 assert.equal(single.ok,false);assert.match(single.message,/Approved leave/)
 const csv=ctx.uploadScheduleCsv({rows});assert.equal(csv.inserted,1);assert.equal(csv.protected_dates.length,1)
 assert.deepEqual(f.rows[1].slice(7,11),['AL','','','AL']);assert.ok(writes.length>0)
})

test('receipt verification cannot rewrite a restored shift or infer success after audit loss',()=>{
 const f=fixture(),original=[...f.rows[1]]
 assert.equal(f.apply().verified,true)
 f.rows[1]=original
 assert.equal(f.apply({action:'v2_verify_leave_receipt'}).error,'roster_conflict')
 assert.equal(f.apply().error,'roster_conflict')
 f.audit.splice(1)
 assert.equal(f.apply({action:'v2_verify_leave_receipt'}).error,'roster_conflict')
 assert.deepEqual(f.rows[1],original);assert.equal(f.commits,1)
})
