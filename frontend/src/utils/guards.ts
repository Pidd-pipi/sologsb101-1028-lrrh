/**
 * 封版与并发保存守卫（叶子模块）。
 * - 两个标签页（或同一页先后两次）保存同一场次时，用 updatedAt 作为版本号做乐观并发：
 *   落后的一方保存被拒绝并提示「场次已改动」，表单输入保留，由用户决定放弃或载入最新版本。
 * - 已封版场次对录音师只读，写操作统一抛 SessionLockedError。
 * 仅定义错误类型与纯函数，不触碰 Dexie，避免与 utils/db 形成循环依赖。
 */
import type { Session } from '@/types/session';

/** 场次已封版：封版后录音师（及其它非制作人流程）只可查看 */
export class SessionLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionLockedError';
  }
}

/** 并发冲突：本次保存基于的版本已过期（另一标签页已写入新版本） */
export class StaleRowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleRowError';
  }
}

/** 判断是否为封版拦截错误（页面据此保留输入并给出只读提示） */
export function isSessionLockedError(error: unknown): error is SessionLockedError {
  return error instanceof SessionLockedError;
}

/** 判断是否为并发落后错误（页面据此保留输入并提示载入新版本） */
export function isStaleRowError(error: unknown): error is StaleRowError {
  return error instanceof StaleRowError;
}

/** 封版场次统一文案 */
export function lockedMessage(session: Pick<Session, 'date' | 'period' | 'roomNo'>): string {
  return `场次已封版（${session.date} ${session.period} · ${session.roomNo}），封版后只可查看；如需改动请由制作人重开并填写原因`;
}

/**
 * 乐观并发校验：保存时带着打开弹窗那一刻读到的 updatedAt（期望值）。
 * @param current      库里当前行
 * @param expectedAt   表单基于的 updatedAt；undefined 表示不校验（新建 / 内部联动）
 * @param entityLabel  实体中文名，用于错误文案
 */
export function assertNotStale(current: { updatedAt: number } | undefined, expectedAt: number | undefined, entityLabel: string): void {
  if (expectedAt === undefined || current === undefined) return;
  if (current.updatedAt !== expectedAt) {
    throw new StaleRowError(`${entityLabel}已被其它标签页或窗口改动（场次已有新版本），本次保存为旧内容已被保留，请对照最新版本后再决定`);
  }
}
