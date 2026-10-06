/** 优选用途 */
export type PickUsage = '主歌' | '副歌' | '独奏' | '全曲';
/** 优选复核状态：生效中 / 待复核（源 Take 关键字段改动后立刻失效待复核） */
export type PickReviewState = '生效中' | '待复核';

/** 优选 Take：从可用条次中挑选出的剪接素材 */
export interface Pick {
  id: string;
  /** 被优选的 Take */
  takeId: string;
  /** 用途 */
  usage: PickUsage;
  /** 剪接清单中的顺序 */
  order: number;
  /** 备注 */
  note: string;
  /** 复核状态：源 Take 时间码 / 评级 / 问题标签改动后置为「待复核」 */
  reviewState: PickReviewState;
  /** 最近一次失效原因（待复核时展示，复核通过后清空） */
  reviewNote: string;
}

export const PICK_USAGES: PickUsage[] = ['主歌', '副歌', '独奏', '全曲'];
export const PICK_REVIEW_STATES: PickReviewState[] = ['生效中', '待复核'];

export function createEmptyPick(): Omit<Pick, 'id' | 'order'> {
  return { takeId: '', usage: '主歌', note: '', reviewState: '生效中', reviewNote: '' };
}
