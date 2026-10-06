/**
 * LockStatusTag：场次封版状态标签。
 * 封版后录音师对场次及其 Take / 优选 / 补录只读。
 */
import { Tag, Tooltip } from 'antd';
import { LockOutlined, UnlockOutlined } from '@ant-design/icons';
import type { SessionRow } from '@/utils/db';
import { formatStamp } from '@/utils/lockdown';

interface LockStatusTagProps {
  session: Pick<SessionRow, 'finalized' | 'lockLogs'>;
}

export default function LockStatusTag({ session }: LockStatusTagProps) {
  if (!session.finalized) {
    return (
      <Tag icon={<UnlockOutlined />} color="green">
        未封版
      </Tag>
    );
  }
  const last = session.lockLogs[session.lockLogs.length - 1];
  const tooltip = last ? `已于 ${formatStamp(last.at)} 由${last.role}封版` : '场次已封版';
  return (
    <Tooltip title={tooltip}>
      <Tag icon={<LockOutlined />} color="red">
        已封版
      </Tag>
    </Tooltip>
  );
}
