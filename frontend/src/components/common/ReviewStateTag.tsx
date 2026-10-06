/**
 * ReviewStateTag：优选复核状态标签。
 * 源 Take 的时间码 / 评级 / 问题标签一改动，优选立刻变为「待复核」。
 */
import { Tag, Tooltip } from 'antd';
import { CheckCircleOutlined, EyeOutlined } from '@ant-design/icons';
import type { PickRow } from '@/utils/db';

interface ReviewStateTagProps {
  pick: Pick<PickRow, 'reviewState' | 'reviewNote'>;
}

export default function ReviewStateTag({ pick }: ReviewStateTagProps) {
  if (pick.reviewState === '待复核') {
    return (
      <Tooltip title={pick.reviewNote || '源 Take 已改动，优选失效，待制作人复核'}>
        <Tag icon={<EyeOutlined />} color="orange" style={{ marginInlineEnd: 0 }}>
          待复核
        </Tag>
      </Tooltip>
    );
  }
  return (
    <Tag icon={<CheckCircleOutlined />} color="green" style={{ marginInlineEnd: 0 }}>
      生效中
    </Tag>
  );
}
