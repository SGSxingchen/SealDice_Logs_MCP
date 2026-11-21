import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyLogItem, cleanCqMessage, filterReason } from '../dist/message-classifier.js';

const classify = (message, is_dice = 0, prefixes) => classifyLogItem({ message, is_dice }, prefixes);

test('开头圆括号、混合括号和带前置 CQ 的场外发言', () => {
  for (const message of [
    '(场外', '（场外', '(场外）', '（跨行\n场外)', '  [CQ:reply,id=1] \t[CQ:at,qq=25] （场外吐槽）',
  ]) {
    assert.deepEqual(classify(message), { channel: 'ooc', kind: 'ooc', isDiceResult: false }, message);
  }
  assert.equal(classify('角色打了个呵欠（轻声）').kind, 'dialogue');
  assert.equal(classify('[CQ:reply,id=1] 备注：我先离开', 0, ['备注：']).kind, 'ooc');
  assert.equal(classify('角色台词', 0, ['']).kind, 'dialogue');
});

test('CQ 标签替换、参数优先级及实体只解码一次', () => {
  const raw = '[CQ:image,file=a][CQ:at,name=旁观者,qq=all][CQ:at,qq=123,name=A&#44;B&amp;C=1]'
    + '[CQ:at,qq=123][CQ:reply,id=3][CQ:face,id=2][CQ:mface,id=5][CQ:record,file=r]'
    + '[CQ:video,file=v][CQ:forward,id=f][CQ:poke,id=p]&#91;文本&#93;&#44; &amp;#91;';
  assert.equal(
    cleanCqMessage(raw),
    '[图片][@全体成员][@A,B&C=1][@123][回复][表情][表情][语音][视频][合并转发][poke][文本], &#91;',
  );
});

test('骰子结果优先，分辨紧接骰式的指令和省略号', () => {
  assert.deepEqual(classify('（检定）', 1), { channel: 'ic', kind: 'dice_result', isDiceResult: true });
  for (const command of ['.ra 侦查', '。RA侦查', '.r', '.r2d6', '.rd20', '.rD100', '.r+2', '.r-2',
    '[CQ:reply,id=4] 。sc 1/1d6', '.setcoc', '.log on', '.dnd', '.jrrp', '.ch 角色']) {
    assert.equal(classify(command).kind, 'dice_command', command);
  }
  for (const dialogue of ['..r', '...', '。。r', '…', '.random', '.helpful', '.raven', '.rdynamic', '角色说 .ra']) {
    assert.equal(classify(dialogue).kind, 'dialogue', dialogue);
  }
});

test('场内、场外、全量与掷骰选项的每种组合只记一个过滤原因', () => {
  const messages = ['进入酒馆', '（等一下）', '.ra 侦查', '成功 45/50'];
  const kinds = messages.map((message, index) => classify(message, index === 3));
  const matrix = [
    ['all', true, [null, null, null, null]],
    ['all', false, [null, null, 'dice', 'dice']],
    ['ic', true, [null, 'ooc', null, null]],
    ['ic', false, [null, 'ooc', 'dice', 'dice']],
    ['ooc', true, ['ic', null, 'ic', 'ic']],
    ['ooc', false, ['ic', null, 'ic', 'ic']],
  ];
  for (const [mode, includeDice, expected] of matrix) {
    assert.deepEqual(kinds.map((item) => filterReason(item, mode, includeDice)), expected);
  }
});
