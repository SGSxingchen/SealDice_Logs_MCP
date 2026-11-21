import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ALL_SCOPE } from '../dist/link-store.js';
import { SealDiceDb, formatGroupDisplayName } from '../dist/sealdice-db.js';
import { formatTranscript } from '../dist/transcript.js';
import { createFixture, GROUP_A, GROUP_B, LOG_A, LOG_A_HISTORY, LOG_B } from './fixtures.mjs';

function openFixture(t) {
  const fixture = createFixture(t);
  const db = new SealDiceDb(fixture.logsPath, fixture.dataPath);
  t.after(() => db.close());
  return { ...fixture, db };
}

test('从活跃的 WAL 读取主库和 BLOB 群信息，录制中日志优先于最近更新', async (t) => {
  const { db, logsPath, dataPath, insertMessage } = openFixture(t);
  assert.ok(existsSync(`${logsPath}-wal`));
  assert.ok(existsSync(`${dataPath}-wal`));
  assert.equal(db.isReady(), true);
  const groupLogs = db.listLogs(ALL_SCOPE, { group_id: GROUP_A }).items;
  assert.deepEqual(groupLogs.map((log) => [log.id, log.is_recording]), [[LOG_A_HISTORY, false], [LOG_A, true]]);
  assert.equal(groupLogs[1].display_group_name, '月港调查组');
  assert.equal(groupLogs[1].system, 'coc7');
  assert.equal(groupLogs[1].created_at_iso, new Date(groupLogs[1].created_at * 1000).toISOString());
  assert.equal(db.getGroups('月港')[0].log_cur_name, '月港失踪案');
  assert.equal((await db.getMessages(ALL_SCOPE, { group_id: GROUP_A })).log.id, LOG_A);
  assert.equal((await db.getMessages(ALL_SCOPE, { group_id: GROUP_A, log_name: '月港前传' })).log.id, LOG_A_HISTORY);

  insertMessage({ id: 40, message: '写入后无需重开读库' });
  assert.equal((await db.getMessages(ALL_SCOPE, { log_id: LOG_A, after_id: 18 })).items[0].id, 40);
  assert.equal(formatGroupDisplayName(GROUP_B, ''), '频道群 4019653007-CAB18F…');
  assert.equal(formatGroupDisplayName(GROUP_A, null), 'QQ群 10001');
  assert.equal(formatGroupDisplayName('Other:123', ''), 'Other:123');
});

test('群信息缓存 15 秒，损坏的可选数据库不会阻塞日志', async (t) => {
  const { db, dataWriter, logsPath, dir } = openFixture(t);
  t.mock.timers.enable({ apis: ['Date'] });
  assert.equal(db.getLog(ALL_SCOPE, LOG_A).group_name, '月港调查组');
  dataWriter.prepare('UPDATE group_info SET data = ? WHERE id = ?')
    .run(Buffer.from(JSON.stringify({ groupName: '新群名', logOn: false })), GROUP_A);
  t.mock.timers.tick(14_999);
  assert.equal(db.getLog(ALL_SCOPE, LOG_A).group_name, '月港调查组');
  t.mock.timers.tick(1);
  assert.equal(db.getLog(ALL_SCOPE, LOG_A).group_name, '新群名');
  assert.equal(db.getLog(ALL_SCOPE, LOG_A).is_recording, false);

  const fallback = new SealDiceDb(logsPath, join(dir, 'missing.db'));
  t.after(() => fallback.close());
  const { log } = await fallback.getMessages(ALL_SCOPE, { log_id: LOG_A, limit: 1 });
  assert.equal(log.display_group_name, 'QQ群 10001');
  assert.equal(log.is_recording, false);
  assert.equal(existsSync(join(dir, 'missing.db')), false);
});

test('向前增量跨越场外尾部，向上翻页按 ID 升序且不会重复', async (t) => {
  const { db, insertMessage } = openFixture(t);
  const tail = await db.getMessages(ALL_SCOPE, { log_id: LOG_A, filter_mode: 'ic', include_dice: false, limit: 1 });
  assert.deepEqual(tail.items.map(({ id }) => id), [16]);
  assert.deepEqual(tail.filtered_out, { ooc: 2, ic: 0, dice: 0, speaker: 0, query: 0 });
  assert.equal(tail.next_cursor_id, 18);
  assert.equal(tail.has_older, true);
  assert.equal(tail.has_newer, false);

  insertMessage({ id: 40, message: '（纯场外续写）' });
  insertMessage({ id: 41, message: '（另一条场外）' });
  const delta = await db.getRecentUpdates(ALL_SCOPE, { log_id: LOG_A, since_id: tail.next_cursor_id });
  assert.deepEqual(delta.items, []);
  assert.equal(delta.filtered_out.ooc, 2);
  assert.equal(delta.next_cursor_id, 41);
  assert.equal((await db.getRecentUpdates(ALL_SCOPE, { log_id: LOG_A, since_id: 41 })).scanned_count, 0);

  const older = await db.getMessages(ALL_SCOPE, { log_id: LOG_A, before_id: tail.first_id, limit: 2 });
  assert.deepEqual(older.items.map(({ id }) => id), [13, 14]);
  const oldest = await db.getMessages(ALL_SCOPE, { log_id: LOG_A, before_id: older.first_id, limit: 3 });
  assert.deepEqual(oldest.items.map(({ id }) => id), [11, 12]);
  assert.equal(oldest.has_older, false);
  assert.equal(oldest.has_newer, true);
});

test('跨批次前向游标停在已处理记录，SQL 查询计划使用日志及 rowid 范围索引', async (t) => {
  const { db, insertMessage, logsWriter } = openFixture(t);
  logsWriter.exec('BEGIN');
  for (let id = 100; id <= 908; id += 1) {
    insertMessage({ id, message: id % 402 === 0 ? '（场外）' : `角色消息 ${id}` });
  }
  logsWriter.exec('COMMIT');
  const first = await db.getMessages(ALL_SCOPE, { log_id: LOG_A, after_id: 99, filter_mode: 'ic', limit: 401 });
  assert.equal(first.scanned_count, 402);
  assert.equal(first.next_cursor_id, 501);
  assert.equal(first.has_newer, true);

  const next = await db.getMessages(ALL_SCOPE, { log_id: LOG_A, after_id: first.next_cursor_id, limit: 1 });
  assert.equal(next.first_id, 502);
  assert.equal(next.next_cursor_id, 502);

  for (const operator of ['>', '<']) {
    const plan = logsWriter.prepare(`
      EXPLAIN QUERY PLAN SELECT id, message FROM log_items INDEXED BY idx_log_items_log_id
      WHERE log_id = ? AND id ${operator} ? AND (removed IS NULL OR removed = 0)
      ORDER BY id ${operator === '>' ? 'ASC' : 'DESC'} LIMIT 400
    `).get(LOG_A, 500).detail;
    assert.match(plan, /SEARCH log_items USING INDEX idx_log_items_log_id \(log_id=\? AND rowid[<>]\?\)/);
  }
});

test('时间区间兼容秒、毫秒、带时区 ISO，筛选对每条排除原因只计一次', async (t) => {
  const { db, now } = openFixture(t);
  const localeIso = new Date((now - 450 + 8 * 3600) * 1000).toISOString().replace('Z', '+08:00');
  const range = await db.getMessages(ALL_SCOPE, {
    log_id: LOG_A, start_time: (now - 600) * 1000, end_time: localeIso,
  });
  assert.deepEqual(range.items.map(({ id }) => id), [12, 13, 14]);
  const recent = await db.getMessages(ALL_SCOPE, { log_id: LOG_A, last_minutes: 7 });
  assert.deepEqual(recent.items.map(({ id }) => id), [16, 17, 18]);
  const query = await db.getMessages(ALL_SCOPE, {
    log_id: LOG_A, last_minutes: 20, filter_mode: 'ic', include_dice: false, speaker: 'QQ:101',
    query: '[图片]', include_raw_cq: true,
  });
  assert.equal(query.items[0].message, '灯塔线索[图片]');
  assert.match(query.items[0].raw_cq, /\[CQ:image,/);
  assert.deepEqual(query.filtered_out, { ooc: 3, ic: 0, dice: 2, speaker: 0, query: 0 });
  assert.equal(query.scanned_count, query.returned_count + 5);

  const since = await db.getRecentUpdates(ALL_SCOPE, { group_id: GROUP_A, since_time: now - 500, limit: 1 });
  assert.equal(since.first_id, 14);
  assert.equal(since.next_cursor_id, 14);
  assert.equal(since.has_newer, true);
  await assert.rejects(db.getMessages(ALL_SCOPE, { log_id: LOG_A, start_time: '损坏日期' }), /时间/);
});

test('检索附上前后上下文、移除标记始终生效、参团统计及文本导出', async (t) => {
  const { db, now } = openFixture(t);
  const scoped = { type: 'restricted', group_ids: [], log_ids: [LOG_A] };
  const result = await db.searchMessages(scoped, { query: '线索', context_lines: 2 });
  assert.deepEqual(result.matches.map(({ message }) => message.id), [16]);
  assert.deepEqual(result.matches[0].before.map(({ id }) => id), [13, 14]);
  assert.deepEqual(result.matches[0].after.map(({ id }) => id), [17, 18]);
  assert.deepEqual((await db.searchMessages(scoped, { query: '线索', context_lines: 0 })).matches[0].before, []);
  await assert.rejects(db.searchMessages(scoped, { query: '线索', log_id: LOG_B }), /找不到该日志或当前链接无权访问/);

  const participants = await db.getParticipants(ALL_SCOPE, LOG_A);
  assert.equal(participants.total, 7);
  assert.equal(participants.first_time, now - 7200);
  assert.equal(participants.last_time, now - 60);
  assert.deepEqual(participants.breakdown, { ic: 4, dialogue: 2, ooc: 3, dice_result: 1, dice_command: 1 });
  assert.deepEqual(participants.participants[0], {
    nickname: '调查员', im_userid: 'QQ:101', total: 4, ic: 2, ooc: 2, dice: 1, last_time: now - 300,
  });
  const transcript = formatTranscript(await db.getMessages(ALL_SCOPE, { log_id: LOG_A }));
  assert.match(transcript, /月港失踪案/);
  assert.match(transcript, /\[#16 \| \d{4}-\d\d-\d\d \d\d:\d\d:\d\d \| 场内\] 调查员: 灯塔线索\[图片\]/);
  assert.match(transcript, /next_cursor_id=18/);
  assert.doesNotMatch(transcript, /已删除线索|\[CQ:/);
  const overview = await db.getOverview();
  assert.deepEqual(overview, { totalLogs: 4, totalMessages: 10, activeRecordingCount: 1, groupCount: 2, latestMessageAt: now - 20 });
});

test('后端全链路将 OpenQQ <@HEX> 与数字 CQ 艾特自动翻译为角色昵称且支持按译名检索', async (t) => {
  const { db, insertMessage } = openFixture(t);
  insertMessage({ id: 50, nickname: '牛奶泡LanStarD', im_userid: '4019653007-FF834522288AB2D2993970BE14970D3A', message: '我刚进镇子' });
  insertMessage({ id: 51, nickname: '雨霁', im_userid: '4019653007-E6EEE8D760880A84E46FB7366066C251', message: '<@FF834522288AB2D2993970BE14970D3A> 你好，另外 <@AABBCCDDEEFF00112233445566778899> 在吗' });

  const page = await db.getMessages(ALL_SCOPE, { log_id: LOG_A, after_id: 50, include_raw_cq: true });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].message, '[@牛奶泡LanStarD] 你好，另外 [@成员] 在吗');
  assert.match(page.items[0].raw_cq, /<@FF834522288AB2D2993970BE14970D3A>/);

  const searched = await db.searchMessages(ALL_SCOPE, { log_id: LOG_A, query: '牛奶泡LanStarD', context_lines: 0 });
  assert.deepEqual(searched.matches.map((m) => m.message.id), [51]);
});
