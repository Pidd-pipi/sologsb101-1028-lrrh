/**
 * RoleSwitch：制作人 / 录音师角色切换。
 * 制作人可封版 / 重开场次；录音师在场次封版后仅可查看。
 * 角色存放在 sessionStore，跨页共享。
 */
import { Segmented, Space, Tag, Tooltip } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { useSessionStore } from '@/stores/sessionStore';
import { STUDIO_ROLES, type StudioRole } from '@/utils/lockdown';

interface RoleSwitchProps {
  /** 紧凑模式：只显示当前角色 Tag（用于只读展示的页面） */
  compact?: boolean;
}

export default function RoleSwitch({ compact = false }: RoleSwitchProps) {
  const role = useSessionStore((state) => state.role);
  const setRole = useSessionStore((state) => state.setRole);

  if (compact) {
    return (
      <Tooltip title={role === '制作人' ? '制作人：可封版 / 重开场次' : '录音师：场次封版后仅可查看'}>
        <Tag icon={role === '制作人' ? <UserOutlined /> : <LockOutlined />} color={role === '制作人' ? 'gold' : 'blue'}>
          当前角色：{role}
        </Tag>
      </Tooltip>
    );
  }

  return (
    <Space size={6}>
      <span className="filter-bar__label">当前角色</span>
      <Segmented
        value={role}
        onChange={(value) => setRole(value as StudioRole)}
        options={STUDIO_ROLES.map((item) => ({
          label: item,
          value: item,
          icon: item === '制作人' ? <UserOutlined /> : <LockOutlined />
        }))}
      />
    </Space>
  );
}
