/**
 * 场次 store：维护场次排期、棚号占用校验、封版状态与筛选条件。
 * 制作人可封版 / 重开（重开需原因）；封版后场次及其 Take / 优选 / 补录只读。
 */
import { create } from 'zustand';
import type { FilterModel } from '@/types/filter';
import type { Session } from '@/types/session';
import {
  finalizeSession,
  findRoomConflict,
  putSession,
  removeSession,
  reopenSession,
  updateSession
} from '@/utils/db';
import { buildRow } from '@/hooks/useIdbTable';
import type { StudioRole } from '@/utils/lockdown';

export const SESSION_FILTER_KEYS = ['rooms', 'periods', 'states'];

interface SessionState {
  filters: FilterModel;
  currentSessionId: string | null;
  /** 当前操作角色：制作人可封版；录音师封版后只读 */
  role: StudioRole;
  setFilters: (next: FilterModel) => void;
  resetFilters: () => void;
  selectSession: (id: string | null) => void;
  setRole: (role: StudioRole) => void;
  createSession: (payload: Omit<Session, 'id'>) => Promise<string>;
  editSession: (id: string, patch: Partial<Session>, expectedUpdatedAt?: number) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  lockSession: (id: string, expectedUpdatedAt?: number) => Promise<void>;
  reopenSession: (id: string, reason: string, expectedUpdatedAt?: number) => Promise<void>;
  assertRoomFree: (roomNo: string, date: string, period: string, selfId: string | null) => Promise<void>;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  filters: { keyword: '', rooms: [], periods: [], states: [] },
  currentSessionId: null,
  role: '制作人',
  setFilters: (next) => set({ filters: next }),
  resetFilters: () => set({ filters: { keyword: '', rooms: [], periods: [], states: [] } }),
  selectSession: (id) => set({ currentSessionId: id }),
  setRole: (role) => set({ role }),
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
    await updateSession(id, current, { expectedUpdatedAt });
  },
  deleteSession: async (id) => {
    await removeSession(id);
    if (get().currentSessionId === id) set({ currentSessionId: null });
  },
  lockSession: async (id, expectedUpdatedAt) => {
    if (get().role !== '制作人') throw new Error('只有制作人可以封版场次');
    await finalizeSession(id, get().role, { expectedUpdatedAt });
  },
  reopenSession: async (id, reason, expectedUpdatedAt) => {
    if (get().role !== '制作人') throw new Error('只有制作人可以重开场次');
    await reopenSession(id, reason, get().role, { expectedUpdatedAt });
  }
}));
