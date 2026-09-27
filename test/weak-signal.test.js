'use strict';

// 巡场弱信号诊断测试：核心函数 diagnoseWeakSignal 与 POST /api/weak-signal-events 接口。
// 使用独立临时 DATA_DIR，通过 HTTP 调用导出的 app（监听随机端口）。
process.env.DATA_DIR = require('node:path').join(
  require('node:os').tmpdir(),
  `mic-weak-test-${process.pid}-${Date.now()}`,
);

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const db = require('../db');
const app = require('../server');
const { diagnoseWeakSignal, WEAK_SIGNAL_MAX_RECORDS } = require('../lib/weak-signal');

let server;
let port;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test.beforeEach(() => {
  db.exec('DELETE FROM devices; DELETE FROM plans;');
});

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (d) => { raw += d; });
        res.on('end', () => resolve({ status: res.statusCode, data: raw ? JSON.parse(raw) : {} }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function createDevice(name, frequency, guard = 0.25, locked = false) {
  const res = await request('POST', '/api/devices', { name, frequency, guard, locked });
  assert.equal(res.status, 201, res.data.error);
  return res.data;
}

const DEVS = [
  { id: 1, name: '麦 A' },
  { id: 2, name: '麦 B' },
];
const PARAMS = { enterThreshold: -95, recoverThreshold: -90, maxInterval: 5 };

/* ---------- 核心函数 diagnoseWeakSignal ---------- */

test('滞回状态机：低于进入阈值开启，达到恢复阈值才结束，两阈值之间保持状态', () => {
  // 进入 -95 / 恢复 -90：-97 开启；-94、-92 介于两阈值之间保持事件；-88 ≥ -90 结束
  const r = diagnoseWeakSignal('0,1,-80\n5,1,-97\n10,1,-94\n15,1,-92\n20,1,-88', PARAMS, DEVS);
  assert.equal(r.records, 5);
  assert.equal(r.devices.length, 1);
  const d = r.devices[0];
  assert.equal(d.id, 1);
  assert.equal(d.name, '麦 A');
  assert.equal(d.samples, 5);
  assert.equal(d.events.length, 1);
  assert.deepEqual(d.events[0], { start: 5, end: 20, duration: 15, endReason: 'recovered' });
  assert.equal(d.totalDuration, 15);
});

test('边界：电平恰好等于进入阈值不开启，恰好等于恢复阈值即结束', () => {
  // -95 恰好等于进入阈值 → 不开启；-96 开启；-90 恰好等于恢复阈值 → 结束
  const r = diagnoseWeakSignal('0,1,-95\n5,1,-96\n10,1,-90', PARAMS, DEVS);
  assert.deepEqual(r.devices[0].events, [
    { start: 5, end: 10, duration: 5, endReason: 'recovered' },
  ]);
});

test('同设备同时间取最低电平（记录顺序无关）', () => {
  // 同一时刻 -80 与 -97 取最低 -97 → 开启事件
  for (const csv of ['0,1,-80\n0,1,-97', '0,1,-97\n0,1,-80']) {
    const r = diagnoseWeakSignal(csv, PARAMS, DEVS);
    assert.equal(r.devices[0].samples, 1);
    assert.equal(r.devices[0].events.length, 1);
    assert.equal(r.devices[0].events[0].endReason, 'unrecovered');
  }
  // 取最低后仍不低于进入阈值 → 无事件
  const high = diagnoseWeakSignal('0,1,-80\n0,1,-94', PARAMS, DEVS);
  assert.equal(high.devices[0].samples, 1);
  assert.equal(high.devices[0].events.length, 0);
  assert.equal(high.devices[0].totalDuration, 0);
});

test('采样间隔超限：事件止于前一采样并标记中断，当前点从正常状态重新判断', () => {
  // 间隔上限 5：t=5(-97) 开启；t=20 与前一采样间隔 15 > 5 → 事件止于 t=5 标记中断；
  // t=20(-97) 从正常状态重新判断 → 开启新事件；t=22(-88) 恢复
  const r = diagnoseWeakSignal('5,1,-97\n20,1,-97\n22,1,-88', PARAMS, DEVS);
  assert.deepEqual(r.devices[0].events, [
    { start: 5, end: 5, duration: 0, endReason: 'interrupted' },
    { start: 20, end: 22, duration: 2, endReason: 'recovered' },
  ]);
  assert.equal(r.devices[0].totalDuration, 2);
});

test('间隔恰好等于上限不中断；无事件时超限仅重新判断', () => {
  // t=0(-97) 开启；t=5 间隔恰为 5 → 不中断；t=5(-88) 恢复
  const r = diagnoseWeakSignal('0,1,-97\n5,1,-88', PARAMS, DEVS);
  assert.deepEqual(r.devices[0].events, [
    { start: 0, end: 5, duration: 5, endReason: 'recovered' },
  ]);
  // 无事件时超限：不产生中断事件，当前点正常判断（-80 正常 → 无事件）
  const calm = diagnoseWeakSignal('0,1,-80\n100,1,-80', PARAMS, DEVS);
  assert.equal(calm.devices[0].events.length, 0);
});

test('输入结束仍未恢复：事件止于末次采样并标记未恢复', () => {
  const r = diagnoseWeakSignal('0,1,-80\n5,1,-97\n10,1,-93', PARAMS, DEVS);
  assert.deepEqual(r.devices[0].events, [
    { start: 5, end: 10, duration: 5, endReason: 'unrecovered' },
  ]);
  assert.equal(r.devices[0].totalDuration, 5);
});

test('按设备分组、时间升序；多事件累计持续秒数；设备按 ID 排序', () => {
  // 设备 2 先出现但结果按 ID 升序；设备 1 两段事件累计 4 秒
  const csv = [
    '0,2,-97',   // 设备 2 事件开启
    '3,2,-88',   // 设备 2 恢复（持续 3 秒）
    '10,1,-97',  // 设备 1 事件一开启
    '12,1,-88',  // 设备 1 恢复（持续 2 秒）
    '20,1,-99',  // 设备 1 事件二开启
    '22,1,-88',  // 设备 1 恢复（持续 2 秒）
  ].join('\n');
  const r = diagnoseWeakSignal(csv, PARAMS, DEVS);
  assert.equal(r.devices.length, 2);
  assert.deepEqual(r.devices.map((d) => d.id), [1, 2]);
  assert.deepEqual(r.devices[0].events, [
    { start: 10, end: 12, duration: 2, endReason: 'recovered' },
    { start: 20, end: 22, duration: 2, endReason: 'recovered' },
  ]);
  assert.equal(r.devices[0].totalDuration, 4);
  assert.deepEqual(r.devices[1].events, [
    { start: 0, end: 3, duration: 3, endReason: 'recovered' },
  ]);
});

test('乱序与浮点时间：排序后判定，间隔比较不受浮点噪声影响', () => {
  // 0.3、0.6 间隔恰为 0.3（浮点上 0.6-0.3=0.30000000000000004）→ 不判超限
  const params = { enterThreshold: -95, recoverThreshold: -90, maxInterval: 0.3 };
  const r = diagnoseWeakSignal('0.6,1,-88\n0,1,-97\n0.3,1,-96', params, DEVS);
  assert.deepEqual(r.devices[0].events, [
    { start: 0, end: 0.6, duration: 0.6, endReason: 'recovered' },
  ]);
});

test('整批校验：参数（进入阈值必须小于恢复阈值，最大采样间隔为正数）', () => {
  assert.throws(() => diagnoseWeakSignal('0,1,-80', { ...PARAMS, enterThreshold: 'abc' }, DEVS), /进入阈值/);
  assert.throws(() => diagnoseWeakSignal('0,1,-80', { ...PARAMS, recoverThreshold: Infinity }, DEVS), /恢复阈值/);
  assert.throws(() => diagnoseWeakSignal('0,1,-80', { ...PARAMS, enterThreshold: -90, recoverThreshold: -95 }, DEVS), /小于恢复阈值/);
  assert.throws(() => diagnoseWeakSignal('0,1,-80', { ...PARAMS, enterThreshold: -90, recoverThreshold: -90 }, DEVS), /小于恢复阈值/);
  assert.throws(() => diagnoseWeakSignal('0,1,-80', { ...PARAMS, maxInterval: 0 }, DEVS), /最大采样间隔/);
  assert.throws(() => diagnoseWeakSignal('0,1,-80', { ...PARAMS, maxInterval: -5 }, DEVS), /最大采样间隔/);
  assert.throws(() => diagnoseWeakSignal('0,1,-80', { ...PARAMS, maxInterval: NaN }, DEVS), /最大采样间隔/);
});

test('整批校验：非法行指出原始行号（空行占行），仅接受现有设备 ID、有限数值与非负时间', () => {
  assert.throws(() => diagnoseWeakSignal('0,1,-80\n\n-1,1,-80', PARAMS, DEVS), /第 3 行.*非负/);
  assert.throws(() => diagnoseWeakSignal('0,1,-80\nabc,1,-80', PARAMS, DEVS), /第 2 行/);
  assert.throws(() => diagnoseWeakSignal('0,1,-80\n0,99,-80', PARAMS, DEVS), /第 2 行.*设备 ID/);
  assert.throws(() => diagnoseWeakSignal('0,1.5,-80', PARAMS, DEVS), /第 1 行.*设备 ID/);
  assert.throws(() => diagnoseWeakSignal('0,1,abc', PARAMS, DEVS), /第 1 行.*电平/);
  assert.throws(() => diagnoseWeakSignal('0,1,Infinity', PARAMS, DEVS), /第 1 行/);
  assert.throws(() => diagnoseWeakSignal('0,1', PARAMS, DEVS), /第 1 行.*三列/);
  assert.throws(() => diagnoseWeakSignal('0,1,-80,extra', PARAMS, DEVS), /第 1 行.*三列/);
  assert.throws(() => diagnoseWeakSignal('0,1,', PARAMS, DEVS), /第 1 行/);
  assert.throws(() => diagnoseWeakSignal('0,,-80', PARAMS, DEVS), /第 1 行/);
});

test('整批校验：非空记录最多 1000 条，超出指出行号；空数据与非字符串报错', () => {
  const lines = [];
  for (let i = 0; i < WEAK_SIGNAL_MAX_RECORDS; i++) lines.push(`${i},1,-80`);
  assert.equal(diagnoseWeakSignal(lines.join('\n'), PARAMS, DEVS).records, WEAK_SIGNAL_MAX_RECORDS);

  lines.push(`${WEAK_SIGNAL_MAX_RECORDS},1,-80`);
  assert.throws(
    () => diagnoseWeakSignal(lines.join('\n'), PARAMS, DEVS),
    new RegExp(`第 ${WEAK_SIGNAL_MAX_RECORDS + 1} 行`),
  );

  assert.throws(() => diagnoseWeakSignal('', PARAMS, DEVS), /为空/);
  assert.throws(() => diagnoseWeakSignal('  \n \n\t', PARAMS, DEVS), /为空/);
  assert.throws(() => diagnoseWeakSignal(undefined, PARAMS, DEVS), /CSV 文本/);
});

test('CRLF 与首尾空白正常解析；无事件的设备也列出（累计 0 秒）', () => {
  const r = diagnoseWeakSignal(' 0 , 1 , -80 \r\n5,2,-97\r\n\r\n', PARAMS, DEVS);
  assert.equal(r.records, 2);
  assert.equal(r.devices.length, 2);
  assert.equal(r.devices[0].events.length, 0);
  assert.equal(r.devices[0].totalDuration, 0);
  assert.deepEqual(r.devices[1].events, [
    { start: 5, end: 5, duration: 0, endReason: 'unrecovered' },
  ]);
});

/* ---------- HTTP 接口 ---------- */

test('POST /api/weak-signal-events：返回各设备事件与累计持续秒数', async () => {
  const a = await createDevice('领夹麦 A', 512);
  const b = await createDevice('手持麦 B', 520);
  const res = await request('POST', '/api/weak-signal-events', {
    csv: `0,${a.id},-80\n5,${a.id},-97\n10,${a.id},-88\n0,${b.id},-99`,
    enterThreshold: -95,
    recoverThreshold: -90,
    maxInterval: 5,
  });
  assert.equal(res.status, 200, res.data.error);
  assert.equal(res.data.records, 4);
  assert.deepEqual(res.data.params, { enterThreshold: -95, recoverThreshold: -90, maxInterval: 5 });
  assert.equal(res.data.devices.length, 2);
  const da = res.data.devices.find((d) => d.id === a.id);
  const dbDev = res.data.devices.find((d) => d.id === b.id);
  assert.equal(da.name, '领夹麦 A');
  assert.deepEqual(da.events, [{ start: 5, end: 10, duration: 5, endReason: 'recovered' }]);
  assert.equal(da.totalDuration, 5);
  assert.deepEqual(dbDev.events, [{ start: 0, end: 0, duration: 0, endReason: 'unrecovered' }]);
});

test('POST /api/weak-signal-events：校验失败返回 400 且错误指出行号', async () => {
  const a = await createDevice('领夹麦 A', 512);
  const bad = await request('POST', '/api/weak-signal-events', {
    csv: `0,${a.id},-80\n3,999,-70`,
    enterThreshold: -95,
    recoverThreshold: -90,
    maxInterval: 5,
  });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /第 2 行/);
  assert.match(bad.data.error, /设备 ID/);

  const badParams = await request('POST', '/api/weak-signal-events', {
    csv: `0,${a.id},-80`,
    enterThreshold: -90,
    recoverThreshold: -95,
    maxInterval: 5,
  });
  assert.equal(badParams.status, 400);
  assert.match(badParams.data.error, /小于恢复阈值/);
});

test('诊断接口为只读：不写入设备或方案', async () => {
  const a = await createDevice('领夹麦 A', 512);
  const res = await request('POST', '/api/weak-signal-events', {
    csv: `0,${a.id},-97`,
    enterThreshold: -95,
    recoverThreshold: -90,
    maxInterval: 5,
  });
  assert.equal(res.status, 200);
  const devs = await request('GET', '/api/devices');
  assert.equal(devs.data.devices.length, 1);
  assert.equal(devs.data.devices[0].frequency, 512); // 设备数据未被改动
  const plans = await request('GET', '/api/plans');
  assert.equal(plans.data.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM plans').get().c, 0);
});
