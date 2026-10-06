/**
 * Take store：维护条次列表的评级 / 问题标签 / 时间码筛选，以及批量改评级。
 * 写入统一过持久化层的封版守卫与改动级联（优选失效、补录退回）。
 */
import { create } from 'zustand';
import type { FilterModel } from '@/types/filter';
import type { Take } from '@/types/take';
import {
  bulkUpdateGrade,
  putTake,
  removeTake,
  saveTake,
  type TakeCascade
} from '@/utils/db';
import { buildRow } from '@/hooks/useIdbTable';

export const TAKE_FILTER_KEYS = ['grades', 'issues', 'sessionIds', 'minTc', 'maxTc'];

interface TakeState {
  filters: FilterModel;
  selectedIds: string[];
  setFilters: (next: FilterModel) => void;
  resetFilters: () => void;
  toggleSelected: (id: string) => void;
  setSelected: (ids: string[]) => void;
  createTake: (payload: Omit<Take, 'id'>) => Promise<string>;
  /** 保存条次编辑；expectedUpdatedAt 用于乐观并发，返回优选 / 补录级联计数 */
  editTake: (id: string, patch: Partial<Take>, expectedUpdatedAt?: number) => Promise<TakeCascade>;
  deleteTake: (id: string) => Promise<void>;
  batchGrade: (ids: string[], grade: Take['grade']) => Promise<TakeCascade>;
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
  editTake: async (id, patch, expectedUpdatedAt) => {
    return saveTake(id, patch, expectedUpdatedAt);
  },
  deleteTake: async (id) => {
    await removeTake(id);
    set((state) => ({ selectedIds: state.selectedIds.filter((item) => item !== id) }));
  },
  batchGrade: async (ids, grade) => {
    const cascade = await bulkUpdateGrade(ids, grade);
    set({ selectedIds: [] });
    void get();
    return cascade;
  }
}));
