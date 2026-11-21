import type { MessageKind } from './message-classifier.js';
import type { MessageResult } from './sealdice-db.js';

const KIND_LABELS: Record<MessageKind, string> = {
  dialogue: '场内', ooc: '场外', dice_result: '检定', dice_command: '指令',
};

export function formatTranscript(result: MessageResult): string {
  const { log, items, filtered_out: filters } = result;
  const lines = [
    `# ${log.name || `日志 #${log.id}`} · ${log.display_group_name}`,
    `next_cursor_id=${result.next_cursor_id ?? 'null'} · ${items.length} 条 · 时间 UTC`,
  ];
  const excluded = [
    ['场外', filters.ooc], ['场内', filters.ic], ['掷骰', filters.dice],
    ['发言人', filters.speaker], ['关键词', filters.query],
  ] as const;
  const counts = excluded.filter(([, count]) => count > 0).map(([label, count]) => `${label} ${count}`);
  if (counts.length) lines.push(`已过滤 ${counts.join('、')}`);
  lines.push('');
  if (!items.length) lines.push('本页没有符合条件的消息');
  for (const item of items) {
    const time = item.time_iso?.slice(0, 19).replace('T', ' ') ?? '时间未知';
    lines.push(`[#${item.id} | ${time} | ${KIND_LABELS[item.kind]}] ${item.nickname || '未命名角色'}: ${item.message}`);
  }
  return lines.join('\n');
}
