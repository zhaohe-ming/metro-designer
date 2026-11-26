const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { fail, publication, artwork, summary } = require('./galleryDomain');
const createStore = require('./galleryStore');
const { resolveGalleryAdmins } = require('./galleryAccess');

module.exports = function registerGallery(app, ctx) {
  const { auth, storage, JWT_SECRET, AMAP_WEB_SERVICE_KEY } = ctx;
  const store=createStore(ctx), wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(e=>e.status?res.status(e.status).json({message:e.message}):next(e));
  const optional=(req,res,next)=>{
    const token=(req.headers.authorization||'').replace(/^Bearer /,'');
    if(token)try{const payload=jwt.verify(token,JWT_SECRET);if(!payload.purpose||payload.purpose==='login')req.userId=payload.userId;}catch{ /* Public browsing remains available after a session expires. */ }
    next();
  };
  const writeLimit=rateLimit({windowMs:60000,max:40,standardHeaders:true,legacyHeaders:false,message:{message:'操作较频繁，请稍后再试'}});
  const submitLimit=rateLimit({windowMs:3600000,max:20,standardHeaders:true,legacyHeaders:false,message:{message:'提交较频繁，请稍后再试'}});
  const admins=resolveGalleryAdmins(process.env.GALLERY_ADMIN_EMAILS);
  const verified=async req=>{const user=await storage.findUserById(req.userId);if(!user?.emailVerified)throw fail('请先完成邮箱验证',403);return user;};
  const admin=async req=>{const user=await verified(req);if(!admins.has(user.email.toLowerCase()))throw fail('此操作需要审核权限',403);return user;};
  const publicWork=async id=>{const work=await store.get(id);if(!work?.published||work.visibility!=='public')throw fail('作品暂未公开',404);return work;};
  const owned=async req=>{const work=await store.get(req.params.id);if(!work||work.ownerId!==req.userId)throw fail('作品不存在',404);return work;};
  const version=(req,work)=>{if(req.body.version!==work.version)throw fail('作品已更新，请刷新后重试',409);};
  const author=user=>({name:user.username||'线网设计者',avatar:/^data:image\/(png|jpeg|webp);base64,/.test(user.avatar||'')?user.avatar:'',official:false});
  const previewCache=new Map();
  function wgs84ToGcj02(lng,lat){
    if(!(lng>=72.004&&lng<=137.8347&&lat>=0.8293&&lat<=55.8271))return [lng,lat];
    const PI=Math.PI,A=6378245.0,EE=0.00669342162296594323,x=lng-105.0,y=lat-35.0;
    let dLat=-100.0+2.0*x+3.0*y+0.2*y*y+0.1*x*y+0.2*Math.sqrt(Math.abs(x));
    dLat+=(20.0*Math.sin(6.0*x*PI)+20.0*Math.sin(2.0*x*PI))*2.0/3.0+(20.0*Math.sin(y*PI)+40.0*Math.sin(y/3.0*PI))*2.0/3.0+(160.0*Math.sin(y/12.0*PI)+320*Math.sin(y*PI/30.0))*2.0/3.0;
    let dLng=300.0+x+2.0*y+0.1*x*x+0.1*x*y+0.1*Math.sqrt(Math.abs(x));
    dLng+=(20.0*Math.sin(6.0*x*PI)+20.0*Math.sin(2.0*x*PI))*2.0/3.0+(20.0*Math.sin(x*PI)+40.0*Math.sin(x/3.0*PI))*2.0/3.0+(150.0*Math.sin(x/12.0*PI)+300.0*Math.sin(x/30.0*PI))*2.0/3.0;
    const radLat=lat/180.0*PI;let magic=Math.sin(radLat);magic=1-EE*magic*magic;const sqrtMagic=Math.sqrt(magic);
    return [Number((lng+(dLng*180.0)/(A/sqrtMagic*Math.cos(radLat)*PI)).toFixed(6)),Number((lat+(dLat*180.0)/((A*(1-EE))/(magic*sqrtMagic)*PI)).toFixed(6))];
  }
  async function cover(data,cacheKey) {
    if(previewCache.has(cacheKey))return previewCache.get(cacheKey);
    const drawing=artwork(data);let svg=drawing.svg;
    if(drawing.staticMap&&AMAP_WEB_SERVICE_KEY){
      const {center,zoom,width,height}=drawing.staticMap;
      const gcjCenter=wgs84ToGcj02(center[0],center[1]);
      const query=new URLSearchParams({location:gcjCenter.join(','),zoom:String(zoom),size:`${width}*${height}`,scale:'1',key:AMAP_WEB_SERVICE_KEY});
      try{
        const upstream=await fetch(`https://restapi.amap.com/v3/staticmap?${query}`,{signal:AbortSignal.timeout(12000)});
        if(upstream.ok&&/^image\/(png|jpeg)/.test(upstream.headers.get('content-type')||'')){
          const bytes=Buffer.from(await upstream.arrayBuffer());
          if(bytes.length<=3000000){
            svg=artwork(data,`data:${upstream.headers.get('content-type').split(';')[0]};base64,${bytes.toString('base64')}`,'© 高德地图').svg;
          }
        }
      }catch{ /* 未配置或静态底图超时时优雅回退至纯净线网矢量封面，绝不阻断作品发布 */ }
    }
    while(previewCache.size>=24)previewCache.delete(previewCache.keys().next().value);
    previewCache.set(cacheKey,svg);return svg;
  }
  function image(res,svg,cache='private, no-store'){res.set('Cache-Control',cache);res.set('Content-Security-Policy',"default-src 'none'; img-src data:; style-src 'unsafe-inline'");res.type('image/svg+xml').send(svg);}
  async function enrich(works,userId,owner=false){const reactions=await store.reactions(works.map(w=>w.id),userId);return works.map(w=>({...summary(w,owner),...reactions[w.id],version:owner?w.version:undefined}));}
  app.get('/api/gallery/session',optional,wrap(async(req,res)=>{const user=req.userId?await storage.findUserById(req.userId):null;res.set('Cache-Control','private, no-store').json({admin:!!user?.emailVerified&&admins.has(user.email.toLowerCase())});}));
  app.get('/api/gallery/works',optional,wrap(async(req,res)=>{
    const q=String(req.query.q||'').slice(0,100).toLowerCase(),category=String(req.query.category||''),base=String(req.query.base||'');
    let works=(await store.list()).filter(w=>{const p=w.published;return(!q||`${p.title} ${p.description} ${p.city} ${p.author.name}`.toLowerCase().includes(q))&&(!category||p.category===category)&&(!base||p.baseMap===base);});
    if(req.query.saved==='1'){if(!req.userId)throw fail('登录后查看收藏',401);const r=await store.reactions(works.map(w=>w.id),req.userId);works=works.filter(w=>r[w.id].saved);}
    works.sort((a,b)=>(req.query.sort==='latest'?0:Number(b.featured)-Number(a.featured))||String(b.publishedAt).localeCompare(String(a.publishedAt))||a.id.localeCompare(b.id));
    const page=Math.max(1,Math.min(10000,parseInt(req.query.page,10)||1)),size=12;
    res.set('Cache-Control','private, no-store').json({works:await enrich(works.slice((page-1)*size,page*size),req.userId),total:works.length,page});
  }));
  app.get('/api/gallery/mine',auth,wrap(async(req,res)=>res.set('Cache-Control','private, no-store').json({works:await enrich(await store.list(req.userId),req.userId,true)})));
  app.get('/api/gallery/admin',auth,wrap(async(req,res)=>{await admin(req);res.set('Cache-Control','no-store').json({works:await enrich((await store.all()).sort((a,b)=>Number(!!b.pending)-Number(!!a.pending)),req.userId,true),reports:await store.reports()});}));
  app.post('/api/gallery/preview',auth,writeLimit,wrap(async(req,res)=>{
    const map=await storage.getMap(req.userId,req.body.sourceMapId);if(!map)throw fail('请先保存地图，再调整封面',404);
    const data=publication({...req.body,title:req.body.title||map.name,category:req.body.category||'fictional'},map,{name:'预览'});
    const key=`${req.userId}:${map.id}:${map.updatedAt}:${JSON.stringify(data.coverCrop)}`;
    image(res,req.body.diagramOnly===true?artwork(data).svg:await cover(data,key));
  }));
  app.get('/api/gallery/works/:id/cover',wrap(async(req,res)=>{const work=await publicWork(req.params.id);const svg=work.published.cover||artwork(work.published).svg;const etag=`"${work.published.revision}"`;res.set('ETag',etag);if(req.headers['if-none-match']===etag)return res.status(304).end();image(res,svg,'public, max-age=300');}));
  app.get('/api/gallery/works/:id',optional,wrap(async(req,res)=>{const work=await publicWork(req.params.id);const [info]=await enrich([work],req.userId);res.set('Cache-Control','private, no-store').json({work:{...info,snapshot:work.published.snapshot}});}));
  app.post('/api/gallery/works/:id/fork',optional,writeLimit,wrap(async(req,res)=>{
    const work=await publicWork(req.params.id);if(!work.published.allowFork)throw fail('作者选择了仅供展示',403);
    const p=work.published, origin={id:work.id,title:p.title,author:p.author.name,revision:p.revision};
    const sourceToken=jwt.sign({purpose:'gallery-fork',origin},JWT_SECRET);
    res.set('Cache-Control','no-store').json({name:`${p.title} · 副本`,snapshot:p.snapshot,sourceToken,origin});
  }));
  app.post('/api/gallery/works',auth,submitLimit,wrap(async(req,res)=>{
    const user=await verified(req),map=await storage.getMap(req.userId,req.body.sourceMapId);if(!map)throw fail('请先保存地图',404);
    const pending=publication(req.body,map,author(user),await store.origin(map.id,req.userId));pending.cover=await cover(pending,`${req.userId}:${map.id}:${map.updatedAt}:${JSON.stringify(pending.coverCrop)}`);
    const now=new Date().toISOString(),work={id:crypto.randomUUID(),ownerId:req.userId,sourceMapId:map.id,version:1,published:null,pending,reviewStatus:'pending',visibility:'withdrawn',featured:false,example:false,createdAt:now,updatedAt:now,publishedAt:null};
    await store.insert(work);res.status(201).json({work:summary(work,true)});
  }));
  app.put('/api/gallery/works/:id',auth,submitLimit,wrap(async(req,res)=>{
    const user=await verified(req),work=await owned(req);version(req,work);
    const map=await storage.getMap(req.userId,work.sourceMapId);if(!map)throw fail('私人原稿已移除，请另存为地图后发布',404);
    const pending=publication(req.body,map,author(user),await store.origin(map.id,req.userId));pending.cover=await cover(pending,`${req.userId}:${map.id}:${map.updatedAt}:${JSON.stringify(pending.coverCrop)}`);
    const next=await store.update({...work,pending,reviewStatus:'pending',reviewNote:''},work.version);res.json({work:summary(next,true)});
  }));
  app.post('/api/gallery/works/:id/withdraw',auth,writeLimit,wrap(async(req,res)=>{const work=await owned(req);version(req,work);const next=await store.update({...work,visibility:'withdrawn',pending:null,reviewStatus:work.published?'approved':'returned',reviewNote:'已撤回'},work.version);res.json({work:summary(next,true)});}));
  app.put('/api/gallery/works/:id/reactions',auth,writeLimit,wrap(async(req,res)=>{await publicWork(req.params.id);if(!['like','save'].includes(req.body.kind)||typeof req.body.active!=='boolean')throw fail('互动格式无效');res.json(await store.react(req.params.id,req.userId,req.body.kind,req.body.active));}));
  app.post('/api/gallery/works/:id/report',auth,writeLimit,wrap(async(req,res)=>{await publicWork(req.params.id);if(!['侵权','内容不当','误导信息','其他'].includes(req.body.reason)||typeof req.body.note!=='string'||req.body.note.length>300)throw fail('举报信息格式无效');await store.report(req.params.id,req.userId,{reason:req.body.reason,note:req.body.note,createdAt:new Date().toISOString(),resolved:false});res.json({ok:true});}));
  app.get('/api/gallery/admin/works/:id',auth,wrap(async(req,res)=>{await admin(req);const work=await store.get(req.params.id);if(!work)throw fail('作品不存在',404);const p=work.pending||work.published;res.set('Cache-Control','no-store').json({work:{...summary(work,true),snapshot:p.snapshot,version:work.version}});}));
  app.get('/api/gallery/admin/works/:id/cover',auth,wrap(async(req,res)=>{await admin(req);const work=await store.get(req.params.id);if(!work)throw fail('作品不存在',404);const p=work.pending||work.published;image(res,p.cover||artwork(p).svg);}));
  app.post('/api/gallery/admin/works/:id/review',auth,writeLimit,wrap(async(req,res)=>{
    await admin(req);const work=await store.get(req.params.id);if(!work)throw fail('作品不存在',404);version(req,work);
    const {action,note}=req.body;if(!['approve','return','hide','restore','feature','unfeature'].includes(action)||typeof(note||'')!=='string'||String(note||'').length>300)throw fail('审核操作无效');
    if(action==='approve'){if(!work.pending)throw fail('暂无待审核版本');work.published=work.pending;work.pending=null;work.visibility='public';work.reviewStatus='approved';work.publishedAt=new Date().toISOString();}
    if(action==='return'){if(!work.pending)throw fail('暂无待审核版本');if(!String(note||'').trim())throw fail('请填写修改建议');work.reviewStatus='returned';}
    if(action==='hide')work.visibility='hidden';
    if(action==='restore'){if(!work.published)throw fail('请先审核通过一个版本');work.visibility='public';}
    if(action==='feature')work.featured=true;if(action==='unfeature')work.featured=false;
    work.reviewNote=note||'';res.json({work:summary(await store.update(work,work.version),true)});
  }));
  app.post('/api/gallery/admin/reports/:id/resolve',auth,writeLimit,wrap(async(req,res)=>{await admin(req);await store.resolveReport(req.params.id);res.json({ok:true});}));
  return {
    readOrigin(token){if(!token)return null;try{const data=jwt.verify(token,JWT_SECRET);if(data.purpose!=='gallery-fork'||!data.origin?.id)throw Error();return data.origin;}catch(e){throw fail('复制来源凭证已过期，请从作品页重新复制');}},
    recordOrigin:(mapId,userId,origin)=>origin?store.setOrigin(mapId,userId,origin):Promise.resolve(),
    copyOrigin:async(fromId,mapId,userId)=>{const ownedMap=await storage.getMap(userId,fromId);if(!ownedMap)return;const origin=await store.origin(fromId,userId);if(origin)await store.setOrigin(mapId,userId,origin);}
  };
};
