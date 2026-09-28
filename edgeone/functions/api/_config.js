// 科诺美线索系统 - 共享配置（单一事实源）
// 角色枚举 / 大区→下辖成员映射 / 关键表头名 / 日志事件枚举
// 注意：「负责大区」列存的是大区总姓名（与 users.region 口径一致）。

export const ROLES = { ADMIN: 'admin', REGION: 'region', SALES: 'sales' };

// 大区映射（与 users 表 subordinates 保持一致；含大区总本人）
export const REGION_MEMBERS = {
  '汤显义': ['高丹枫', '高雷', '王泽', '王远帅', '黄江锐', '胡雨来', '汤显义'],
  '管能': ['管能', '刘力瑞'],
  '穆忠仁': ['穆忠仁'],
  '刘健凯': ['刘健凯']   // 海外大区（大区总本人兼唯一成员）
};

// 关键表头名（一律按名称定位列，禁止硬编码列索引；FALLBACK 仅为表头缺失时兜底）
export const H = {
  LEAD_ID: '线索编号',
  LEAD_OWNER: '负责人',
  LEAD_REGION: '负责大区',
  FUP_ID: '跟进编号',
  FUP_LEAD_ID: '线索编号',
  FUP_OWNER: '负责人'
};
export const FALLBACK = {
  LEAD_ID: 0, LEAD_OWNER: 13, LEAD_REGION: 14,
  FUP_ID: 0, FUP_LEAD_ID: 1, FUP_OWNER: 13
};

// 日志事件枚举
export const LOG_EVENTS = [
  'login_success', 'login_failed', 'logout',
  'create', 'update', 'delete', 'import', 'export', 'forbidden'
];
// POST /api/logs 仅放行的 session 级事件（防前端伪造数据类日志）
export const SESSION_EVENTS = ['logout', 'export'];

// 单次 POST 新增 ≥ 该阈值时聚合为一条 import 日志
export const IMPORT_THRESHOLD = 10;

// 批量删除保护：单次 POST 删除 ≥ 该阈值时必须显式确认（body.confirmBulkDelete === true），
// 否则整体拒绝 —— 防止前端旧快照全量覆盖被误判为批量删除（2026-09-23 事故根因防线）。
export const BULK_DELETE_THRESHOLD = 10;

// 大区总姓名 → 下辖成员（含本人）
export function regionMembers(region) {
  return REGION_MEMBERS[region] || (region ? [region] : []);
}

// 成员姓名 → 所属大区总姓名（用于 followups 触达 R: 分片）
export function regionOfMember(name) {
  if (!name) return '';
  for (const region in REGION_MEMBERS) {
    if (REGION_MEMBERS[region].indexOf(name) >= 0) return region;
  }
  return '';
}
