/** 时段 */
export type SessionPeriod = '上午' | '下午' | '晚上' | '通宵';
/** 场次状态 */
export type SessionState = '已排期' | '已完成' | '已取消';
/** 封版状态：制作人定稿后场次锁定，重开需写原因 */
export type SessionLockState = '未封版' | '已封版';

/** 封版 / 重开动作留痕 */
export interface SessionLockEntry {
  /** 动作类型：封版 / 重开 */
  action: '封版' | '重开';
  /** 操作人（角色 + 可附署名） */
  actor: string;
  /** 操作时间（ISO） */
  at: string;
  /** 重开时必须填写的原因（封版动作为空） */
  reason: string;
}

/** 录制场次：某曲目某天的录制安排 */
export interface Session {
  id: string;
  /** 所属曲目 */
  songId: string;
  /** 日期 YYYY-MM-DD */
  date: string;
  /** 时段 */
  period: SessionPeriod;
  /** 录音师 */
  engineer: string;
  /** 棚号 */
  roomNo: string;
  /** 参与乐手（顿号分隔） */
  musicians: string;
  /** 场次状态 */
  state: SessionState;
  /** 封版状态（v2 新增，历史行按未封版回填） */
  lockState: SessionLockState;
  /** 最近一次封版时间（ISO） */
  lockedAt: string;
  /** 最近一次封版操作人 */
  lockedBy: string;
  /** 最近一次重开原因 */
  reopenReason: string;
  /** 封版 / 重开留痕（按时间顺序） */
  lockHistory: SessionLockEntry[];
}

export const SESSION_PERIODS: SessionPeriod[] = ['上午', '下午', '晚上', '通宵'];
export const SESSION_STATES: SessionState[] = ['已排期', '已完成', '已取消'];
export const SESSION_LOCK_STATES: SessionLockState[] = ['未封版', '已封版'];

export function createEmptySession(): Omit<Session, 'id'> {
  return {
    songId: '',
    date: new Date().toISOString().slice(0, 10),
    period: '上午',
    engineer: '',
    roomNo: 'A 棚',
    musicians: '',
    state: '已排期',
    lockState: '未封版',
    lockedAt: '',
    lockedBy: '',
    reopenReason: '',
    lockHistory: []
  };
}

/** 棚号候选 */
export const STUDIO_ROOMS = ['A 棚', 'B 棚', 'C 棚', '大排练厅'];

/** 行内只读封版信息（表格列 / 弹窗提示复用） */
export function isSessionLocked(session: Pick<Session, 'lockState'>): boolean {
  return session.lockState === '已封版';
}
