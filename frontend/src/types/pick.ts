/** 优选用途 */
export type PickUsage = '主歌' | '副歌' | '独奏' | '全曲';
/** 优选复核状态：来源 Take 改动后立刻失效待复核，制作人复核后恢复有效 */
export type PickReviewState = '有效' | '待复核';

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
  /** 复核状态（v2 新增，历史行按有效回填） */
  reviewState: PickReviewState;
  /** 失效待复核原因（记录触发失效的来源 Take 变更） */
  reviewNote: string;
}

export const PICK_USAGES: PickUsage[] = ['主歌', '副歌', '独奏', '全曲'];
export const PICK_REVIEW_STATES: PickReviewState[] = ['有效', '待复核'];

export function createEmptyPick(): Omit<Pick, 'id' | 'order'> {
  return { takeId: '', usage: '主歌', note: '', reviewState: '有效', reviewNote: '' };
}

export function isPickPendingReview(pick: Pick): boolean {
  return pick.reviewState === '待复核';
}
