'use strict';

// 巡场弱信号诊断测试：核心函数 walkTestCsvToEvents 与 POST /api/weak-signal 接口。
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
const { walkTestCsvToEvents, WEAK_MAX_RECORDS } = require('../lib/weak-signal');

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

async function createDevice(name, frequency = 500, guard = 0.25, locked = false) {
  const res = await request('POST', '/api/devices', { name, frequency, guard, locked });
  assert.equal(res.status, 201, res.data.error);
  return res.data;
}

/** 核心函数便捷封装：默认两台设备、进入 -100 / 恢复 -90 / 间隔 60 */
function diag(csv, params = {}, refs = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }]) {
  return walkTestCsvToEvents(csv, {
    enterThreshold: -100,
    recoverThreshold: -90,
    maxGap: 60,
    ...params,
  }, refs);
}

/* ---------- 核心函数 walkTestCsvToEvents ---------- */

test('迟滞状态机：低于进入阈值开启、达到恢复阈值结束、两阈值之间保持状态', () => {
  // 设备 1：t=10 开启，t=20/30 处于两阈值之间保持事件，t=40 恢复
  // 设备 2：t=5 开启，t=15 恢复
  const r = diag([
    '0,1,-80',
    '10,1,-105',
    '20,1,-95',
    '30,1,-99',
    '40,1,-85',
    '5,2,-110',
    '15,2,-70',
  ].join('\n'));
  assert.equal(r.records, 7);
  assert.equal(r.devices.length, 2);

  const d1 = r.devices.find((d) => d.id === 1);
  assert.deepEqual(d1.events, [
    { index: 1, start: 10, end: 40, duration: 30, endReason: 'recovered' },
  ]);
  assert.equal(d1.totalDuration, 30);
  assert.equal(d1.samples, 5);

  const d2 = r.devices.find((d) => d.id === 2);
  assert.deepEqual(d2.events, [
    { index: 1, start: 5, end: 15, duration: 10, endReason: 'recovered' },
  ]);
});

test('阈值边界：恰等于进入阈值不开启，恰等于恢复阈值即恢复', () => {
  // t=10 电平 -100 == 进入阈值 → 不开启；t=20 开启；t=30 电平 -90 == 恢复阈值 → 恢复
  const r = diag('10,1,-100\n20,1,-101\n30,1,-90');
  const d1 = r.devices.find((d) => d.id === 1);
  assert.deepEqual(d1.events, [
    { index: 1, start: 20, end: 30, duration: 10, endReason: 'recovered' },
  ]);
});

test('输入结束仍未恢复：事件止于末次采样并标记未恢复', () => {
  const r = diag('0,1,-80\n10,1,-105\n20,1,-95');
  const d1 = r.devices.find((d) => d.id === 1);
  assert.deepEqual(d1.events, [
    { index: 1, start: 10, end: 20, duration: 10, endReason: 'unrecovered' },
  ]);
  assert.equal(d1.totalDuration, 10);
});

test('采样间隔超过上限：事件止于前一采样并标记中断，当前点从正常状态重新判断', () => {
  // t=10 开启；t=80 与前一采样间隔 70 > 60 → 事件止于 t=10（中断）；
  // t=80 电平 -95 处于两阈值之间，从正常状态判断 → 不开启新事件
  const r = diag('10,1,-105\n80,1,-95\n90,1,-80');
  const d1 = r.devices.find((d) => d.id === 1);
  assert.deepEqual(d1.events, [
    { index: 1, start: 10, end: 10, duration: 0, endReason: 'interrupted' },
  ]);
});

test('间隔恰好等于上限不算超过；中断后的当前点低于进入阈值则开启新事件', () => {
  // t=10 开启；t=70 间隔恰为 60 → 不中断；t=70 恢复
  // t=80 开启；t=150 间隔 70 > 60 → 事件止于 t=80（中断），t=150 重新判断并开启新事件，结尾未恢复
  const r = diag('10,1,-105\n70,1,-85\n80,1,-105\n150,1,-105');
  const d1 = r.devices.find((d) => d.id === 1);
  assert.deepEqual(d1.events, [
    { index: 1, start: 10, end: 70, duration: 60, endReason: 'recovered' },
    { index: 2, start: 80, end: 80, duration: 0, endReason: 'interrupted' },
    { index: 3, start: 150, end: 150, duration: 0, endReason: 'unrecovered' },
  ]);
  assert.equal(d1.totalDuration, 60);
});

test('同设备同时间取最低电平', () => {
  // t=10 两条记录 -95 / -105（两种顺序）：取最低（-105 < -100）才会开启事件
  for (const csv of ['10,1,-95\n10,1,-105\n20,1,-80', '10,1,-105\n10,1,-95\n20,1,-80']) {
    const r = diag(csv);
    const d1 = r.devices.find((d) => d.id === 1);
    assert.equal(d1.samples, 2); // 同时间去重后剩 2 个采样点
    assert.deepEqual(d1.events, [
      { index: 1, start: 10, end: 20, duration: 10, endReason: 'recovered' },
    ]);
  }
  // 反证：进入阈值改为 -98 时，取最低（-105 < -98）仍开启；若误取最高（-95）则不会开启
  const r = diag('10,1,-95\n10,1,-105\n20,1,-80', { enterThreshold: -98, recoverThreshold: -90 });
  assert.equal(r.devices.find((d) => d.id === 1).events.length, 1);
});

test('按设备分组独立诊断，乱序输入按时间排序，输出按设备 ID 升序', () => {
  const r = diag([
    '20,2,-105',
    '10,1,-105',
    '30,2,-85',
    '20,1,-85',
  ].join('\n'));
  assert.deepEqual(r.devices.map((d) => d.id), [1, 2]);
  const d1 = r.devices[0];
  const d2 = r.devices[1];
  assert.deepEqual(d1.events, [
    { index: 1, start: 10, end: 20, duration: 10, endReason: 'recovered' },
  ]);
  assert.deepEqual(d2.events, [
    { index: 1, start: 20, end: 30, duration: 10, endReason: 'recovered' },
  ]);
});

test('无事件的设备也列出（累计 0 秒）；无采样的设备不出现', () => {
  const r = diag('0,1,-80\n10,1,-85');
  assert.equal(r.devices.length, 1);
  const d1 = r.devices[0];
  assert.equal(d1.eventCount, 0);
  assert.equal(d1.totalDuration, 0);
  assert.deepEqual(d1.events, []);
});

test('整批校验：列数、时间、设备ID、电平错误均指出原始行号（空行占行）', () => {
  assert.throws(() => diag('0,1,-80\n\n1,2'), /第 3 行/);
  assert.throws(() => diag('0,1,-80,extra'), /第 1 行/);
  assert.throws(() => diag('-1,1,-80'), /第 1 行.*时间/);
  assert.throws(() => diag('abc,1,-80'), /第 1 行.*时间/);
  assert.throws(() => diag('0,xyz,-80'), /第 1 行.*设备ID/);
  assert.throws(() => diag('0,999,-80'), /第 1 行.*不存在/);
  assert.throws(() => diag('0,1.5,-80'), /第 1 行.*不存在/);
  assert.throws(() => diag('0,1,'), /第 1 行.*电平/);
  assert.throws(() => diag('0,1,Infinity'), /第 1 行.*电平/);
  // 错误行之前的合法行不产生结果：整批拒绝
  assert.throws(() => diag('0,1,-105\n10,1,-80\nbad,1,-70'), /第 3 行/);
});

test('整批校验：进入阈值必须小于恢复阈值，最大采样间隔必须为正数', () => {
  assert.throws(() => diag('0,1,-80', { enterThreshold: -90, recoverThreshold: -100 }), /进入阈值必须小于恢复阈值/);
  assert.throws(() => diag('0,1,-80', { enterThreshold: -90, recoverThreshold: -90 }), /进入阈值必须小于恢复阈值/);
  assert.throws(() => diag('0,1,-80', { enterThreshold: 'abc' }), /进入阈值/);
  assert.throws(() => diag('0,1,-80', { recoverThreshold: Infinity }), /恢复阈值/);
  assert.throws(() => diag('0,1,-80', { maxGap: 0 }), /最大采样间隔/);
  assert.throws(() => diag('0,1,-80', { maxGap: -5 }), /最大采样间隔/);
  assert.throws(() => diag('0,1,-80', { maxGap: NaN }), /最大采样间隔/);
});

test('整批校验：非空记录最多 1000 条，超出指出行号；空数据与非字符串报错', () => {
  const lines = [];
  for (let i = 0; i < WEAK_MAX_RECORDS; i++) lines.push(`${i},1,-80`);
  assert.equal(diag(lines.join('\n')).records, WEAK_MAX_RECORDS);

  lines.push(`${WEAK_MAX_RECORDS},1,-80`);
  assert.throws(() => diag(lines.join('\n')), new RegExp(`第 ${WEAK_MAX_RECORDS + 1} 行`));

  assert.throws(() => diag(''), /为空/);
  assert.throws(() => diag('  \n \n\t'), /为空/);
  assert.throws(() => diag(undefined), /CSV 文本/);
});

test('CRLF 与首尾空白正常解析；时间为 0 合法', () => {
  const r = diag(' 0 , 1 , -105 \r\n10,1,-80\r\n\r\n');
  assert.equal(r.records, 2);
  const d1 = r.devices.find((d) => d.id === 1);
  assert.deepEqual(d1.events, [
    { index: 1, start: 0, end: 10, duration: 10, endReason: 'recovered' },
  ]);
});

test('小数秒：持续秒数无浮点尾数噪声', () => {
  const r = diag('12.1,1,-105\n30.3,1,-80');
  const d1 = r.devices.find((d) => d.id === 1);
  assert.equal(d1.events[0].duration, 18.2);
  assert.equal(d1.totalDuration, 18.2);
});

/* ---------- HTTP 接口 ---------- */

test('POST /api/weak-signal：返回各设备事件与累计持续秒数', async () => {
  const a = await createDevice('麦 A');
  const b = await createDevice('麦 B', 510);

  const res = await request('POST', '/api/weak-signal', {
    csv: [
      `0,${a.id},-80`,
      `10,${a.id},-105`,
      `40,${a.id},-85`,
      `5,${b.id},-110`,
    ].join('\n'),
    enterThreshold: -100,
    recoverThreshold: -90,
    maxGap: 60,
  });
  assert.equal(res.status, 200, res.data.error);
  assert.equal(res.data.records, 4);

  const da = res.data.devices.find((d) => d.id === a.id);
  assert.equal(da.name, '麦 A');
  assert.deepEqual(da.events, [
    { index: 1, start: 10, end: 40, duration: 30, endReason: 'recovered' },
  ]);
  assert.equal(da.totalDuration, 30);

  const db2 = res.data.devices.find((d) => d.id === b.id);
  assert.deepEqual(db2.events, [
    { index: 1, start: 5, end: 5, duration: 0, endReason: 'unrecovered' },
  ]);
});

test('POST /api/weak-signal：设备 ID 必须已录入，错误指出行号并整批拒绝', async () => {
  const a = await createDevice('麦 A');

  const notExist = await request('POST', '/api/weak-signal', {
    csv: `0,${a.id},-80\n10,999,-105`,
    enterThreshold: -100,
    recoverThreshold: -90,
    maxGap: 60,
  });
  assert.equal(notExist.status, 400);
  assert.match(notExist.data.error, /第 2 行/);
  assert.match(notExist.data.error, /不存在/);

  const badTime = await request('POST', '/api/weak-signal', {
    csv: `0,${a.id},-80\n-5,${a.id},-105`,
    enterThreshold: -100,
    recoverThreshold: -90,
    maxGap: 60,
  });
  assert.equal(badTime.status, 400);
  assert.match(badTime.data.error, /第 2 行.*时间/);

  const badThreshold = await request('POST', '/api/weak-signal', {
    csv: `0,${a.id},-80`,
    enterThreshold: -80,
    recoverThreshold: -90,
    maxGap: 60,
  });
  assert.equal(badThreshold.status, 400);
  assert.match(badThreshold.data.error, /进入阈值必须小于恢复阈值/);

  const badGap = await request('POST', '/api/weak-signal', {
    csv: `0,${a.id},-80`,
    enterThreshold: -100,
    recoverThreshold: -90,
    maxGap: 0,
  });
  assert.equal(badGap.status, 400);
  assert.match(badGap.data.error, /最大采样间隔/);
});

test('巡场诊断为只读：不写入设备或方案，原始采样不入库', async () => {
  const a = await createDevice('麦 A');
  const res = await request('POST', '/api/weak-signal', {
    csv: `0,${a.id},-105\n10,${a.id},-80`,
    enterThreshold: -100,
    recoverThreshold: -90,
    maxGap: 60,
  });
  assert.equal(res.status, 200, res.data.error);

  const plans = await request('GET', '/api/plans');
  assert.equal(plans.data.length, 0);
  const devs = await request('GET', '/api/devices');
  assert.equal(devs.data.devices.length, 1);
  assert.equal(devs.data.devices[0].name, '麦 A');
  // 数据库中不存在任何采样数据（无新增表，plans 仍为空）
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM plans').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM devices').get().c, 1);
});
