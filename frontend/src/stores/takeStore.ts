/**
 * Take store：维护条次列表的评级 / 问题标签 / 时间码筛选，以及批量改评级。
 * 写操作统一经 db 层封版校验与乐观并发；源 Take 关键字段改动时
 * 优选失效待复核、已排期补录退回待安排（在 db 事务内联动）。
 */
import { create } from 'zustand';
import type { FilterModel } from '@/types/filter';
import type { Take } from '@/types/take';
import { bulkUpdateGrade, putTake, removeTake, updateTake, type TakeSaveResult } from '@/utils/db';
import { buildRow } from '@/hooks/useIdbTable';

export const TAKE_FILTER_KEYS = ['grades', 'issues', 'sessionIds', 'minTc', 'maxTc'];

/** 编辑 Take 时的乐观并发依据：Take 行与所属场次行打开弹窗时的 updatedAt */
export interface TakeWriteContext {
  expectedUpdatedAt?: number;
  expectedSessionUpdatedAt?: number;
}

interface TakeState {
  filters: FilterModel;
  selectedIds: string[];
  setFilters: (next: FilterModel) => void;
  resetFilters: () => void;
  toggleSelected: (id: string) => void;
  setSelected: (ids: string[]) => void;
  createTake: (payload: Omit<Take, 'id'>) => Promise<string>;
  editTake: (id: string, patch: Partial<Take>, context?: TakeWriteContext) => Promise<TakeSaveResult>;
  deleteTake: (id: string) => Promise<void>;
  batchGrade: (ids: string[], grade: Take['grade']) => Promise<TakeSaveResult>;
}

export const useTakeStore = create<TakeState>()((set, get) => ({
  filters: { keyword: '', grades: [], issues: [], sessionIds: [], minTc: '', maxTc: '' },
  selectedIds: [],
  setFilters: (next) => set({ filters: next }),
  resetFilters: () =>
    set({ filters: { keyword: '', grades: [], issues: [], sessionIds: [], minTc: '', maxTc: '' } }),
  toggleSelected: (id) =>
    set((state) => ({
      selectedIds: state.selectedIds.includes(id)
        ? state.selectedIds.filter((item) => item !== id)
        : [...state.selectedIds, id]
    })),
  setSelected: (ids) => set({ selectedIds: ids }),
  createTake: async (payload) => {
    const row = buildRow(payload, 'take');
    await putTake(row);
    return row.id;
  },
  editTake: async (id, patch, context) => {
    const result = await updateTake(id, patch, context);
    return result;
  },
  deleteTake: async (id) => {
    await removeTake(id);
    set((state) => ({ selectedIds: state.selectedIds.filter((item) => item !== id) }));
  },
  batchGrade: async (ids, grade) => {
    const result = await bulkUpdateGrade(ids, grade);
    set({ selectedIds: [] });
    void get();
    return result;
  }
}));
