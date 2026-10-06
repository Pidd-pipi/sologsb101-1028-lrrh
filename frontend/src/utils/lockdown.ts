/**
 * 场次封版规则（叶子模块）
 * - 制作人 / 录音师角色
 * - 封版保护与乐观并发（OCC）冲突错误
 * - 关键字段变化判定等纯函数
 * 不 import utils/db，供 db 事务层与各页面共同使用，避免形成循环依赖。
 */
import type { Take } from '@/types/take';

/** 棚内角色：制作人可封版 / 重开；录音师封版后只读 */
export type StudioRole = '制作人' | '录音师';

export const STUDIO_ROLES: StudioRole[] = ['制作人', '录音师'];

/** 冲突种类：场次已封版 / 数据已被另一方改动 / 业务校验失败 */
export type ConflictKind = 'locked' | 'stale' | 'invalid';

/** 保存冲突错误：页面据此保留用户输入并给出不同提示 */
export class EditConflictError extends Error {
  readonly kind: ConflictKind;

  constructor(kind: ConflictKind, message: string) {
    super(message);
    this.name = 'EditConflictError';
    this.kind = kind;
  }
}

/** 封版后录音师（以及一切写动作）只读：返回 null 表示放行，否则返回可读的拦截原因 */
export function lockedReason(
  session: { finalized?: boolean } | null | undefined
): string | null {
  if (session && session.finalized) return '场次已封版';
  return null;
}

/**
 * 乐观并发：比对打开弹窗时捕获的 updatedAt 与当前行。
 * 行被另一方删除也视为 stale，避免旧内容覆盖新版本。
 */
export function assertNotStale(currentUpdatedAt: number | undefined, expectedUpdatedAt?: number): void {
  if (expectedUpdatedAt !== undefined && currentUpdatedAt !== undefined && currentUpdatedAt !== expectedUpdatedAt) {
    throw new EditConflictError('stale', '场次已改动');
  }
}

/** 取编辑前值；新建时旧值为空 */
function takeKeyPart(take: Partial<Take>): string {
  return JSON.stringify([take.startTc ?? '', take.endTc ?? '', take.grade ?? '', [...(take.issues ?? [])].sort()]);
}

/**
 * 判定一次 Take 保存是否改动了会牵连优选 / 补录的关键字段：
 * 时间码、评级、问题标签。Take 号等非关键字段改动不触发失效。
 */
export function isTakeCoreChanged(prev: Take | undefined, patch: Partial<Take>): boolean {
  if (!prev) return false;
  return (
    (patch.startTc !== undefined && patch.startTc !== prev.startTc) ||
    (patch.endTc !== undefined && patch.endTc !== prev.endTc) ||
    (patch.grade !== undefined && patch.grade !== prev.grade) ||
    (patch.issues !== undefined && takeKeyPart({ issues: patch.issues }) !== takeKeyPart({ issues: prev.issues }))
  );
}

/** 失效原因文案 */
export function invalidationNote(prev: Take, patch: Partial<Take>): string {
  const changed: string[] = [];
  if (patch.startTc !== undefined && patch.startTc !== prev.startTc) changed.push('起始时间码');
  if (patch.endTc !== undefined && patch.endTc !== prev.endTc) changed.push('结束时间码');
  if (patch.grade !== undefined && patch.grade !== prev.grade) changed.push(`评级（${prev.grade}→${patch.grade}）`);
  if (
    patch.issues !== undefined &&
    takeKeyPart({ issues: patch.issues }) !== takeKeyPart({ issues: prev.issues })
  ) {
    changed.push('问题标签');
  }
  return `源 Take ${prev.takeNo} 的${changed.join('、')}已改动，优选失效待复核`;
}

/** 毫秒时间戳格式化为 YYYY-MM-DD HH:mm */
export function formatStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
