const crypto = require('crypto');
const { publication, fail } = require('./galleryDomain');
const seeds = require('./gallerySeeds');

module.exports = function createGalleryStore(ctx) {
  const { pgPool: pool, readJsonDb: read, writeJsonDb: write } = ctx;
  let ready;
  const compact = value => { const copy = JSON.parse(JSON.stringify(value)); ['published','pending'].forEach(k => { if(copy[k]) {delete copy[k].snapshot;delete copy[k].cover;} }); return copy; };
  function json() {const db=read();db.gallery ||= { works: [], reactions: [], reports: [], origins: [] };return db;}
  function initialize() {
    if (!ready) ready = (async () => {
      if(pool) await pool.query(`CREATE TABLE IF NOT EXISTS gallery_works(id TEXT PRIMARY KEY, owner_id TEXT, source_map_id TEXT, version INTEGER NOT NULL DEFAULT 1, payload JSONB NOT NULL, UNIQUE(owner_id,source_map_id));
        CREATE TABLE IF NOT EXISTS gallery_reactions(work_id TEXT REFERENCES gallery_works(id) ON DELETE CASCADE, user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('like','save')), PRIMARY KEY(work_id,user_id,kind));
        CREATE TABLE IF NOT EXISTS gallery_reports(id TEXT PRIMARY KEY, work_id TEXT REFERENCES gallery_works(id) ON DELETE CASCADE, user_id TEXT NOT NULL, payload JSONB NOT NULL, UNIQUE(work_id,user_id));
        CREATE TABLE IF NOT EXISTS gallery_origins(map_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, origin JSONB NOT NULL);`);
      for (const seed of seeds) {
        const now=new Date(Date.now()-seeds.indexOf(seed)*1000).toISOString();
        const published=publication(seed,seed.snapshot,seed.author);published.cover=require('./galleryDomain').artwork(published).svg;
        const work={id:seed.id, ownerId:null, sourceMapId:null, version:1, published, pending:null, visibility:'public',reviewStatus:'approved',featured:true,example:true,createdAt:now,updatedAt:now,publishedAt:now};
        if(pool) await pool.query('INSERT INTO gallery_works(id,owner_id,source_map_id,payload) VALUES($1,NULL,NULL,$2) ON CONFLICT(id) DO NOTHING',[work.id,work]);
        else { const db=json();if(!db.gallery.works.some(w=>w.id===work.id)){db.gallery.works.push(work);write(db);} }
      }
    })().catch(error=>{ready=null;throw error;});
    return ready;
  }
  return {
    async get(id) { await initialize();return pool ? (await pool.query('SELECT payload || jsonb_build_object(\'version\',version) AS work FROM gallery_works WHERE id=$1',[id])).rows[0]?.work : json().gallery.works.find(w=>w.id===id); },
    async list(ownerId) {await initialize();if(pool){const args=ownerId?[ownerId]:[];return (await pool.query(`SELECT (payload #- '{published,snapshot}' #- '{published,cover}' #- '{pending,snapshot}' #- '{pending,cover}') || jsonb_build_object('version',version) AS work FROM gallery_works ${ownerId?'WHERE owner_id=$1':"WHERE payload->>'visibility'='public' AND payload->'published' IS NOT NULL"}`,args)).rows.map(r=>r.work);}return json().gallery.works.filter(w=>ownerId?w.ownerId===ownerId:w.visibility==='public'&&w.published).map(compact);},
    async all() {await initialize();return pool?(await pool.query("SELECT (payload #- '{published,snapshot}' #- '{published,cover}' #- '{pending,snapshot}' #- '{pending,cover}') || jsonb_build_object('version',version) AS work FROM gallery_works")).rows.map(r=>r.work):json().gallery.works.map(compact);},
    async insert(work) {await initialize();if(pool){try {await pool.query('INSERT INTO gallery_works(id,owner_id,source_map_id,payload) VALUES($1,$2,$3,$4)',[work.id,work.ownerId,work.sourceMapId,work]);} catch(e){if(e.code==='23505')throw fail('该地图已提交作品，请在我的作品中更新',409);throw e;}}else{const db=json();if(db.gallery.works.some(w=>w.ownerId===work.ownerId&&w.sourceMapId===work.sourceMapId))throw fail('该地图已提交作品，请在我的作品中更新',409);db.gallery.works.push(work);write(db);}return work;},
    async update(work, version) {await initialize();const next={...work,version:version+1,updatedAt:new Date().toISOString()};if(pool){const r=await pool.query('UPDATE gallery_works SET payload=$1,version=version+1 WHERE id=$2 AND version=$3',[next,work.id,version]);if(!r.rowCount)throw fail('作品已更新，请刷新后重试',409);}else{const db=json(),index=db.gallery.works.findIndex(w=>w.id===work.id&&w.version===version);if(index<0)throw fail('作品已更新，请刷新后重试',409);db.gallery.works[index]=next;write(db);}return next;},
    async reactions(ids,userId) {await initialize();let rows;if(pool)rows=(await pool.query('SELECT work_id AS "workId",user_id AS "userId",kind FROM gallery_reactions WHERE work_id=ANY($1::text[])',[ids])).rows;else rows=json().gallery.reactions.filter(r=>ids.includes(r.workId));return Object.fromEntries(ids.map(id=>{const items=rows.filter(r=>r.workId===id);return[id,{likes:items.filter(r=>r.kind==='like').length,saves:items.filter(r=>r.kind==='save').length,liked:items.some(r=>r.kind==='like'&&r.userId===userId),saved:items.some(r=>r.kind==='save'&&r.userId===userId)}];}));},
    async react(workId,userId,kind,active) {await initialize();if(pool){if(active)await pool.query('INSERT INTO gallery_reactions(work_id,user_id,kind) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[workId,userId,kind]);else await pool.query('DELETE FROM gallery_reactions WHERE work_id=$1 AND user_id=$2 AND kind=$3',[workId,userId,kind]);}else{const db=json();db.gallery.reactions=db.gallery.reactions.filter(r=>!(r.workId===workId&&r.userId===userId&&r.kind===kind));if(active)db.gallery.reactions.push({workId,userId,kind});write(db);}return (await this.reactions([workId],userId))[workId];},
    async report(workId,userId,payload) {await initialize();const id=crypto.randomUUID();if(pool)await pool.query('INSERT INTO gallery_reports(id,work_id,user_id,payload) VALUES($1,$2,$3,$4) ON CONFLICT(work_id,user_id) DO NOTHING',[id,workId,userId,payload]);else{const db=json();if(!db.gallery.reports.some(r=>r.workId===workId&&r.userId===userId)){db.gallery.reports.push({id,workId,userId,payload});write(db);}}},
    async reports() {await initialize();return pool?(await pool.query('SELECT id,work_id AS "workId",payload FROM gallery_reports')).rows:json().gallery.reports.map(({id,workId,payload})=>({id,workId,payload}));},
    async resolveReport(id) {await initialize();if(pool)await pool.query("UPDATE gallery_reports SET payload=jsonb_set(payload,'{resolved}','true') WHERE id=$1",[id]);else{const db=json(),r=db.gallery.reports.find(r=>r.id===id);if(r)r.payload.resolved=true;write(db);}},
    async origin(mapId,userId) {await initialize();return pool?(await pool.query('SELECT origin FROM gallery_origins WHERE map_id=$1 AND user_id=$2',[mapId,userId])).rows[0]?.origin:json().gallery.origins.find(r=>r.mapId===mapId&&r.userId===userId)?.origin;},
    async setOrigin(mapId,userId,origin) {await initialize();if(pool)await pool.query('INSERT INTO gallery_origins(map_id,user_id,origin) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[mapId,userId,origin]);else{const db=json();if(!db.gallery.origins.some(o=>o.mapId===mapId)){db.gallery.origins.push({mapId,userId,origin});write(db);}}}
  };
};
