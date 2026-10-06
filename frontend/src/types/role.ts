/** 棚内角色：制作人负责封版 / 重开，录音师负责标记 Take，棚务统筹负责补录排期 */
export type StudioRole = '制作人' | '录音师' | '棚务统筹';

export const STUDIO_ROLES: StudioRole[] = ['制作人', '录音师', '棚务统筹'];

/** 角色说明：顶栏切换身份时提示各自权限 */
export const ROLE_DESCRIPTIONS: Record<StudioRole, string> = {
  制作人: '封版场次、重开（需写原因）、复核优选 Take',
  录音师: '标记时间码 / 评级 / 问题标签；封版后场次只读',
  棚务统筹: '排补录计划；场次封版后同样只读'
};

export function isProducerRole(role: StudioRole): boolean {
  return role === '制作人';
}
