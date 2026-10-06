/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbstudiotake-db，数据结构版本号 version(2) 与 upgrade() 迁移逻辑
 * - 项目 / 曲目 / 场次 / Take / 优选 / 补录 六张表分表存储
 * - 首次打开自动播种互相引用的演示数据，保证每个页面打开都有内容
 * - v2：场次封版（lockState 等字段）、优选复核（reviewState）、补录关联 Take（takeId）；
 *       Take / 场次写入口带封版守卫与乐观并发，Take 关键字段改动级联优选失效与补录退回。
 */
import Dexie, { type Table } from 'dexie';
import type { Project } from '../types/project';
import type { Song } from '../types/song';
import type { Session, SessionLockEntry } from '../types/session';
import type { Take } from '../types/take';
import type { Pick } from '../types/pick';
import type { Retake } from '../types/retake';
import { nowIso } from './uuid';
import { seedDatabase } from './seed';
import { ROW_REVISION } from './revision';
import { SessionLockedError, assertNotStale, lockedMessage } from './guards';

/** 数据库名 */
export const DB_NAME = 'gbstudiotake-db';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2;

/** 行结构修订号（定义在叶子模块 ./revision，避免与 ./seed 形成循环依赖） */
export { ROW_REVISION };

export interface Revisioned {
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type ProjectRow = Project & Revisioned;
export type SongRow = Song & Revisioned;
export type SessionRow = Session & Revisioned;
export type TakeRow = Take & Revisioned;
export type PickRow = Pick & Revisioned;
export type RetakeRow = Retake & Revisioned;

/** Take 关键字段改动对优选 / 补录造成的级联结果 */
export interface TakeCascade {
  /** 失效待复核的优选数 */
  invalidatedPicks: number;
  /** 退回待安排的补录计划数 */
  demotedRetakes: number;
}

export class GbStudioTakeDatabase extends Dexie {
  projects!: Table<ProjectRow, string>;
  songs!: Table<SongRow, string>;
  sessions!: Table<SessionRow, string>;
  takes!: Table<TakeRow, string>;
  picks!: Table<PickRow, string>;
  retakes!: Table<RetakeRow, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版六表结构（保留声明，Dexie 要求逐版本描述演进）
    this.version(1)
      .stores({
        projects: 'id, name, client, state, startDate, updatedAt',
        songs: 'id, projectId, title, arrangement, state, updatedAt',
        sessions: 'id, songId, date, period, roomNo, engineer, state, updatedAt',
        takes: 'id, sessionId, takeNo, grade, startTc, updatedAt',
        picks: 'id, takeId, usage, order, updatedAt',
        retakes: 'id, songId, planDate, state, updatedAt'
      })
      .upgrade(async (tx) => {
        // v1 迁移：为历史行补齐行修订号与时间戳（新建库各表为空，天然幂等）
        const tableNames = ['projects', 'songs', 'sessions', 'takes', 'picks', 'retakes'];
        for (const name of tableNames) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              stampMeta(row);
            });
        }
      });

    // v2：场次封版、优选复核、补录关联 Take（新增索引不影响既有索引）
    this.version(2).stores({
      projects: 'id, name, client, state, startDate, updatedAt',
      songs: 'id, projectId, title, arrangement, state, updatedAt',
      sessions: 'id, songId, date, period, roomNo, engineer, state, lockState, updatedAt',
      takes: 'id, sessionId, takeNo, grade, startTc, updatedAt',
      picks: 'id, takeId, usage, order, reviewState, updatedAt',
      retakes: 'id, songId, takeId, planDate, state, updatedAt'
    });

    // v2 行迁移：补齐 v2 新字段（v1 行的 revision/时间戳已存在，stampMeta 仅补缺）
    this.version(DB_SCHEMA_VERSION).upgrade(async (tx) => {
      await tx
        .table('projects')
        .toCollection()
        .modify((row: Record<string, unknown>) => {
          stampMeta(row);
        });
      await tx
        .table('songs')
        .toCollection()
        .modify((row: Record<string, unknown>) => {
          stampMeta(row);
        });
      await tx
        .table('sessions')
        .toCollection()
        .modify((row: Record<string, unknown>) => {
          stampMeta(row);
          if (row.lockState !== '已封版') row.lockState = '未封版';
          if (typeof row.lockedAt !== 'string') row.lockedAt = '';
          if (typeof row.lockedBy !== 'string') row.lockedBy = '';
          if (typeof row.reopenReason !== 'string') row.reopenReason = '';
          if (!Array.isArray(row.lockHistory)) row.lockHistory = [];
        });
      await tx
        .table('takes')
        .toCollection()
        .modify((row: Record<string, unknown>) => {
          stampMeta(row);
        });
      await tx
        .table('picks')
        .toCollection()
        .modify((row: Record<string, unknown>) => {
          stampMeta(row);
          if (row.reviewState !== '待复核') row.reviewState = '有效';
          if (typeof row.reviewNote !== 'string') row.reviewNote = '';
        });
      await tx
        .table('retakes')
        .toCollection()
        .modify((row: Record<string, unknown>) => {
          stampMeta(row);
          if (typeof row.takeId !== 'string') row.takeId = '';
        });
    });
  }
}

/** upgrade 用：为历史行补齐行修订号与时间戳 */
function stampMeta(row: Record<string, unknown>): void {
  row.revision = ROW_REVISION;
  if (typeof row.createdAt !== 'number') row.createdAt = Date.now();
  if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt;
}

export const db = new GbStudioTakeDatabase();

/** 打开数据库：首次使用时灌入演示数据（幂等：表非空不播） */
export async function initDatabase(): Promise<void> {
  await db.open();
  if ((await db.projects.count()) === 0) {
    await seedDatabase(db);
  }
}

/* ------------------------------ 项目 ------------------------------ */

export async function listProjects(): Promise<ProjectRow[]> {
  const rows = await db.projects.toArray();
  return rows.sort((a, b) => b.startDate.localeCompare(a.startDate));
}

export async function putProject(row: ProjectRow): Promise<void> {
  await db.projects.put(row);
}

export async function updateProject(id: string, patch: Partial<Project>): Promise<void> {
  await db.projects.update(id, { ...patch, updatedAt: Date.now() } as never);
}

/** 删除项目：级联删除曲目、场次、Take、优选与补录 */
export async function removeProject(id: string): Promise<void> {
  await db.transaction('rw', [db.projects, db.songs, db.sessions, db.takes, db.picks, db.retakes], async () => {
    const songs = await db.songs.where('projectId').equals(id).toArray();
    for (const song of songs) {
      await cascadeRemoveSong(song.id);
    }
    await db.projects.delete(id);
  });
}

/* ------------------------------ 曲目 ------------------------------ */

export async function listSongs(): Promise<SongRow[]> {
  const rows = await db.songs.toArray();
  return rows.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
}

export async function putSong(row: SongRow): Promise<void> {
  await db.songs.put(row);
}

export async function updateSong(id: string, patch: Partial<Song>): Promise<void> {
  await db.songs.update(id, { ...patch, updatedAt: Date.now() } as never);
}

async function cascadeRemoveSong(songId: string): Promise<void> {
  const sessions = await db.sessions.where('songId').equals(songId).toArray();
  const sessionIds = sessions.map((item) => item.id);
  if (sessionIds.length > 0) {
    const takes = await db.takes.where('sessionId').anyOf(sessionIds).toArray();
    const takeIds = takes.map((item) => item.id);
    if (takeIds.length > 0) {
      await db.picks.where('takeId').anyOf(takeIds).delete();
      await db.retakes.where('takeId').anyOf(takeIds).modify({ takeId: '' } as never);
    }
    await db.takes.where('sessionId').anyOf(sessionIds).delete();
    await db.sessions.where('songId').equals(songId).delete();
  }
  await db.retakes.where('songId').equals(songId).delete();
  await db.songs.delete(songId);
}

export async function removeSong(id: string): Promise<void> {
  await db.transaction('rw', [db.songs, db.sessions, db.takes, db.picks, db.retakes], async () => {
    await cascadeRemoveSong(id);
  });
}

/* ------------------------------ 场次（封版 / 并发守卫） ------------------------------ */

export async function listSessions(): Promise<SessionRow[]> {
  const rows = await db.sessions.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function putSession(row: SessionRow): Promise<void> {
  await db.sessions.put(row);
}

/**
 * 保存场次编辑（乐观并发 + 封版守卫）。
 * @param expectedUpdatedAt 表单打开时读到的 updatedAt；与库里不一致说明另一标签页已写入
 */
export async function saveSession(
  id: string,
  patch: Partial<Session>,
  expectedUpdatedAt?: number
): Promise<void> {
  await db.transaction('rw', [db.sessions], async () => {
    const current = await db.sessions.get(id);
    if (!current) throw new Error('场次不存在或已被其它标签页删除');
    if (current.lockState === '已封版') {
      throw new SessionLockedError(lockedMessage(current));
    }
    assertNotStale(current, expectedUpdatedAt, '场次');
    await db.sessions.update(id, { ...patch, updatedAt: Date.now() } as never);
  });
}

/** 兼容旧调用名：不带并发期望的场次更新（内部联动用） */
export async function updateSession(id: string, patch: Partial<Session>): Promise<void> {
  await saveSession(id, patch);
}

/** 制作人封版：封版后录音师只可查看；重复封版幂等 */
export async function lockSession(id: string, actor: string): Promise<void> {
  await db.transaction('rw', [db.sessions], async () => {
    const current = await db.sessions.get(id);
    if (!current) throw new Error('场次不存在或已被其它标签页删除');
    if (current.lockState === '已封版') {
      throw new SessionLockedError(lockedMessage(current));
    }
    const at = nowIso();
    const entry: SessionLockEntry = { action: '封版', actor, at, reason: '' };
    await db.sessions.update(id, {
      lockState: '已封版',
      lockedAt: at,
      lockedBy: actor,
      reopenReason: '',
      lockHistory: [...current.lockHistory, entry],
      updatedAt: Date.now()
    } as never);
  });
}

/** 制作人重开：必须写原因，留痕后场次恢复可编辑 */
export async function reopenSession(id: string, actor: string, reason: string): Promise<void> {
  const trimmed = reason.trim();
  if (!trimmed) throw new Error('重开场次必须填写原因');
  await db.transaction('rw', [db.sessions], async () => {
    const current = await db.sessions.get(id);
    if (!current) throw new Error('场次不存在或已被其它标签页删除');
    if (current.lockState !== '已封版') return;
    const at = nowIso();
    const entry: SessionLockEntry = { action: '重开', actor, at, reason: trimmed };
    await db.sessions.update(id, {
      lockState: '未封版',
      reopenReason: trimmed,
      lockHistory: [...current.lockHistory, entry],
      updatedAt: Date.now()
    } as never);
  });
}

/**
 * 校验棚号时段冲突：同一棚号同一日期同一时段只能有一场（已取消的除外）
 * @param selfId 编辑自身时排除
 */
export async function findRoomConflict(
  roomNo: string,
  date: string,
  period: string,
  selfId: string | null
): Promise<SessionRow | null> {
  const rows = await db.sessions
    .where('roomNo')
    .equals(roomNo)
    .filter((item) => item.date === date && item.period === period && item.state !== '已取消' && item.id !== selfId)
    .toArray();
  return rows[0] ?? null;
}

/** 删除场次：级联删除其 Take 与对应优选；已封版场次拒绝删除（重开后再删） */
export async function removeSession(id: string): Promise<void> {
  await db.transaction('rw', [db.sessions, db.takes, db.picks, db.retakes], async () => {
    const session = await db.sessions.get(id);
    if (session?.lockState === '已封版') {
      throw new SessionLockedError(lockedMessage(session));
    }
    const takes = await db.takes.where('sessionId').equals(id).toArray();
    const takeIds = takes.map((item) => item.id);
    if (takeIds.length > 0) {
      await db.picks.where('takeId').anyOf(takeIds).delete();
      await db.retakes.where('takeId').anyOf(takeIds).modify({ takeId: '' } as never);
    }
    await db.takes.where('sessionId').equals(id).delete();
    await db.sessions.delete(id);
  });
}

/* ----------------------- Take（封版守卫 + 改动级联） ----------------------- */

/** 触发优选失效 / 补录退回的关键字段 */
const TAKE_WATCHED_KEYS = ['startTc', 'endTc', 'grade', 'issues'] as const;

/** 优选失效文案 */
function pickInvalidNote(patch: Partial<Take>): string {
  const parts: string[] = [];
  if (patch.startTc !== undefined || patch.endTc !== undefined) parts.push('时间码');
  if (patch.grade !== undefined) parts.push(`评级改为「${patch.grade}」`);
  if (patch.issues !== undefined) parts.push(`问题标签改为「${patch.issues.filter((item) => item !== '无').join('、') || '无'}」`);
  return `来源 Take${parts.join('、')}，优选失效待复核`;
}

/**
 * Take 关键字段改动的级联：
 * - 该 Take 的优选立刻失效待复核
 * - 关联该 Take 的「已排期」补录计划退回待安排
 * @returns 级联计数
 */
async function cascadeTakeChanged(takeId: string, reason: string): Promise<TakeCascade> {
  const invalidatedPicks = await db.picks
    .where('takeId')
    .equals(takeId)
    .modify({ reviewState: '待复核', reviewNote: reason, updatedAt: Date.now() } as never);
  const demotedRetakes = await db.retakes
    .where('takeId')
    .equals(takeId)
    .filter((item) => item.state === '已排期')
    .modify({ state: '待安排', updatedAt: Date.now() } as never);
  return { invalidatedPicks, demotedRetakes };
}

export async function listTakes(): Promise<TakeRow[]> {
  return db.takes.toArray();
}

/** 新增 Take：所属场次已封版则只可查看，拒绝写入 */
export async function putTake(row: TakeRow): Promise<void> {
  await db.transaction('rw', [db.sessions, db.takes], async () => {
    const session = await db.sessions.get(row.sessionId);
    if (session?.lockState === '已封版') {
      throw new SessionLockedError(lockedMessage(session));
    }
    await db.takes.put(row);
  });
}

/**
 * 保存 Take 编辑（封版守卫 + 乐观并发）。
 * 时间码 / 评级 / 问题标签任一改动，优选立刻失效待复核、已排期补录退回待安排。
 * @param expectedUpdatedAt 表单打开时读到的 updatedAt
 */
export async function saveTake(
  id: string,
  patch: Partial<Take>,
  expectedUpdatedAt?: number
): Promise<TakeCascade> {
  return db.transaction('rw', [db.sessions, db.takes, db.picks, db.retakes], async () => {
    const current = await db.takes.get(id);
    if (!current) throw new Error('条次不存在或已被其它标签页删除');
    // 原场次封版：不允许任何改动（包括把条次挪走）
    const originSession = await db.sessions.get(current.sessionId);
    if (originSession?.lockState === '已封版') {
      throw new SessionLockedError(lockedMessage(originSession));
    }
    // 改挂到别的场次：目标场次若已封版同样只读
    const targetSessionId = patch.sessionId ?? current.sessionId;
    if (targetSessionId !== current.sessionId) {
      const targetSession = await db.sessions.get(targetSessionId);
      if (targetSession?.lockState === '已封版') {
        throw new SessionLockedError(lockedMessage(targetSession));
      }
    }
    assertNotStale(current, expectedUpdatedAt, '该条次所属场次');

    const watchedChanged = TAKE_WATCHED_KEYS.some((key) => {
      const next = patch[key];
      if (next === undefined) return false;
      if (key === 'issues') return JSON.stringify(next) !== JSON.stringify(current.issues);
      return next !== current[key];
    });

    await db.takes.update(id, { ...patch, updatedAt: Date.now() } as never);
    if (!watchedChanged) return { invalidatedPicks: 0, demotedRetakes: 0 };
    return cascadeTakeChanged(id, pickInvalidNote(patch));
  });
}

/** 兼容旧调用名：不带并发期望的条次更新（内部联动用） */
export async function updateTake(id: string, patch: Partial<Take>): Promise<TakeCascade> {
  return saveTake(id, patch);
}

/**
 * 批量改评级：封版场次的条次全部跳过，未封版场次的条次正常写入并触发级联。
 * @returns 级联计数合计
 */
export async function bulkUpdateGrade(ids: string[], grade: Take['grade']): Promise<TakeCascade> {
  return db.transaction('rw', [db.sessions, db.takes, db.picks, db.retakes], async () => {
    const total: TakeCascade = { invalidatedPicks: 0, demotedRetakes: 0 };
    for (const id of ids) {
      const take = await db.takes.get(id);
      if (!take) continue;
      const session = await db.sessions.get(take.sessionId);
      if (session?.lockState === '已封版') {
        throw new SessionLockedError(`选中的条次属于已封版场次（${session.date} ${session.period} · ${session.roomNo}），只可查看，不能批量改评级`);
      }
      if (take.grade === grade) continue;
      await db.takes.update(id, { grade, updatedAt: Date.now() } as never);
      const cascade = await cascadeTakeChanged(id, pickInvalidNote({ grade }));
      total.invalidatedPicks += cascade.invalidatedPicks;
      total.demotedRetakes += cascade.demotedRetakes;
    }
    return total;
  });
}

/** 删除 Take：封版场次拒绝；关联优选级联删除，关联补录解除 takeId 保留计划 */
export async function removeTake(id: string): Promise<void> {
  await db.transaction('rw', [db.sessions, db.takes, db.picks, db.retakes], async () => {
    const take = await db.takes.get(id);
    if (take) {
      const session = await db.sessions.get(take.sessionId);
      if (session?.lockState === '已封版') {
        throw new SessionLockedError(lockedMessage(session));
      }
    }
    await db.picks.where('takeId').equals(id).delete();
    await db.retakes.where('takeId').equals(id).modify({ takeId: '' } as never);
    await db.takes.delete(id);
  });
}

/* ------------------------------ 优选（复核 / 封版只读） ------------------------------ */

export async function listPicks(): Promise<PickRow[]> {
  const rows = await db.picks.toArray();
  return rows.sort((a, b) => a.order - b.order);
}

/** 新增优选：来源 Take 所属场次已封版则拒绝（封版后只可查看） */
export async function putPick(row: PickRow): Promise<void> {
  await db.transaction('rw', [db.sessions, db.takes, db.picks], async () => {
    const take = await db.takes.get(row.takeId);
    if (take) {
      const session = await db.sessions.get(take.sessionId);
      if (session?.lockState === '已封版') {
        throw new SessionLockedError(`该条次所属场次已封版（${session.date} ${session.period} · ${session.roomNo}），优选只读，请由制作人先重开场次`);
      }
    }
    await db.picks.put(row);
  });
}

/** 编辑优选：来源场次（含改指向的新场次）已封版则只读 */
export async function updatePick(id: string, patch: Partial<Pick>): Promise<void> {
  await db.transaction('rw', [db.sessions, db.takes, db.picks], async () => {
    const pick = await db.picks.get(id);
    if (!pick) throw new Error('优选记录不存在或已被其它标签页删除');
    const targetTakeIds = [pick.takeId];
    if (patch.takeId !== undefined && patch.takeId !== pick.takeId) targetTakeIds.push(patch.takeId);
    for (const takeId of targetTakeIds) {
      const take = await db.takes.get(takeId);
      const session = take ? await db.sessions.get(take.sessionId) : undefined;
      if (session?.lockState === '已封版') {
        throw new SessionLockedError(`该优选所属场次已封版（${session.date} ${session.period} · ${session.roomNo}），只可查看，请由制作人先重开场次`);
      }
    }
    await db.picks.update(id, { ...patch, updatedAt: Date.now() } as never);
  });
}

/** 制作人复核通过：优选恢复有效并清空失效原因 */
export async function reviewPick(id: string): Promise<void> {
  await db.picks.update(id, { reviewState: '有效', reviewNote: '', updatedAt: Date.now() } as never);
}

/** 拖拽 / 上下移后按新顺序批量写回：列表内任一条所属场次已封版则整批拒绝（避免旧顺序覆盖） */
export async function reorderPicks(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', [db.sessions, db.takes, db.picks], async () => {
    const picks = await db.picks.where('id').anyOf(orderedIds).toArray();
    for (const pick of picks) {
      const take = await db.takes.get(pick.takeId);
      const session = take ? await db.sessions.get(take.sessionId) : undefined;
      if (session?.lockState === '已封版') {
        throw new SessionLockedError(`剪接清单含已封版场次（${session.date} ${session.period} · ${session.roomNo}）的优选，顺序只读`);
      }
    }
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.picks.update(orderedIds[index], { order: index + 1, updatedAt: Date.now() } as never);
    }
  });
}

export async function nextPickOrder(): Promise<number> {
  const rows = await db.picks.toArray();
  return rows.reduce((max, row) => Math.max(max, row.order), 0) + 1;
}

export async function removePick(id: string): Promise<void> {
  await db.picks.delete(id);
}

/* ------------------------------ 补录 ------------------------------ */

export async function listRetakes(): Promise<RetakeRow[]> {
  const rows = await db.retakes.toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function putRetake(row: RetakeRow): Promise<void> {
  await db.retakes.put(row);
}

export async function updateRetake(id: string, patch: Partial<Retake>): Promise<void> {
  await db.retakes.update(id, { ...patch, updatedAt: Date.now() } as never);
}

/** 补录完成：联动曲目状态 */
export async function completeRetake(id: string): Promise<void> {
  await db.transaction('rw', [db.retakes, db.songs], async () => {
    const retake = await db.retakes.get(id);
    if (!retake) throw new Error('补录条目不存在');
    await db.retakes.update(id, { state: '已完成', updatedAt: Date.now() } as never);
    const pending = await db.retakes
      .where('songId')
      .equals(retake.songId)
      .filter((item) => item.state !== '已完成' && item.id !== id)
      .count();
    await db.songs.update(retake.songId, { state: pending === 0 ? '已完成' : '录制中', updatedAt: Date.now() } as never);
  });
}

export async function removeRetake(id: string): Promise<void> {
  await db.retakes.delete(id);
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  projects: Project[];
  sessions: Session[];
  songs: Song[];
  takes: Take[];
  picks: Pick[];
  retakes: Retake[];
}

function stripRow<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>;
  delete copy.revision;
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy as Omit<T, keyof Revisioned>;
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [projects, songs, sessions, takes, picks, retakes] = await Promise.all([
    db.projects.toArray(),
    db.songs.toArray(),
    db.sessions.toArray(),
    db.takes.toArray(),
    db.picks.toArray(),
    db.retakes.toArray()
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    projects: projects.map(stripRow),
    songs: songs.map(stripRow),
    sessions: sessions.map(stripRow),
    takes: takes.map(stripRow),
    picks: picks.map(stripRow),
    retakes: retakes.map(stripRow)
  };
}

function stamp<T>(row: T): T & Revisioned {
  const now = Date.now();
  return { ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now };
}

/** 为导入的历史快照补齐 v2 新字段（旧备份缺字段时也能正常入库） */
function normalizeImported(snapshot: DatabaseSnapshot): {
  projects: Project[];
  songs: Song[];
  sessions: Session[];
  takes: Take[];
  picks: Pick[];
  retakes: Retake[];
} {
  return {
    projects: snapshot.projects ?? [],
    songs: snapshot.songs ?? [],
    sessions: (snapshot.sessions ?? []).map((session) => ({
      ...session,
      lockState: session.lockState === '已封版' ? '已封版' : '未封版',
      lockedAt: session.lockedAt ?? '',
      lockedBy: session.lockedBy ?? '',
      reopenReason: session.reopenReason ?? '',
      lockHistory: Array.isArray(session.lockHistory) ? session.lockHistory : []
    })),
    takes: snapshot.takes ?? [],
    picks: (snapshot.picks ?? []).map((pick) => ({
      ...pick,
      reviewState: pick.reviewState === '待复核' ? '待复核' : '有效',
      reviewNote: pick.reviewNote ?? ''
    })),
    retakes: (snapshot.retakes ?? []).map((retake) => ({
      ...retake,
      takeId: typeof retake.takeId === 'string' ? retake.takeId : ''
    }))
  };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  const data = normalizeImported(snapshot);
  await db.transaction('rw', [db.projects, db.songs, db.sessions, db.takes, db.picks, db.retakes], async () => {
    await Promise.all([
      db.projects.clear(),
      db.songs.clear(),
      db.sessions.clear(),
      db.takes.clear(),
      db.picks.clear(),
      db.retakes.clear()
    ]);
    await db.projects.bulkPut(data.projects.map(stamp));
    await db.songs.bulkPut(data.songs.map(stamp));
    await db.sessions.bulkPut(data.sessions.map(stamp));
    await db.takes.bulkPut(data.takes.map(stamp));
    await db.picks.bulkPut(data.picks.map(stamp));
    await db.retakes.bulkPut(data.retakes.map(stamp));
  });
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', [db.projects, db.songs, db.sessions, db.takes, db.picks, db.retakes], async () => {
    await Promise.all([
      db.projects.clear(),
      db.songs.clear(),
      db.sessions.clear(),
      db.takes.clear(),
      db.picks.clear(),
      db.retakes.clear()
    ]);
  });
  await seedDatabase(db);
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [projects, songs, sessions, takes, picks, retakes] = await Promise.all([
    db.projects.count(),
    db.songs.count(),
    db.sessions.count(),
    db.takes.count(),
    db.picks.count(),
    db.retakes.count()
  ]);
  return { projects, songs, sessions, takes, picks, retakes };
}
