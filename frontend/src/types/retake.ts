/** 补录状态 */
export type RetakeState = '待安排' | '已排期' | '已完成';

/** 补录计划：针对问题段落重新录制 */
export interface Retake {
  id: string;
  /** 所属曲目 */
  songId: string;
  /** 关联的问题 Take（手工建立时可空；来源 Take 改动后已排期的计划退回待安排） */
  takeId: string;
  /** 补录原因 */
  reason: string;
  /** 计划日期 */
  planDate: string;
  /** 状态 */
  state: RetakeState;
}

export const RETAKE_STATES: RetakeState[] = ['待安排', '已排期', '已完成'];

export function createEmptyRetake(): Omit<Retake, 'id'> {
  return { songId: '', takeId: '', reason: '', planDate: new Date().toISOString().slice(0, 10), state: '待安排' };
}
