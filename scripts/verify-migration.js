/**
 * 迁移校验脚本（只读，纯 Node，只依赖项目已有的 pg）。
 * 只执行 SELECT，绝不写库，可安全反复运行。
 *
 * 用法（Windows PowerShell）：
 *   # 完整对比（推荐）：同时给旧库和新库
 *   $env:OLD_DATABASE_URL = "Render External Database URL"
 *   $env:NEW_DATABASE_URL = "Neon 连接串"
 *   node scripts/verify-migration.js
 *
 *   # 旧库已删 / 只想自检新库：只设 NEW_DATABASE_URL 也能跑
 *   $env:NEW_DATABASE_URL = "Neon 连接串"
 *   node scripts/verify-migration.js
 *
 * 可选：本地无 SSL 的库设 OLD_DB_SSL=false / NEW_DB_SSL=false。
 */

const { Pool } = require('pg');

const OLD = (process.env.OLD_DATABASE_URL || '').trim();
const NEW = (process.env.NEW_DATABASE_URL || '').trim();

if (!NEW) {
  console.error('✗ 至少需要设置 NEW_DATABASE_URL');
  process.exit(1);
}

const sslFor = (flag) => (process.env[flag] === 'false' ? false : { rejectUnauthorized: false });
const newPool = new Pool({ connectionString: NEW, ssl: sslFor('NEW_DB_SSL') });
const oldPool = OLD ? new Pool({ connectionString: OLD, ssl: sslFor('OLD_DB_SSL') }) : null;

// 关键数据表（迁移绝不能丢）：users / maps
// 易变表（后端启动会按 TTL 清理，数量对不上是正常的）：email_tokens / rate_violations / bans
const CRITICAL = ['users', 'maps'];
const EPHEMERAL = ['email_tokens', 'rate_violations', 'bans'];
const ALL = [...CRITICAL, ...EPHEMERAL];

const count = async (pool, table) => {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM ${table}`);
  return rows[0].c;
};

(async () => {
  let failed = false;

  // ── 1. 行数对比 ──────────────────────────────────────────────
  console.log('① 行数对比');
  console.log('  表'.padEnd(18) + (oldPool ? '旧库'.padEnd(8) : '') + '新库'.padEnd(8) + '判定');
  for (const t of ALL) {
    const n = await count(newPool, t);
    const o = oldPool ? await count(oldPool, t) : null;
    let verdict;
    if (o === null) {
      verdict = '（无旧库，仅记录）';
    } else if (CRITICAL.includes(t)) {
      // 关键表：新 >= 旧 才算没丢（新库可能已有线上新增）；新 < 旧 = 丢数据
      if (n >= o) verdict = n === o ? '✓ 一致' : `✓ 新增 ${n - o}（线上活动）`;
      else { verdict = `✗ 丢失 ${o - n} 行！`; failed = true; }
    } else {
      // 易变表：新 <= 旧 属正常（过期清理）
      verdict = n <= o ? '✓（清理后，正常）' : 'ℹ 新>旧（线上新增）';
    }
    console.log(
      '  ' + t.padEnd(16) + (oldPool ? String(o).padEnd(8) : '') + String(n).padEnd(8) + verdict
    );
  }

  // ── 2. 外键完整性（新库）──────────────────────────────────────
  console.log('\n② 外键完整性（新库）');
  const orphanMaps = (await newPool.query(
    'SELECT COUNT(*)::int AS c FROM maps m LEFT JOIN users u ON m.user_id = u.id WHERE u.id IS NULL'
  )).rows[0].c;
  const orphanTokens = (await newPool.query(
    'SELECT COUNT(*)::int AS c FROM email_tokens e LEFT JOIN users u ON e.user_id = u.id WHERE u.id IS NULL'
  )).rows[0].c;
  console.log(`  孤儿 maps（user 不存在）: ${orphanMaps} ${orphanMaps === 0 ? '✓' : '✗'}`);
  console.log(`  孤儿 email_tokens:        ${orphanTokens} ${orphanTokens === 0 ? '✓' : '✗'}`);
  if (orphanMaps || orphanTokens) failed = true;

  // ── 3. 邮箱唯一性（新库）─────────────────────────────────────
  console.log('\n③ 邮箱唯一性（新库）');
  const dupEmails = (await newPool.query(
    "SELECT LOWER(email) AS e, COUNT(*)::int AS c FROM users WHERE email <> '' GROUP BY 1 HAVING COUNT(*) > 1"
  )).rows;
  const verifiedUsers = (await newPool.query(
    'SELECT COUNT(*)::int AS c FROM users WHERE email_verified = TRUE'
  )).rows[0].c;
  const totalUsers = await count(newPool, 'users');
  console.log(`  重复邮箱: ${dupEmails.length} 组 ${dupEmails.length === 0 ? '✓' : '✗ ' + dupEmails.map((d) => d.e).join(', ')}`);
  console.log(`  已验证用户: ${verifiedUsers} / ${totalUsers}`);
  if (dupEmails.length) failed = true;

  // ── 4. JSONB 内容抽检（新库）─────────────────────────────────
  console.log('\n④ 地图 JSONB 内容抽检（新库）');
  const agg = (await newPool.query(`
    SELECT
      COUNT(*)::int AS maps,
      COUNT(*) FILTER (WHERE jsonb_array_length(COALESCE(stations,'[]'::jsonb)) > 0)::int AS nonempty_maps,
      COALESCE(SUM(jsonb_array_length(COALESCE(lines,'[]'::jsonb))),0)::int AS total_lines,
      COALESCE(SUM(jsonb_array_length(COALESCE(stations,'[]'::jsonb))),0)::int AS total_stations,
      COALESCE(SUM(jsonb_array_length(COALESCE(sections,'[]'::jsonb))),0)::int AS total_sections
    FROM maps
  `)).rows[0];
  console.log(`  地图数: ${agg.maps}，其中有站点的: ${agg.nonempty_maps}`);
  console.log(`  累计 线路=${agg.total_lines} 站点=${agg.total_stations} 区间=${agg.total_sections}`);
  if (agg.maps > 0 && agg.total_stations === 0) {
    console.log('  ⚠ 有地图但站点总数为 0 —— JSONB 可能没搬过来，请重点核对！');
    failed = true;
  } else {
    console.log('  ✓ JSONB 内容非空');
  }

  await newPool.end();
  if (oldPool) await oldPool.end();

  console.log('\n' + (failed ? '✗ 校验发现问题（见上方 ✗ / ⚠）' : '✓ 全部校验通过，迁移完整'));
  process.exit(failed ? 1 : 0);
})().catch(async (err) => {
  console.error('\n✗ 校验脚本出错：', err.message);
  try { await newPool.end(); } catch {}
  try { if (oldPool) await oldPool.end(); } catch {}
  process.exit(2);
});
