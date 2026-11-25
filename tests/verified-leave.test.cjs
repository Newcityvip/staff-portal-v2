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
 let commits=0,reads=0,metadata
 const ctx={listStaffRows:()=>[{staff_id:staffId,login_id:'fixture',team,status:'ACTIVE'}],TZ:zone,getTeamTimezone:()=>zone,ss:()=>({getId:()=>1}),sh:()=>({getSheetId:()=>2}),SHEETS:{SCHEDULE:'roster'},clearSheetCache:()=>{},
   PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]})},withRosterLock_:fn=>fn(),normalizeSheetTime:s=>s,
   Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(a,b)=>Array.from(crypto.createHash(a).update(b).digest()),formatDate:(d,z,f)=>new Date(+d+19800000).toISOString().slice(...(f==='yyyy-MM-dd'?[0,10]:[11,23]))},
   Sheets:{Spreadsheets:{Values:{get:()=>{reads++;return {values:structuredClone(rows)}}},DeveloperMetadata:{search:()=>({matchedDeveloperMetadata:metadata?[{developerMetadata:metadata}]:[]})},batchUpdate:({requests})=>{
     for(const req of requests){if(req.updateCells){const u=req.updateCells;rows[u.range.startRowIndex].splice(7,4,...u.rows[0].values.map(v=>v.userEnteredValue?.stringValue||''))}
       else metadata=req.createDeveloperMetadata.developerMetadata}commits++
   }}}}
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../backend/verified-leave.gs'),'utf8'),ctx)
 return {apply:(over={})=>ctx.applyVerifiedLeave({token,expires:Date.now()+45000,change,...over}),rows,days,props,get commits(){return commits},get reads(){return reads}}
}
test('atomic batch clears times, retains notes, independently reads source and only verifies a replay',()=>{
 const f=fixture();assert.equal(f.apply().verified,true);assert.equal(f.reads,2)
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
