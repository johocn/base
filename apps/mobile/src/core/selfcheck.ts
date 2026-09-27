/**
 * 基座自检：把「平台能力是否可用」从推断变成一次装机就能读到的证据。
 *
 * 全部通过注入的适配器与窄平台接口访问平台能力，不 import 'uni' 全局，
 * 因此能在 Node 下用 core/fakes.ts 完整测试（与 core/update.ts 同一惯例）。
 */
export type Capability = 'unknown' | 'ok' | 'fail';

export interface CapabilityFlags {
  cryptoOk: Capability;
  fsOk: Capability;
  dbOk: Capability;
  writeOk: Capability;
}

/** 未探测时的初值：`unknown` 不降级，功能照常尝试（spec §4）。 */
export const UNKNOWN_FLAGS: CapabilityFlags = {
  cryptoOk: 'unknown',
  fsOk: 'unknown',
  dbOk: 'unknown',
  writeOk: 'unknown',
};

export const FLAG_KEYS: Array<keyof CapabilityFlags> = ['cryptoOk', 'fsOk', 'dbOk', 'writeOk'];

export type CheckStatus = 'ok' | 'fail' | 'skip';

export interface CheckResult {
  id: string;
  group: string;
  name: string;
  affects: string;
  status: CheckStatus;
  detail: string;
}

export interface SelfCheckReport {
  at: string;
  degraded: boolean;
  items: CheckResult[];
  flags: CapabilityFlags;
}

/** 评论发表是否可用：**只有明确 fail 才拦**，unknown 与 ok 一律照常尝试（spec §4）。 */
export function canPostComment(flags: CapabilityFlags): boolean {
  return flags.cryptoOk !== 'fail' && flags.writeOk !== 'fail';
}

/** 评论发表被拦时的原位原因；可用时返回空串。详细原因在「设置 → 基座自检」。 */
export function postBlockedReason(flags: CapabilityFlags): string {
  if (flags.cryptoOk === 'fail') return '随机源不可用，无法发表评论（设置 → 基座自检 可看原因）';
  if (flags.writeOk === 'fail') return '节点未接受写入，无法发表评论（设置 → 基座自检 可看原因）';
  return '';
}

/** 课程页同步是否可用（同步必须把 pack 写到本地文件）。 */
export function canSync(flags: CapabilityFlags): boolean {
  return flags.fsOk !== 'fail';
}