'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { bootPage, sleep, click } = require('./helpers');

/* 场景：测试人员录制“追加日志”，随后页面行为更新（每次追加的条目数变多），
 * 回放必须在第一处可见分歧（多出的日志条目）停住，不能报告全部成功。 */
test('追加日志条目数量与录制时不同：post 分歧停在多出的第一条', async () => {
  const { window, recorder, dom } = await bootPage();
  const doc = window.document;
  const app = window.WalkthroughApp;

  recorder.startRecording();
  await sleep(5);
  click(window, doc.getElementById('wt-tab-activity'));
  await sleep(70);
  click(window, doc.getElementById('wt-add-log-btn'));
  await sleep(70);
  recorder.stop();
  const track = recorder.activeTrack;
  const appendIdx = track.steps.findIndex(s => s.target === 'wt-add-log-btn');
  assert.ok(appendIdx >= 0);
  // 录制后恰好多 1 条（初始 20 → 21）
  assert.strictEqual(track.steps[appendIdx].post.lists['wt-log-list'].length, 21);

  // 页面行为更新：同一按钮现在一次追加两条
  const origAppend = app.appendLog.bind(app);
  app.appendLog = function () { origAppend(); origAppend(); };

  const result = await recorder.replay(track);
  assert.strictEqual(result.status, 'halted');
  const h = recorder.halt;
  assert.strictEqual(h.phase, 'post');
  assert.strictEqual(h.stepIndex, appendIdx);
  assert.strictEqual(h.target, 'wt-add-log-btn');
  assert.strictEqual(h.diff.path, 'lists.wt-log-list[21]',
    '分歧必须定位到多出来的第一条（下标 21）');
  assert.strictEqual(h.diff.recorded, undefined, '录制时该下标不存在条目');
  assert.strictEqual(h.diff.current, '日志 #22 · 手动追加 @ <时间>',
    '当前值展示多出条目，且时间已归一化');

  // 轨迹是回放输入，绝不被回放/迟到更新回改
  const persisted = JSON.stringify(recorder.storage.serialize());
  assert.ok(!persisted.includes('#22'), '多出的条目不得写进轨迹');

  dom.window.close();
});

/* 非稳定内容（当前时间）不得制造伪分歧：录制与回放隔了真实墙钟时间，
 * 只要结构与业务文本一致，回放仍应成功。 */
test('日志仅当前时间不同（数量/文本一致）：归一化后回放成功', async () => {
  const { window, recorder, dom } = await bootPage();
  const doc = window.document;

  recorder.startRecording();
  await sleep(5);
  click(window, doc.getElementById('wt-tab-activity'));
  await sleep(70);
  click(window, doc.getElementById('wt-add-log-btn'));
  await sleep(70);
  recorder.stop();
  const track = recorder.activeTrack;

  await sleep(1100); // 跨过整秒，toLocaleTimeString() 必然不同
  const result = await recorder.replay(track);
  assert.strictEqual(result.status, 'completed',
    '时间戳差异不应成为分歧: ' + JSON.stringify(recorder.halt));
  dom.window.close();
});

/* 数量相同但业务文本变了：仍须在改动的那条停住（归一化只抹掉时间）。 */
test('日志条目业务内容变化：停在被改动的下标', async () => {
  const { window, recorder, dom } = await bootPage();
  const doc = window.document;
  const app = window.WalkthroughApp;

  recorder.startRecording();
  await sleep(5);
  click(window, doc.getElementById('wt-tab-activity'));
  await sleep(70);
  click(window, doc.getElementById('wt-add-log-btn'));
  await sleep(70);
  recorder.stop();
  const track = recorder.activeTrack;
  const appendIdx = track.steps.findIndex(s => s.target === 'wt-add-log-btn');

  // 行为更新：仍只追加一条（数量不变），但业务文本改了
  app._logCount = 20;
  app.appendLog = function () {
    this._logCount += 1;
    const li = doc.createElement('li');
    li.textContent = '日志 #' + this._logCount + ' · 系统自动生成 @ ' +
      new Date().toLocaleTimeString();
    doc.getElementById('wt-log-list').appendChild(li);
  };

  const result = await recorder.replay(track);
  assert.strictEqual(result.status, 'halted');
  const h = recorder.halt;
  assert.strictEqual(h.phase, 'post');
  assert.strictEqual(h.stepIndex, appendIdx);
  assert.strictEqual(h.diff.path, 'lists.wt-log-list[20]');
  assert.strictEqual(h.diff.recorded, '日志 #21 · 手动追加 @ <时间>');
  assert.strictEqual(h.diff.current, '日志 #21 · 系统自动生成 @ <时间>');
  dom.window.close();
});

/* 初始状态分歧：回放复位后若日志初始条目数就与录制起点不同，
 * 在任何步骤执行之前就要停住。 */
test('回放起点的日志条目数与录制起点不同：initial 分歧，一步不执行', async () => {
  const { window, recorder, dom } = await bootPage();
  const doc = window.document;

  recorder.startRecording();
  await sleep(5);
  click(window, doc.getElementById('wt-tab-activity'));
  await sleep(70);
  recorder.stop();
  const track = recorder.activeTrack;
  const total = track.steps.length;

  // 应用复位行为被更新：初始渲染 21 条而不是录制时的 20 条
  const app = window.WalkthroughApp;
  const origReset = app.reset.bind(app);
  app.reset = function () {
    origReset();
    app.renderLogs(21); // 新版本：初始日志多一条
  };

  const result = await recorder.replay(track);
  assert.strictEqual(result.status, 'halted');
  assert.strictEqual(recorder.halt.phase, 'initial');
  assert.strictEqual(recorder.halt.diff.path, 'lists.wt-log-list[20]');
  assert.strictEqual(recorder.lastReplayed, -1, '初始分歧时任何步骤都不得执行');
  assert.ok(total > 0);
  dom.window.close();
});

/* 停止回放后，应用挂着的延迟回写（弹窗确认后 30ms）落地，
 * 不得污染轨迹，也不得改动停驻报告；停驻现场应被冻结。 */
test('停住回放后迟到的异步回写不改动停驻页面、不污染轨迹', async () => {
  const { window, recorder, dom } = await bootPage();
  const doc = window.document;
  const app = window.WalkthroughApp;

  // 让回写慢到必然跨越回放的沉淀窗口：回放停在 post 分歧时回写仍挂着。
  // 定时器仍登记进应用的 pendingAsync（与真实 confirmModal 一致）；
  // 它产生于回放执行确认步时（在 reset() 清空之后），用以验证“停驻时”才作废它。
  recorder.startRecording();
  await sleep(5);
  click(window, doc.getElementById('wt-tab-prefs'));
  await sleep(70);
  click(window, doc.getElementById('wt-open-modal-btn'));
  await sleep(70);
  click(window, doc.getElementById('wt-modal-confirm'));
  await sleep(70); // 录制时真实回写为 30ms，已被吸收进 post
  recorder.stop();
  const track = recorder.activeTrack;
  const trackJsonBefore = JSON.stringify(track);
  assert.match(track.steps.find(s => s.target === 'wt-modal-confirm').post.text['wt-async-status'], /v1/,
    '录制侧 post 已包含 30ms 回写');

  // 录制完成后，新版本把回写推迟到 150ms（超过录制的 60ms 沉淀窗口）
  const origConfirm = app.confirmModal;
  app.confirmModal = function () {
    app.closeModal();
    const timer = setTimeout(function () {
      doc.getElementById('wt-async-status').textContent = '迟到回写已落地';
      app.pendingAsync = app.pendingAsync.filter(t => t !== timer);
    }, 150);
    app.pendingAsync.push(timer);
  };

  const result = await recorder.replay(track);
  assert.strictEqual(result.status, 'halted', '回放侧回写更晚（150ms），post 必然分歧');
  const h0 = JSON.parse(JSON.stringify(recorder.halt));
  assert.strictEqual(doc.getElementById('wt-async-status').textContent, '（无）',
    '停驻瞬间迟到回写尚未落地');

  await sleep(220); // 熬过被推迟的回写
  assert.strictEqual(app.pendingAsync.length, 0, '停驻时挂起的应用定时器应已被作废');
  assert.strictEqual(doc.getElementById('wt-async-status').textContent, '（无）',
    '迟到回写不得落地，停驻现场冻结');
  assert.deepStrictEqual(recorder.halt, h0, '停驻报告不被迟到更新改动');
  assert.strictEqual(JSON.stringify(recorder.activeTrack), trackJsonBefore,
    '轨迹不被回放或迟到更新污染');

  app.confirmModal = origConfirm;
  dom.window.close();
});

/* 归一化器单元覆盖：各种当前时间写法都被占位，业务文字与序号原样保留。 */
test('normalizeText：抹掉时间戳但保留业务内容', () => {
  const { normalizeText } = require('../public/recorder.js');
  assert.strictEqual(normalizeText('日志 #21 · 手动追加 @ 14:03:07'),
    '日志 #21 · 手动追加 @ <时间>');
  assert.strictEqual(normalizeText('于 2026-10-03T14:03:07.000Z 保存'),
    '于 <时间> 保存');
  assert.strictEqual(normalizeText('日期 2026/10/03 与钟点 9:05 AM'),
    '日期 <日期> 与钟点 <时间>');
  // 不含时间的文本原样返回（真实内容差异不会被抹掉）
  assert.strictEqual(normalizeText('日志 #21 · 系统自动生成'),
    '日志 #21 · 系统自动生成');
});
