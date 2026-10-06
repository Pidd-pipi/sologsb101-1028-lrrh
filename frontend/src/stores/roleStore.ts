/**
 * 角色 store：制作人 / 录音师 / 棚务统筹 的当前身份（仅本地）。
 * 制作人可封版场次、重开（写原因）与复核优选；封版后所有角色对场次只读。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { STUDIO_ROLES, isProducerRole, type StudioRole } from '@/types/role';

interface RoleState {
  role: StudioRole;
  setRole: (role: StudioRole) => void;
  /** 是否为制作人（封版 / 重开 / 复核权限判断） */
  isProducer: () => boolean;
}

export const useRoleStore = create<RoleState>()(
  persist(
    (set, get) => ({
      role: '制作人',
      setRole: (role) => set({ role }),
      isProducer: () => isProducerRole(get().role)
    }),
    { name: 'gbstudiotake-role' }
  )
);

export { STUDIO_ROLES };
