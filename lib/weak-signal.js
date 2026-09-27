'use strict';

/**
 * 巡场弱信号诊断核心逻辑（纯函数，无外部依赖、不写库）。
 *
 * 输入为无表头三列 CSV：时间（秒）、设备 ID、接收电平（dBm），每行一条、空行忽略。
 * 整批校验：每行恰好三列；时间为非负有限数值；设备 ID 必须是当前已录入设备；
 * 电平为有限数值；非空记录最多 WEAK_MAX_RECORDS 条；进入阈值 < 恢复阈值；
 * 最大采样间隔为正数。任一校验失败都抛出带原始行号（从 1 开始，含空行）的 Error，
 * 整批拒绝、不产生任何结果。
 *
 * 诊断规则（按设备分组，时间升序；同设备同时间取最低电平）：
 *   - 初始为正常状态；电平 < 进入阈值时开启弱信号事件；
 *   - 事件中电平 ≥ 恢复阈值才结束（原因为 recovered）；
 *     两阈值之间（进入 ≤ 电平 < 恢复）保持原状态；
 *   - 相邻采样间隔 > 最大采样间隔时，未结束的事件止于前一采样（interrupted），
 *     当前点从正常状态重新判断；
 *   - 输入结束仍处于事件中时，事件止于末次采样（unrecovered）。
 */

/** 巡场采样导入的非空记录上限 */
const WEAK_MAX_RECORDS = 1000;

/** 弱信号事件结束原因 */
const END_REASON = {
  RECOVERED: 'recovered',     // 达到恢复阈值
  INTERRUPTED: 'interrupted', // 相邻采样间隔超过上限
  UNRECOVERED: 'unrecovered', // 输入结束仍未恢复
};

/** 秒数保留 6 位小数，消除浮点减法误差（如 30.3-12.1 的尾数噪声） */
function roundSec(sec) {
  return parseFloat(sec.toFixed(6));
}

/**
 * 解析巡场采样 CSV 并按设备诊断弱信号事件。
 *
 * @param {string} csvText 无表头三列 CSV 文本（时间秒, 设备ID, 电平dBm）
 * @param {{enterThreshold:number, recoverThreshold:number, maxGap:number}} params
 *   enterThreshold 进入阈值（dBm，严格小于恢复阈值）
 *   recoverThreshold 恢复阈值（dBm）
 *   maxGap 最大采样间隔（秒，正数；相邻采样间隔「超过」该值即判中断）
 * @param {Array<{id:number, name:string}>} deviceRefs 当前已录入设备（设备 ID 白名单）
 * @returns {{records:number, devices:Array<{
 *            id:number, name:string, samples:number, eventCount:number,
 *            totalDuration:number,
 *            events:Array<{index:number, start:number, end:number,
 *                          duration:number, endReason:string}>}>}}
 *   records 为非空记录条数；devices 按设备 ID 升序，仅含有采样记录的设备；
 *   events 按开始时间升序，duration/totalDuration 单位为秒
 * @throws {Error} 带原始行号的校验错误（整批拒绝）
 */
function walkTestCsvToEvents(csvText, params, deviceRefs) {
  const enterThreshold = Number(params && params.enterThreshold);
  const recoverThreshold = Number(params && params.recoverThreshold);
  const maxGap = Number(params && params.maxGap);
  if (!Number.isFinite(enterThreshold)) {
    throw new Error('进入阈值必须为有限数值（dBm）');
  }
  if (!Number.isFinite(recoverThreshold)) {
    throw new Error('恢复阈值必须为有限数值（dBm）');
  }
  if (!(enterThreshold < recoverThreshold)) {
    throw new Error('进入阈值必须小于恢复阈值（迟滞判定：进入阈值 < 恢复阈值）');
  }
  if (!Number.isFinite(maxGap) || maxGap <= 0) {
    throw new Error('最大采样间隔必须为正数（秒）');
  }
  if (typeof csvText !== 'string') {
    throw new Error('采样数据必须是 CSV 文本');
  }

  const nameById = new Map((deviceRefs || []).map((d) => [Number(d.id), d.name]));

  // deviceId -> (timeSec -> 最低电平 dBm)：同设备同时间取最低电平
  const byDevice = new Map();
  let records = 0;
  const lines = csvText.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1; // 原始行号（含空行），便于对照粘贴内容
    const text = lines[i].trim();
    if (text === '') continue; // 空行忽略
    records += 1;
    if (records > WEAK_MAX_RECORDS) {
      throw new Error(`第 ${lineNo} 行：非空记录超过 ${WEAK_MAX_RECORDS} 条上限`);
    }
    const cols = text.split(',');
    if (cols.length !== 3) {
      throw new Error(`第 ${lineNo} 行：应为三列（时间秒, 设备ID, 接收电平dBm），实际 ${cols.length} 列`);
    }
    const timeRaw = cols[0].trim();
    const idRaw = cols[1].trim();
    const levelRaw = cols[2].trim();

    const t = timeRaw === '' ? NaN : Number(timeRaw);
    if (!Number.isFinite(t) || t < 0) {
      throw new Error(`第 ${lineNo} 行：时间必须为非负数值（秒，≥ 0）`);
    }
    const id = idRaw === '' ? NaN : Number(idRaw);
    if (!Number.isFinite(id)) {
      throw new Error(`第 ${lineNo} 行：设备ID必须为数值`);
    }
    if (!nameById.has(id)) {
      throw new Error(`第 ${lineNo} 行：设备ID ${idRaw} 不存在（仅接受当前已录入设备的 ID）`);
    }
    const level = levelRaw === '' ? NaN : Number(levelRaw);
    if (!Number.isFinite(level)) {
      throw new Error(`第 ${lineNo} 行：接收电平必须为有限数值（dBm）`);
    }

    let byTime = byDevice.get(id);
    if (!byTime) {
      byTime = new Map();
      byDevice.set(id, byTime);
    }
    const prevLevel = byTime.get(t);
    if (prevLevel === undefined || level < prevLevel) byTime.set(t, level);
  }
  if (records === 0) {
    throw new Error('采样数据为空：请粘贴至少一条「时间秒, 设备ID, 接收电平dBm」记录');
  }

  const devices = [...byDevice.keys()].sort((a, b) => a - b).map((id) => {
    const samples = [...byDevice.get(id).entries()]
      .map(([t, level]) => ({ t, level }))
      .sort((a, b) => a.t - b.t);

    const events = [];
    let inEvent = false;
    let startT = null;
    let prevT = null;

    const pushEvent = (endT, endReason) => {
      events.push({
        index: events.length + 1,
        start: startT,
        end: endT,
        duration: roundSec(endT - startT),
        endReason,
      });
    };

    for (const { t, level } of samples) {
      // 相邻采样间隔超过上限：事件止于前一采样并标记中断，当前点从正常状态重新判断
      if (prevT !== null && t - prevT > maxGap) {
        if (inEvent) {
          pushEvent(prevT, END_REASON.INTERRUPTED);
          inEvent = false;
        }
      }
      if (!inEvent) {
        if (level < enterThreshold) {
          // 低于进入阈值 → 开启事件（恰等于进入阈值不开启）
          inEvent = true;
          startT = t;
        }
      } else if (level >= recoverThreshold) {
        // 达到恢复阈值（含相等）→ 结束事件
        pushEvent(t, END_REASON.RECOVERED);
        inEvent = false;
      }
      // 两阈值之间保持当前状态（事件中继续、正常中不开启）
      prevT = t;
    }
    if (inEvent) {
      // 输入结束仍未恢复：止于末次采样
      pushEvent(prevT, END_REASON.UNRECOVERED);
    }

    return {
      id,
      name: nameById.get(id),
      samples: samples.length,
      eventCount: events.length,
      totalDuration: roundSec(events.reduce((sum, e) => sum + e.duration, 0)),
      events,
    };
  });

  return { records, devices };
}

module.exports = {
  walkTestCsvToEvents,
  WEAK_MAX_RECORDS,
  END_REASON,
};
