/**
 * 优选 store：维护优选顺序、剪接清单派生、备注与复核状态。
 * 源 Take 关键字段改动后优选变为「待复核」，由制作人在本页确认后重新生效。
 */
import { create } from 'zustand';
import type { FilterModel } from '@/types/filter';
import type { Pick } from '@/types/pick';
import {
  confirmPickReview,
  nextPickOrder,
  putPick,
  removePick,
  reorderPicks,
  updatePick
} from '@/utils/db';
import { buildRow } from '@/hooks/useIdbTable';

export const PICK_FILTER_KEYS = ['usages'];

interface PickState {
  filters: FilterModel;
  setFilters: (next: FilterModel) => void;
  resetFilters: () => void;
  createPick: (payload: Omit<Pick, 'id' | 'order'>) => Promise<string>;
  editPick: (id: string, patch: Partial<Pick>) => Promise<void>;
  reviewPick: (id: string) => Promise<void>;
  deletePick: (id: string) => Promise<void>;
  move: (list: Pick[], from: number, to: number) => Promise<void>;
}

export const usePickStore = create<PickState>()((set) => ({
  filters: { keyword: '', usages: [] },
  setFilters: (next) => set({ filters: next }),
  resetFilters: () => set({ filters: { keyword: '', usages: [] } }),
  createPick: async (payload) => {
    const order = await nextPickOrder();
    const row = buildRow({ ...payload, order }, 'pick');
    await putPick(row);
    return row.id;
  },
  editPick: async (id, patch) => {
    await updatePick(id, patch);
  },
  reviewPick: async (id) => {
    await confirmPickReview(id);
  },
  deletePick: async (id) => {
    await removePick(id);
  },
  move: async (list, from, to) => {
    if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return;
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    await reorderPicks(next.map((item) => item.id));
  }
}));
