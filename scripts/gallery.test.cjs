const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {spawn}=require('node:child_process');const net=require('node:net');const jwt=require('jsonwebtoken');const bcrypt=require('bcryptjs');
const root=path.resolve(__dirname,'..');
async function main(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'metro-gallery-'));const secret='gallery-isolated-fixture-secret';
  const users=['owner','other','admin'].map(id=>({id,email:`${id}@example.test`,emailVerified:true,username:`测试${id}`,phone:'',passwordHash:bcrypt.hashSync('fixture-password',4)}));
  fs.writeFileSync(path.join(directory,'db.json'),JSON.stringify({users,maps:[],seq:{user:4,map:1}}));
  const port=await new Promise(resolve=>{const n=net.createServer();n.listen(0,'127.0.0.1',()=>{const p=n.address().port;n.close(()=>resolve(p));});});
  const server=spawn(process.execPath,[path.join(root,'server/index.js')],{env:{...process.env,PORT:String(port),METRO_DATA_DIR:directory,JWT_SECRET:secret,DATABASE_URL:'',NODE_ENV:'test',GALLERY_ADMIN_EMAILS:'admin@example.test',RESEND_API_KEY:''},stdio:['ignore','pipe','pipe']});let logs='';server.stdout.on('data',x=>logs+=x);server.stderr.on('data',x=>logs+=x);
  const base=`http://127.0.0.1:${port}`;
  const req=async(method,url,user,body)=>{const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(user?{Authorization:`Bearer ${jwt.sign({userId:user,purpose:'login'},secret)}`}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json().catch(()=>null);return {status:r.status,data};};
  try{
    for(let i=0;i<80;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
    const list=await req('GET','/api/gallery/works');assert.equal(list.status,200);assert.equal(list.data.total,6);assert.ok(list.data.works.every(w=>w.example&&w.allowFork&&!w.snapshot&&!w.sourceMapId&&!w.author.email));
    const expired=await fetch(base+'/api/gallery/works',{headers:{Authorization:'Bearer expired-token'}});assert.equal(expired.status,200);
    const seed=list.data.works[0];const detail=(await req('GET',`/api/gallery/works/${seed.id}`)).data.work;assert.ok(detail.snapshot.stations.length>40);assert.equal(detail.snapshot.lines.length,detail.counts.lines);
    const cover=await fetch(base+`/api/gallery/works/${seed.id}/cover`);assert.equal(cover.status,200);assert.match(cover.headers.get('content-type'),/image\/svg/);assert.ok((await cover.text()).includes('<polyline'));
    assert.equal((await req('GET','/api/gallery/works?q=无匹配')).data.total,0);
    assert.equal((await req('GET','/api/gallery/mine')).status,401);assert.equal((await req('GET','/api/gallery/admin','owner')).status,403);
    const fork=(await req('POST',`/api/gallery/works/${seed.id}/fork`)).data;assert.ok(fork.sourceToken);
    const mapPayload={name:'私人原稿',...fork.snapshot,gallerySourceToken:fork.sourceToken};mapPayload.stations[0].note='私人备注绝不公开';mapPayload.stations[1].name='<script>alert(1)</script>';
    const created=await req('POST','/api/maps','owner',mapPayload);assert.equal(created.status,200);const mapId=created.data.map.id;
    assert.equal((await req('GET',`/api/maps/${mapId}`,'other')).status,404);
    assert.equal((await req('POST','/api/maps','owner',{...mapPayload,gallerySourceToken:'forged'})).status,400);
    const publish={sourceMapId:mapId,title:'公开试验作品',category:'fictional',description:'架空测试',city:'',allowFork:true,includeNotes:false,coverCrop:{zoom:1,x:0,y:0}};
    assert.equal((await req('POST','/api/gallery/works','other',publish)).status,404);
    const sent=await req('POST','/api/gallery/works','owner',publish);assert.equal(sent.status,201);const id=sent.data.work.id;
    assert.equal((await req('GET',`/api/gallery/works/${id}`)).status,404);assert.equal((await req('POST','/api/gallery/works','owner',publish)).status,409);
    let mine=(await req('GET','/api/gallery/mine','owner')).data.works[0];assert.equal(mine.reviewStatus,'pending');assert.equal(mine.sourceMapId,mapId);
    assert.equal((await req('POST',`/api/gallery/admin/works/${id}/review`,'owner',{action:'approve',version:mine.version})).status,403);
    assert.equal((await req('POST',`/api/gallery/admin/works/${id}/review`,'admin',{action:'approve',version:99})).status,409);
    assert.equal((await req('POST',`/api/gallery/admin/works/${id}/review`,'admin',{action:'approve',version:mine.version})).status,200);
    let live=(await req('GET',`/api/gallery/works/${id}`)).data.work;assert.ok(!JSON.stringify(live).includes('私人备注'));assert.equal(live.origin.id,seed.id);assert.ok(!live.sourceMapId);assert.ok(!live.ownerId);
    const escaped=await(await fetch(base+`/api/gallery/works/${id}/cover`)).text();assert.ok(!escaped.includes('<script>'));
    assert.ok(require('../server/lib/galleryDomain').artwork({...live,title:'<script>alert(1)</script>'}).svg.includes('&lt;script&gt;'));
    for(let i=0;i<2;i++)assert.equal((await req('PUT',`/api/gallery/works/${id}/reactions`,'other',{kind:'like',active:true})).data.likes,1);
    await req('PUT',`/api/gallery/works/${id}/reactions`,'other',{kind:'save',active:true});assert.equal((await req('GET','/api/gallery/works?saved=1','other')).data.total,1);
    await req('POST',`/api/gallery/works/${id}/report`,'other',{reason:'其他',note:'测试反馈'});await req('POST',`/api/gallery/works/${id}/report`,'other',{reason:'其他',note:'重复'});let queue=(await req('GET','/api/gallery/admin','admin')).data;assert.equal(queue.reports.length,1);await req('POST',`/api/gallery/admin/reports/${queue.reports[0].id}/resolve`,'admin',{});
    mine=(await req('GET','/api/gallery/mine','owner')).data.works[0];const update={...publish,title:'更新待审标题',version:mine.version};assert.equal((await req('PUT',`/api/gallery/works/${id}`,'owner',update)).status,200);
    assert.equal((await req('GET',`/api/gallery/works/${id}`)).data.work.title,'公开试验作品');
    mine=(await req('GET','/api/gallery/mine','owner')).data.works[0];await req('POST',`/api/gallery/admin/works/${id}/review`,'admin',{action:'return',note:'请完善说明',version:mine.version});assert.equal((await req('GET',`/api/gallery/works/${id}`)).data.work.title,'公开试验作品');
    mine=(await req('GET','/api/gallery/mine','owner')).data.works[0];await req('POST',`/api/gallery/admin/works/${id}/review`,'admin',{action:'hide',version:mine.version});assert.equal((await req('GET',`/api/gallery/works/${id}`)).status,404);
    mine=(await req('GET','/api/gallery/mine','owner')).data.works[0];await req('POST',`/api/gallery/admin/works/${id}/review`,'admin',{action:'restore',version:mine.version});assert.equal((await req('GET',`/api/gallery/works/${id}`)).status,200);
    mine=(await req('GET','/api/gallery/mine','owner')).data.works[0];await req('POST',`/api/gallery/admin/works/${id}/review`,'admin',{action:'hide',version:mine.version});
    mine=(await req('GET','/api/gallery/mine','owner')).data.works[0];await req('PUT',`/api/gallery/works/${id}`,'owner',{...publish,version:mine.version});assert.equal((await req('GET',`/api/gallery/works/${id}`)).status,404,'resubmission keeps moderation hide');
    mine=(await req('GET','/api/gallery/mine','owner')).data.works[0];await req('POST',`/api/gallery/admin/works/${id}/review`,'admin',{action:'approve',version:mine.version});
    mine=(await req('GET','/api/gallery/mine','owner')).data.works[0];await req('POST',`/api/gallery/works/${id}/withdraw`,'owner',{version:mine.version});assert.equal((await req('GET',`/api/gallery/works/${id}`)).status,404);assert.equal((await req('GET',`/api/maps/${mapId}`,'owner')).status,200);
    const display=await req('POST','/api/gallery/works','other',{...publish,sourceMapId:(await req('POST','/api/maps','other',{name:'仅展示',...fork.snapshot})).data.map.id,allowFork:false});const displayId=display.data.work.id;
    const displayWork=(await req('GET','/api/gallery/mine','other')).data.works[0];await req('POST',`/api/gallery/admin/works/${displayId}/review`,'admin',{action:'approve',version:displayWork.version});assert.equal((await req('POST',`/api/gallery/works/${displayId}/fork`)).status,403);
    const upgrade=await fetch(base+'/api/gallery/mine',{headers:{Authorization:`Bearer ${jwt.sign({userId:'owner',purpose:'upgrade'},secret)}`}});assert.equal(upgrade.status,401);
    console.log('PASS: six editable seeds; public/private isolation; XML escaping; attribution; verified publishing; review/version conflicts; previous public version; hide/resubmit; withdrawal preserves original; idempotent likes/saves; reports; display-only permission; token purpose.');
  }catch(e){console.error(logs);throw e;}finally{server.kill();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
