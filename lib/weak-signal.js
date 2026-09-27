'use strict';

/**
 * 巡场弱信号诊断核心逻辑（纯函数，无外部依赖，不写库）。
 *
 * 输入为无表头三列 CSV：时间（秒）、设备 ID、接收电平（dBm）。
 * 整批校验：每行必须恰好三列；时间为非负有限数值；设备 ID 必须为现有设备；
 * 电平为有限数值；非空记录最多 WEAK_SIGNAL_MAX_RECORDS 条。任一校验失败都
 * 抛出带原始行号（从 1 开始，含空行）的 Error，整批拒绝。
 *
 * 处理规则：按设备分组、时间升序；同设备同时间取最低电平。滞回状态机：
 * 初始正常；电平 < 进入阈值开启事件；电平 ≥ 恢复阈值才结束事件；两阈值之间
 * 保持原状态。相邻采样间隔超过上限时，未结束的事件止于前一采样并标记
 * 「中断」，当前点从正常状态重新判断；输入结束仍未恢复的事件止于末次采样
 * 并标记「未恢复」。
 */

/** 巡场诊断导入的非空记录上限 */
const WEAK_SIGNAL_MAX_RECORDS = 1000;

/** 事件结束原因 */
const END_REASON = {
  RECOVERED: 'recovered',     // 电平达到恢复阈值，事件结束
  INTERRUPTED: 'interrupted', // 相邻采样间隔超限，事件止于前一采样
  UNRECOVERED: 'unrecovered', // 输入结束仍未恢复，事件止于末次采样
};

/** 浮点间隔比较的容差（秒），避免 0.6-0.3 之类的二进制误差误判超限 */
const GAP_EPS = 1e-9;

/** 保留 6 位小数并去掉尾随零（抑制浮点噪声，如 10.5-3.2） */
function round6(n) {
  return parseFloat(n.toFixed(6));
}

/**
 * 解析巡场采样 CSV 并诊断各设备的弱信号事件（纯函数，不写库）。
 *
 * @param {string} csvText 无表头三列 CSV 文本（时间 秒, 设备 ID, 接收电平 dBm；空行忽略）
 * @param {{enterThreshold:number, recoverThreshold:number, maxInterval:number}} params
 *   enterThreshold 进入阈值（dBm，有限数值）；recoverThreshold 恢复阈值（dBm，有限数值），
 *   必须大于进入阈值；maxInterval 最大采样间隔（秒，正数）
 * @param {Array<{id:number, name:string}>} devices 现有设备（仅接受这些设备 ID）
 * @returns {{records:number,
 *            params:{enterThreshold:number, recoverThreshold:number, maxInterval:number},
 *            devices:Array<{id:number, name:string, samples:number,
 *                           events:Array<{start:number, end:number, duration:number, endReason:string}>,
 *                           totalDuration:number}>}}
 *   records 为非空记录条数；devices 按设备 ID 升序，仅含出现采样的设备；
 *   samples 为同时间取最低电平后的采样点数；events 按时间升序；
 *   totalDuration 为该设备全部事件的累计持续秒数
 * @throws {Error} 参数或 CSV 校验错误（CSV 错误带原始行号）
 */
function diagnoseWeakSignal(csvText, params, devices) {
  const p = params || {};
  const enter = Number(p.enterThreshold);
  if (!Number.isFinite(enter)) {
    throw new Error('进入阈值必须为有限数值（dBm）');
  }
  const recover = Number(p.recoverThreshold);
  if (!Number.isFinite(recover)) {
    throw new Error('恢复阈值必须为有限数值（dBm）');
  }
  if (!(enter < recover)) {
    throw new Error(`进入阈值（${enter} dBm）必须小于恢复阈值（${recover} dBm）`);
  }
  const maxInterval = Number(p.maxInterval);
  if (!Number.isFinite(maxInterval) || maxInterval <= 0) {
    throw new Error('最大采样间隔必须为正数（秒）');
  }
  if (typeof csvText !== 'string') {
    throw new Error('巡场数据必须是 CSV 文本');
  }

  const deviceById = new Map((devices || []).map((d) => [d.id, d]));

  // ---- 整批解析：任一错误带行号整批拒绝；同设备同时间取最低电平 ----
  const byDevice = new Map(); // id -> Map(time -> 最低电平 dBm)
  let records = 0;
  const lines = csvText.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1; // 原始行号（含空行），便于对照粘贴内容
    const text = lines[i].trim();
    if (text === '') continue; // 空行忽略
    records += 1;
    if (records > WEAK_SIGNAL_MAX_RECORDS) {
      throw new Error(`第 ${lineNo} 行：非空记录超过 ${WEAK_SIGNAL_MAX_RECORDS} 条上限`);
    }
    const cols = text.split(',');
    if (cols.length !== 3) {
      throw new Error(`第 ${lineNo} 行：应为三列（时间 秒, 设备 ID, 接收电平 dBm），实际 ${cols.length} 列`);
    }
    const timeRaw = cols[0].trim();
    const idRaw = cols[1].trim();
    const levelRaw = cols[2].trim();
    const time = timeRaw === '' ? NaN : Number(timeRaw);
    const id = idRaw === '' ? NaN : Number(idRaw);
    const level = levelRaw === '' ? NaN : Number(levelRaw);
    if (!Number.isFinite(time) || time < 0) {
      throw new Error(`第 ${lineNo} 行：时间必须为非负的有限数值（秒）`);
    }
    if (!Number.isInteger(id) || !deviceById.has(id)) {
      throw new Error(`第 ${lineNo} 行：设备 ID 无效或不存在（仅接受现有设备 ID）`);
    }
    if (!Number.isFinite(level)) {
      throw new Error(`第 ${lineNo} 行：接收电平必须为有限数值（dBm）`);
    }
    let byTime = byDevice.get(id);
    if (!byTime) {
      byTime = new Map();
      byDevice.set(id, byTime);
    }
    const prev = byTime.get(time);
    if (prev === undefined || level < prev) byTime.set(time, level);
  }
  if (records === 0) {
    throw new Error('巡场数据为空：请粘贴至少一条「时间 秒, 设备 ID, 接收电平 dBm」记录');
  }

  // ---- 按设备分组（时间升序）执行滞回状态机 ----
  const makeEvent = (start, end, endReason) => ({
    start,
    end,
    duration: round6(end - start),
    endReason,
  });

  const resultDevices = [];
  for (const [id, byTime] of byDevice) {
    const times = [...byTime.keys()].sort((a, b) => a - b);
    const events = [];
    let openStart = null; // 非 null 表示事件进行中，值为事件开始时间
    let prevTime = null;

    for (const t of times) {
      const level = byTime.get(t);
      // 相邻采样间隔超过上限：未结束的事件止于前一采样并标记中断，
      // 当前点从正常状态重新判断
      if (prevTime !== null && t - prevTime > maxInterval + GAP_EPS) {
        if (openStart !== null) {
          events.push(makeEvent(openStart, prevTime, END_REASON.INTERRUPTED));
          openStart = null;
        }
      }
      if (openStart === null) {
        // 正常状态：电平低于进入阈值才开启事件（等于不开启）
        if (level < enter) openStart = t;
      } else if (level >= recover) {
        // 事件中：电平达到恢复阈值才结束（两阈值之间保持状态）
        events.push(makeEvent(openStart, t, END_REASON.RECOVERED));
        openStart = null;
      }
      prevTime = t;
    }
    // 输入结束仍未恢复：止于末次采样并标记未恢复
    if (openStart !== null) {
      events.push(makeEvent(openStart, prevTime, END_REASON.UNRECOVERED));
    }

    const totalDuration = round6(events.reduce((sum, e) => sum + e.duration, 0));
    resultDevices.push({
      id,
      name: deviceById.get(id).name,
      samples: times.length,
      events,
      totalDuration,
    });
  }
  resultDevices.sort((a, b) => a.id - b.id);

  return {
    records,
    params: { enterThreshold: enter, recoverThreshold: recover, maxInterval },
    devices: resultDevices,
  };
}

module.exports = {
  diagnoseWeakSignal,
  END_REASON,
  WEAK_SIGNAL_MAX_RECORDS,
};
