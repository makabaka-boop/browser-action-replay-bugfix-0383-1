'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { bootPage, sleep, typeText, click } = require('./helpers');
const { normalizeText } = require('../public/recorder.js');

/* 场景：录制“追加日志”等操作 → 更新演练页行为 → 回放。
 * 日志内容/条目数量的第一处可见分歧必须让回放停住；
 * 日志里的当前时间等非稳定内容不得制造假分歧、不得污染轨迹。 */

/* 录制：切到活动日志页 → 追加一条日志 → 再追加一条（验证“停在第一处”时后续步骤未执行）。 */
async function recordLogSession(window, recorder) {
  const doc = window.document;
  recorder.startRecording();
  await sleep(5);
  click(window, doc.getElementById('wt-tab-activity'));
  await sleep(90);
  click(window, doc.getElementById('wt-add-log-btn'));
  await sleep(90);
  click(window, doc.getElementById('wt-add-log-btn'));
  await sleep(90);
  recorder.stop();
  return recorder.activeTrack;
}

test('追加日志：条目数量与逐条内容进入摘要；当前时间归一化，行为未变时回放全部成功', async () => {
  const { window, recorder, dom } = await bootPage();
  const track = await recordLogSession(window, recorder);

  const addSteps = track.steps.filter(s => s.target === 'wt-add-log-btn');
  assert.strictEqual(addSteps.length, 2, '应录到两次追加');

  // 条目数量进入每一步摘要（pre/post 可对照）
  assert.strictEqual(addSteps[0].pre.lists['wt-log-list'].count, 20);
  assert.strictEqual(addSteps[0].post.lists['wt-log-list'].count, 21);
  assert.strictEqual(addSteps[1].post.lists['wt-log-list'].count, 22);

  // 新增条目内容进入摘要：稳定部分（序号/文案）保留，当前时间替换为占位符
  const item = addSteps[0].post.lists['wt-log-list'].items[20];
  assert.ok(item.indexOf('日志 #21 · 手动追加 @ ') === 0, '稳定内容应保留: ' + item);
  assert.ok(item.indexOf('[time]') >= 0, '当前时间应被占位符替换: ' + item);
  assert.ok(!/\d{1,2}:\d{2}/.test(item), '轨迹中不得残留裸时间: ' + item);

  // 整条轨迹的可观察状态（initialState + 各步 pre/post）都不含裸时间 —— 非稳定内容不污染轨迹
  const observable = JSON.stringify({ initialState: track.initialState, steps: track.steps });
  assert.ok(!/\d{1,2}:\d{2}(:\d{2})?/.test(observable), '轨迹可观察状态不得包含裸时间');
  const persisted = JSON.stringify(recorder.storage.get('walkthrough-recorder:tracks:v1')
    .map(t => ({ initialState: t.initialState, steps: t.steps })));
  assert.ok(!/\d{1,2}:\d{2}(:\d{2})?/.test(persisted), '持久化状态不得包含裸时间');

  // 页面行为未变：回放必须全部成功 —— 回放时刻的当前时间不同，不得制造假分歧
  const result = await recorder.replay(track);
  assert.strictEqual(result.status, 'completed',
    '行为未变时不得因时间噪声停住: ' + JSON.stringify(recorder.halt));
  assert.strictEqual(result.stepsExecuted, track.steps.length);
  dom.window.close();
});

test('行为更新（一次点击追加 2 条）：回放停在第一处条目数量分歧，后续步骤不执行', async () => {
  const { window, recorder, dom } = await bootPage();
  const doc = window.document;
  const track = await recordLogSession(window, recorder);
  const addIdx = track.steps.findIndex(s => s.target === 'wt-add-log-btn');
  assert.ok(addIdx > 0);
  assert.ok(track.steps.length > addIdx + 1, '分歧步之后还有步骤，用于验证不再执行');

  // 更新演练页行为：每次点击追加两条日志
  window.WalkthroughApp.appendLog = function () {
    for (var i = 0; i < 2; i++) {
      this._logCount = (this._logCount || 0) + 1;
      var li = window.document.createElement('li');
      li.textContent = '日志 #' + this._logCount + ' · 手动追加 @ ' + new Date().toLocaleTimeString();
      window.document.getElementById('wt-log-list').appendChild(li);
    }
  };

  const result = await recorder.replay(track);
  assert.strictEqual(result.status, 'halted', '条目数量变化必须停住，不得报告全部成功');
  const h = recorder.halt;
  assert.strictEqual(h.phase, 'post');
  assert.strictEqual(h.stepIndex, addIdx, '必须停在第一次追加这一步（第一处分歧）');
  assert.strictEqual(h.target, 'wt-add-log-btn');
  assert.strictEqual(h.diff.path, 'lists.wt-log-list.count');
  assert.strictEqual(h.diff.recorded, 21, '录制值：21 条');
  assert.strictEqual(h.diff.current, 22, '当前值：22 条');
  assert.strictEqual(recorder.lastReplayed, addIdx, '分歧步已执行但其后续步骤不得再执行');
  assert.strictEqual(recorder.mode, 'idle');

  // 停住之后：等待远超沉淀/异步窗口，结论不变，第二次追加（后续步骤）没有“偷跑”
  await sleep(200);
  assert.strictEqual(recorder.halt.stepIndex, addIdx);
  assert.strictEqual(recorder.lastReplayed, addIdx);
  assert.strictEqual(doc.getElementById('wt-log-list').children.length, 22,
    '后续追加步骤不得再执行（2 条来自分歧步本身）');
  dom.window.close();
});

test('行为更新（日志文案变化）：回放停在第一处内容分歧，报告展示归一化对照值', async () => {
  const { window, recorder, dom } = await bootPage();
  const doc = window.document;
  const track = await recordLogSession(window, recorder);
  const addIdx = track.steps.findIndex(s => s.target === 'wt-add-log-btn');

  // 更新演练页行为：同样的追加动作，文案不同（仍含当前时间）
  window.WalkthroughApp.appendLog = function () {
    this._logCount = (this._logCount || 0) + 1;
    var li = window.document.createElement('li');
    li.textContent = '日志 #' + this._logCount + ' · 自动追加 @ ' + new Date().toLocaleTimeString();
    window.document.getElementById('wt-log-list').appendChild(li);
  };

  const result = await recorder.replay(track);
  assert.strictEqual(result.status, 'halted', '日志内容变化必须停住');
  const h = recorder.halt;
  assert.strictEqual(h.phase, 'post');
  assert.strictEqual(h.stepIndex, addIdx);
  assert.strictEqual(h.diff.path, 'lists.wt-log-list.items[20]', '分歧定位到具体条目');
  // 录制值/当前值均为归一化文本：稳定差异清晰可见，当前时间不进入报告
  assert.ok(h.diff.recorded.indexOf('日志 #21 · 手动追加 @ ') === 0, '录制值: ' + h.diff.recorded);
  assert.ok(h.diff.current.indexOf('日志 #21 · 自动追加 @ ') === 0, '当前值: ' + h.diff.current);
  assert.ok(h.diff.recorded.indexOf('[time]') >= 0 && h.diff.current.indexOf('[time]') >= 0);
  assert.ok(!/\d{1,2}:\d{2}/.test(h.diff.recorded + h.diff.current), '报告值不得含裸时间');

  // 面板分歧报告如实渲染：路径、双方文案、占位符可见，无裸时间
  const haltBox = doc.querySelector('.wt-rec-halt');
  assert.ok(haltBox, '面板必须渲染停驻框');
  const text = haltBox.textContent;
  assert.ok(text.indexOf('lists.wt-log-list.items[20]') >= 0, '报告含分歧字段路径: ' + text);
  assert.ok(text.indexOf('手动追加') >= 0 && text.indexOf('自动追加') >= 0, '报告含双方文案: ' + text);
  assert.ok(!/\d{1,2}:\d{2}/.test(text), '报告中不得出现裸时间: ' + text);
  dom.window.close();
});

test('密码脱敏与日志归一化并存：同一条轨迹回放成功，轨迹既无密码字符也无裸时间', async () => {
  const { window, recorder, dom } = await bootPage();
  const doc = window.document;
  const SECRET = 'S3cr3t!密碼';

  recorder.startRecording();
  await sleep(5);
  typeText(window, doc.getElementById('wt-password-input'), SECRET);
  await sleep(90);
  click(window, doc.getElementById('wt-tab-activity'));
  await sleep(90);
  click(window, doc.getElementById('wt-add-log-btn'));
  await sleep(90);
  recorder.stop();

  const track = recorder.activeTrack;
  const pwdStep = track.steps.find(s => s.target === 'wt-password-input');
  assert.ok(pwdStep, '应录到密码步');
  assert.strictEqual(pwdStep.redacted, true);
  assert.strictEqual(pwdStep.value, null, '密码步不得保存字符');
  assert.strictEqual(JSON.stringify(pwdStep.post.values['wt-password-input']),
    JSON.stringify({ type: 'password', changed: true }));

  const observable = JSON.stringify({ initialState: track.initialState, steps: track.steps });
  ['S3cr3t', 'cr3t!', '密碼'].forEach(needle => {
    assert.ok(!observable.includes(needle), '轨迹不得包含密码片段: ' + needle);
  });
  assert.ok(!/\d{1,2}:\d{2}(:\d{2})?/.test(observable), '轨迹不得包含裸时间');

  const result = await recorder.replay(track);
  assert.strictEqual(result.status, 'completed',
    '脱敏密码步 + 日志步应整体回放成功: ' + JSON.stringify(recorder.halt));
  dom.window.close();
});

test('normalizeText 单元行为：时间/日期/时间戳归一化，稳定内容原样保留', () => {
  assert.strictEqual(normalizeText('日志 #21 · 手动追加 @ 4:59:17 PM'),
    '日志 #21 · 手动追加 @ [time]');
  assert.strictEqual(normalizeText('日志 #21 · 手动追加 @ 16:59:17'),
    '日志 #21 · 手动追加 @ [time]');
  assert.strictEqual(normalizeText('下午4:59:17 更新完成'), '[time] 更新完成');
  assert.strictEqual(normalizeText('2026-10-02T16:59:17.123Z'), '[datetime]');
  assert.strictEqual(normalizeText('10/2/2026, 4:59:17 PM'), '[date], [time]');
  assert.strictEqual(normalizeText('ts=1759412357123 已同步'), 'ts=[timestamp] 已同步');
  // 稳定内容不受影响：序号、文案、全角标点、版本号
  assert.strictEqual(normalizeText('日志 #21 · 初始条目'), '日志 #21 · 初始条目');
  assert.strictEqual(normalizeText('第 1 次保存：王五'), '第 1 次保存：王五');
  assert.strictEqual(normalizeText('弹窗已于 v1 确认'), '弹窗已于 v1 确认');
});
