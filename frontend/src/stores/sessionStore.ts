/**
 * 场次 store：维护场次排期、棚号占用校验、封版筛选，以及封版 / 重开动作。
 */
import { create } from 'zustand';
import type { FilterModel } from '@/types/filter';
import type { Session } from '@/types/session';
import {
  findRoomConflict,
  lockSession as lockSessionRow,
  putSession,
  removeSession,
  reopenSession as reopenSessionRow,
  saveSession
} from '@/utils/db';
import { buildRow } from '@/hooks/useIdbTable';

export const SESSION_FILTER_KEYS = ['rooms', 'periods', 'states', 'lockStates'];

interface SessionState {
  filters: FilterModel;
  currentSessionId: string | null;
  setFilters: (next: FilterModel) => void;
  resetFilters: () => void;
  selectSession: (id: string | null) => void;
  createSession: (payload: Omit<Session, 'id'>) => Promise<string>;
  /** 保存场次编辑；expectedUpdatedAt 为表单基于的版本，落后保存会被守卫拒绝 */
  editSession: (id: string, patch: Partial<Session>, expectedUpdatedAt?: number) => Promise<void>;
  /** 制作人封版 */
  lockSession: (id: string, actor: string) => Promise<void>;
  /** 制作人重开（必须写原因） */
  reopenSession: (id: string, actor: string, reason: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  assertRoomFree: (roomNo: string, date: string, period: string, selfId: string | null) => Promise<void>;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  filters: { keyword: '', rooms: [], periods: [], states: [], lockStates: [] },
  currentSessionId: null,
  setFilters: (next) => set({ filters: next }),
  resetFilters: () =>
    set({ filters: { keyword: '', rooms: [], periods: [], states: [], lockStates: [] } }),
  selectSession: (id) => set({ currentSessionId: id }),
  assertRoomFree: async (roomNo, date, period, selfId) => {
    const conflict = await findRoomConflict(roomNo, date, period, selfId);
    if (conflict) {
      throw new Error(`${roomNo} 在 ${date} ${period} 已被场次占用（场次 ${conflict.id}），请换棚或换时段`);
    }
  },
  createSession: async (payload) => {
    await get().assertRoomFree(payload.roomNo, payload.date, payload.period, null);
    const row = buildRow(payload, 'session');
    await putSession(row);
    set({ currentSessionId: row.id });
    return row.id;
  },
  editSession: async (id, patch, expectedUpdatedAt) => {
    const current = { ...patch } as Partial<Session>;
    if (patch.roomNo && patch.date && patch.period) {
      await get().assertRoomFree(patch.roomNo, patch.date, patch.period, id);
    }
    await saveSession(id, current, expectedUpdatedAt);
  },
  lockSession: async (id, actor) => {
    await lockSessionRow(id, actor);
  },
  reopenSession: async (id, actor, reason) => {
    await reopenSessionRow(id, actor, reason);
  },
  deleteSession: async (id) => {
    await removeSession(id);
    if (get().currentSessionId === id) set({ currentSessionId: null });
  }
}));
