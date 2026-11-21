import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const GROUP_A = 'QQ-Group:10001';
export const GROUP_B = 'OpenQQ-Group:4019653007-CAB18FD2C7624CBA83E';
export const LOG_A = 1;
export const LOG_A_HISTORY = 2;
export const LOG_B = 3;
export const LOG_B_EMPTY = 4;

export function createFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sealdice-logs-test-'));
  const logsPath = join(dir, 'data-logs.db');
  const dataPath = join(dir, 'data.db');
  let logsWriter;
  let dataWriter;
  t.after(() => {
    logsWriter?.close();
    dataWriter?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const now = Math.floor(Date.now() / 1000);
  logsWriter = new DatabaseSync(logsPath);
  logsWriter.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY, name TEXT, group_id TEXT, created_at INTEGER,
      updated_at INTEGER, size INTEGER, extra TEXT, upload_url TEXT, upload_time INTEGER
    );
    CREATE INDEX idx_logs_updated_at ON logs(updated_at);
    CREATE INDEX idx_logs_group_id ON logs(group_id);
    CREATE INDEX idx_logs_name_group_id ON logs(name, group_id);
    CREATE TABLE log_items (
      id INTEGER PRIMARY KEY, log_id INTEGER, group_id TEXT, nickname TEXT, im_userid TEXT,
      time INTEGER, message TEXT, is_dice NUMERIC, command_id INTEGER, command_info TEXT,
      raw_msg_id TEXT, user_uniform_id TEXT, removed INTEGER, parent_id INTEGER
    );
    CREATE INDEX idx_log_items_log_id ON log_items(log_id);
    CREATE INDEX idx_log_items_group_id ON log_items(group_id);
  `);
  const insertLog = logsWriter.prepare(`
    INSERT INTO logs (id, name, group_id, created_at, updated_at, size) VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertLog.run(LOG_A, '月港失踪案', GROUP_A, now - 7200, now - 60, 8);
  insertLog.run(LOG_A_HISTORY, '月港前传', GROUP_A, now - 7200, now - 40, 1);
  insertLog.run(LOG_B, '保密副本', GROUP_B, now - 7200, now - 20, 2);
  insertLog.run(LOG_B_EMPTY, '空白副本', GROUP_B, now - 7200, now - 200, 0);

  const insertItem = logsWriter.prepare(`
    INSERT INTO log_items (id, log_id, group_id, nickname, im_userid, time, message, is_dice, removed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  function insertMessage({
    id, log_id = LOG_A, group_id = log_id <= LOG_A_HISTORY ? GROUP_A : GROUP_B,
    time = now, nickname = '调查员', im_userid = 'QQ:101', message, is_dice = 0, removed = null,
  }) {
    insertItem.run(id, log_id, group_id, nickname, im_userid, time, message, is_dice, removed);
  }
  const keeper = { nickname: '守秘人', im_userid: 'QQ:102' };
  insertMessage({ ...keeper, id: 11, time: now - 7200, message: '开场' });
  insertMessage({ id: 12, time: now - 600, message: '[CQ:reply,id=1]（场外注释）' });
  insertMessage({ id: 13, time: now - 500, message: '.ra 侦查', removed: 0 });
  insertMessage({ id: 14, time: now - 450, message: '检定成功', is_dice: 1, nickname: '海豹', im_userid: 'QQ:103' });
  insertMessage({ id: 15, time: now - 400, message: '已删除线索', removed: 1 });
  insertMessage({ id: 16, time: now - 360, message: '灯塔线索[CQ:image,file=test.png]' });
  insertMessage({ id: 17, time: now - 300, message: '（休息一下）' });
  insertMessage({ ...keeper, id: 18, time: now - 60, message: '(尾部场外)' });
  insertMessage({ id: 21, log_id: LOG_A_HISTORY, time: now - 45, message: '前传记录' });
  insertMessage({ id: 31, log_id: LOG_B, time: now - 25, message: '私密线索', nickname: '群乙角色' });
  insertMessage({ id: 32, log_id: LOG_B, time: now - 20, message: '保密结局', nickname: '群乙角色' });

  dataWriter = new DatabaseSync(dataPath);
  dataWriter.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE group_info (id TEXT PRIMARY KEY, created_at INTEGER, updated_at INTEGER, data BLOB);
  `);
  const insertGroup = dataWriter.prepare('INSERT INTO group_info (id, created_at, updated_at, data) VALUES (?, ?, ?, ?)');
  insertGroup.run(GROUP_A, now - 7200, now - 60, Buffer.from(JSON.stringify({
    groupId: GROUP_A, groupName: '月港调查组', logOn: true, logCurName: '月港失踪案',
    system: 'coc7', logStartTime: now - 7200,
  })));
  insertGroup.run(GROUP_B, now - 7200, now - 20, Buffer.from(JSON.stringify({
    groupId: GROUP_B, groupName: '', logOn: false, logCurName: '保密副本', system: 'dnd5e',
  })));

  return { dir, logsPath, dataPath, logsWriter, dataWriter, now, insertMessage };
}
