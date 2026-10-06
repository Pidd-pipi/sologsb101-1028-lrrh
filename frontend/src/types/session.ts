/** 时段 */
export type SessionPeriod = '上午' | '下午' | '晚上' | '通宵';
/** 场次状态 */
export type SessionState = '已排期' | '已完成' | '已取消';
/** 封版日志动作：封版 / 重开 */
export type LockLogAction = '封版' | '重开';

/** 封版审计日志：制作人封版或重开场次时留痕 */
export interface SessionLockLog {
  /** 动作 */
  action: LockLogAction;
  /** 操作角色（制作人 / 录音师） */
  role: string;
  /** 重开原因（封版动作可留空） */
  reason: string;
  /** 操作时间（毫秒时间戳） */
  at: number;
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
  /** 是否已封版：封版后录音师对场次及其 Take / 优选 / 补录只读 */
  finalized: boolean;
  /** 封版 / 重开审计日志（最近一次在末尾） */
  lockLogs: SessionLockLog[];
}

export const SESSION_PERIODS: SessionPeriod[] = ['上午', '下午', '晚上', '通宵'];
export const SESSION_STATES: SessionState[] = ['已排期', '已完成', '已取消'];
export const LOCK_LOG_ACTIONS: LockLogAction[] = ['封版', '重开'];

export function createEmptySession(): Omit<Session, 'id'> {
  return {
    songId: '',
    date: new Date().toISOString().slice(0, 10),
    period: '上午',
    engineer: '',
    roomNo: 'A 棚',
    musicians: '',
    state: '已排期',
    finalized: false,
    lockLogs: []
  };
}

/** 棚号候选 */
export const STUDIO_ROOMS = ['A 棚', 'B 棚', 'C 棚', '大排练厅'];
