export type FilterMode = 'all' | 'ic' | 'ooc';
export type MessageKind = 'dialogue' | 'ooc' | 'dice_result' | 'dice_command';

export interface Classification {
  channel: 'ic' | 'ooc';
  kind: MessageKind;
  isDiceResult: boolean;
}

const CQ_TAG = /\[CQ:([^,\]\s]+)(?:,([^\]\r\n]*))?\]/g;
const OPENQQ_MENTION_TAG = /<@([0-9A-Fa-f]{16,64})>/g;
const NUMERIC_AT_TAG = /\[@(\d{5,15})\]/g;
const LEADING_CQ_TAGS = /^\s*(?:(?:\[CQ:[^,\]\s]+(?:,[^\]\r\n]*)?\]|<@[0-9A-Fa-f]{16,64}>)\s*)*/;
const DICE_COMMAND = /^[.。](?:r|ra|rc|rh|rd|rs|rx|rb|rp|sc|st|sn|ti|li|ri|init|en|coc|dnd|setcoc|pc|nn|log|help|bot|ext|draw|jrrp|ob|team|name|text|send|ch|c)(?=[^a-z]|$)/i;
const CQ_LABELS = new Map([
  ['image', '图片'], ['reply', '回复'], ['face', '表情'], ['mface', '表情'],
  ['record', '语音'], ['video', '视频'], ['forward', '合并转发'],
]);
const CQ_ENTITIES: Record<string, string> = { '&#91;': '[', '&#93;': ']', '&#44;': ',', '&amp;': '&' };

export function cleanCqMessage(raw: string): string {
  return raw.replace(CQ_TAG, (_tag, type: string, fields?: string) => {
    if (type === 'at') {
      let name: string | undefined;
      let qq: string | undefined;
      for (const field of fields?.split(',') ?? []) {
        if (field.startsWith('name=')) name = field.slice(5);
        if (field.startsWith('qq=')) qq = field.slice(3);
      }
      if (qq === 'all') return '[@全体成员]';
      if (name || qq) return `[@${name || qq}]`;
    }
    return `[${CQ_LABELS.get(type) ?? type}]`;
  }).replace(/&#91;|&#93;|&#44;|&amp;/g, (entity) => CQ_ENTITIES[entity]);
}

export function resolveMentions(text: string, names?: ReadonlyMap<string, string>): string {
  let out = text.replace(OPENQQ_MENTION_TAG, (_full, id: string) => {
    const resolved = names?.get(id.toUpperCase());
    return resolved ? `[@${resolved}]` : '[@成员]';
  });
  if (names && names.size > 0 && out.includes('[@')) {
    out = out.replace(NUMERIC_AT_TAG, (full, qq: string) => {
      const resolved = names.get(qq.toUpperCase());
      return resolved ? `[@${resolved}]` : full;
    });
  }
  return out;
}

export function classifyLogItem(
  row: { message: string | null; is_dice?: unknown },
  extraOocPrefixes: readonly string[] = [],
): Classification {
  if (Boolean(row.is_dice)) return { channel: 'ic', kind: 'dice_result', isDiceResult: true };

  const text = (row.message ?? '').replace(LEADING_CQ_TAGS, '').trim();
  if (/^[（(]/.test(text) || extraOocPrefixes.some((prefix) => prefix.length > 0 && text.startsWith(prefix))) {
    return { channel: 'ooc', kind: 'ooc', isDiceResult: false };
  }
  return {
    channel: 'ic',
    kind: DICE_COMMAND.test(text) ? 'dice_command' : 'dialogue',
    isDiceResult: false,
  };
}

export function filterReason(
  item: Classification, mode: FilterMode, includeDice: boolean,
): 'ooc' | 'ic' | 'dice' | null {
  if (mode === 'ic' && item.channel === 'ooc') return 'ooc';
  if (mode === 'ooc' && item.channel === 'ic') return 'ic';
  if (!includeDice && (item.kind === 'dice_result' || item.kind === 'dice_command')) return 'dice';
  return null;
}
