/**
 * 优选 store：维护优选顺序、剪接清单派生、备注与制作人复核。
 */
import { create } from 'zustand';
import type { FilterModel } from '@/types/filter';
import type { Pick } from '@/types/pick';
import {
  nextPickOrder,
  putPick,
  removePick,
  reorderPicks,
  reviewPick as reviewPickRow,
  updatePick
} from '@/utils/db';
import { buildRow } from '@/hooks/useIdbTable';

export const PICK_FILTER_KEYS = ['usages', 'reviewStates'];

interface PickState {
  filters: FilterModel;
  setFilters: (next: FilterModel) => void;
  resetFilters: () => void;
  createPick: (payload: Partial<Omit<Pick, 'id' | 'order'>>) => Promise<string>;
  editPick: (id: string, patch: Partial<Pick>) => Promise<void>;
  reviewPick: (id: string) => Promise<void>;
  deletePick: (id: string) => Promise<void>;
  move: (list: Pick[], from: number, to: number) => Promise<void>;
}

export const usePickStore = create<PickState>()((set) => ({
  filters: { keyword: '', usages: [], reviewStates: [] },
  setFilters: (next) => set({ filters: next }),
  resetFilters: () => set({ filters: { keyword: '', usages: [], reviewStates: [] } }),
  createPick: async (payload) => {
    const order = await nextPickOrder();
    const row = buildRow(
      {
        takeId: payload.takeId ?? '',
        usage: payload.usage ?? '主歌',
        note: payload.note ?? '',
        order,
        reviewState: payload.reviewState ?? '有效',
        reviewNote: payload.reviewNote ?? ''
      } satisfies Omit<Pick, 'id'>,
      'pick'
    );
    await putPick(row);
    return row.id;
  },
  editPick: async (id, patch) => {
    await updatePick(id, patch);
  },
  reviewPick: async (id) => {
    await reviewPickRow(id);
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
