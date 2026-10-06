/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbstudiotake-db，数据结构版本号 version(2)，含 v1→v2 upgrade() 迁移
 * - 项目 / 曲目 / 场次 / Take / 优选 / 补录 六张表分表存储
 * - 场次封版后 Take / 优选 / 补录只读；Take 关键字段改动级联失效优选、退回补录
 * - 首次打开自动播种互相引用的演示数据，保证每个页面打开都有内容
 */
import Dexie, { type Table } from 'dexie';
import type { Project } from '../types/project';
import type { Song } from '../types/song';
import type { Session, SessionLockLog } from '../types/session';
import type { Take } from '../types/take';
import type { Pick } from '../types/pick';
import type { Retake } from '../types/retake';
import { nowIso } from './uuid';
import { seedDatabase } from './seed';
import { ROW_REVISION } from './revision';
import { EditConflictError, assertNotStale, invalidationNote, isTakeCoreChanged, lockedReason } from './lockdown';

/** 数据库名 */
export const DB_NAME = 'gbstudiotake-db';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2;

/** 行结构修订号（定义在叶子模块 ./revision，避免与 ./seed 形成循环依赖） */
export { ROW_REVISION };

/** 写入场次 / Take 等行时的乐观并发依据：打开编辑弹窗时该行的 updatedAt */
export interface WriteOptions {
  expectedUpdatedAt?: number;
  /** Take 写操作还要校验所属场次行是否被另一方改动 */
  expectedSessionUpdatedAt?: number;
}

/** Take 保存后的级联结果，用于页面提示制作人复核 */
export interface TakeSaveResult {
  /** 失效待复核的优选数 */
  invalidatedPicks: number;
  /** 由已排期退回待安排的补录数 */
  resetRetakes: number;
}

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

export class GbStudioTakeDatabase extends Dexie {
  projects!: Table<ProjectRow, string>;
  songs!: Table<SongRow, string>;
  sessions!: Table<SessionRow, string>;
  takes!: Table<TakeRow, string>;
  picks!: Table<PickRow, string>;
  retakes!: Table<RetakeRow, string>;

  constructor() {
    super(DB_NAME);

    // v1：六张表初版结构
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
        // 结构迁移：为历史行补齐行修订号与时间戳；新建库时各表为空，迁移天然幂等
        const tableNames = ['projects', 'songs', 'sessions', 'takes', 'picks', 'retakes'];
        for (const name of tableNames) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION;
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now();
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt;
            });
        }
      });

    // v2：场次封版（finalized / lockLogs）、优选复核状态（reviewState / reviewNote）
    // 不新增索引：封版状态通过 takes.sessionId 关联，现有索引已覆盖
    this.version(2)
      .stores({
        projects: 'id, name, client, state, startDate, updatedAt',
        songs: 'id, projectId, title, arrangement, state, updatedAt',
        sessions: 'id, songId, date, period, roomNo, engineer, state, updatedAt',
        takes: 'id, sessionId, takeNo, grade, startTc, updatedAt',
        picks: 'id, takeId, usage, order, updatedAt',
        retakes: 'id, songId, planDate, state, updatedAt'
      })
      .upgrade(async (tx) => {
        await tx
          .table('sessions')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.finalized !== 'boolean') row.finalized = false;
            if (!Array.isArray(row.lockLogs)) row.lockLogs = [];
            row.revision = ROW_REVISION;
          });
        await tx
          .table('picks')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (row.reviewState !== '生效中' && row.reviewState !== '待复核') row.reviewState = '生效中';
            if (typeof row.reviewNote !== 'string') row.reviewNote = '';
            row.revision = ROW_REVISION;
          });
        // 其余表只同步行结构修订号
        for (const name of ['projects', 'songs', 'takes', 'retakes']) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION;
            });
        }
      });
  }
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

/* ------------------------------ 场次 ------------------------------ */

export async function listSessions(): Promise<SessionRow[]> {
  const rows = await db.sessions.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function putSession(row: SessionRow): Promise<void> {
  await db.sessions.put(row);
}

/**
 * 更新场次排期字段（乐观并发）。
 * - 场次已封版 → 拒绝（封版后录音师只读；改排期必须先由制作人重开）
 * - 打开弹窗后该行被另一标签页改过 → 拒绝并提示「场次已改动」
 */
export async function updateSession(id: string, patch: Partial<Session>, options: WriteOptions = {}): Promise<void> {
  await db.transaction('rw', [db.sessions], async () => {
    const current = await db.sessions.get(id);
    if (!current) {
      throw new EditConflictError('stale', '场次已被另一方删除');
    }
    const locked = lockedReason(current);
    if (locked) throw new EditConflictError('locked', `${locked}，请联系制作人重开后再修改`);
    assertNotStale(current.updatedAt, options.expectedUpdatedAt);
    await db.sessions.update(id, { ...patch, updatedAt: Date.now() } as never);
  });
}

/**
 * 制作人封版场次：封版后场次及其 Take / 优选 / 补录对录音师只读。
 * 带乐观并发，避免覆盖另一标签页的改动。
 */
export async function finalizeSession(id: string, role: string, options: WriteOptions = {}): Promise<void> {
  await db.transaction('rw', [db.sessions], async () => {
    const current = await db.sessions.get(id);
    if (!current) throw new EditConflictError('stale', '场次已被另一方删除');
    assertNotStale(current.updatedAt, options.expectedUpdatedAt);
    if (current.finalized) throw new EditConflictError('locked', '场次已封版，无需重复封版');
    const log: SessionLockLog = { action: '封版', role, reason: '', at: Date.now() };
    await db.sessions.update(id, {
      finalized: true,
      lockLogs: [...current.lockLogs, log],
      updatedAt: Date.now()
    } as never);
  });
}

/**
 * 制作人重开场次：必须填写重开原因，原因写入封版审计日志。
 */
export async function reopenSession(
  id: string,
  reason: string,
  role: string,
  options: WriteOptions = {}
): Promise<void> {
  const trimmed = reason.trim();
  if (!trimmed) throw new EditConflictError('invalid', '重开场次必须填写原因');
  await db.transaction('rw', [db.sessions], async () => {
    const current = await db.sessions.get(id);
    if (!current) throw new EditConflictError('stale', '场次已被另一方删除');
    assertNotStale(current.updatedAt, options.expectedUpdatedAt);
    if (!current.finalized) throw new EditConflictError('invalid', '场次未封版，无需重开');
    const log: SessionLockLog = { action: '重开', role, reason: trimmed, at: Date.now() };
    await db.sessions.update(id, {
      finalized: false,
      lockLogs: [...current.lockLogs, log],
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

/** 删除场次：已封版场次禁止删除；未封版场次级联删除其 Take 与对应优选 */
export async function removeSession(id: string): Promise<void> {
  await db.transaction('rw', [db.sessions, db.takes, db.picks], async () => {
    const session = await db.sessions.get(id);
    if (session) {
      const locked = lockedReason(session);
      if (locked) throw new EditConflictError('locked', `${locked}，请先由制作人重开后再删除`);
    }
    const takes = await db.takes.where('sessionId').equals(id).toArray();
    const takeIds = takes.map((item) => item.id);
    if (takeIds.length > 0) {
      await db.picks.where('takeId').anyOf(takeIds).delete();
    }
    await db.takes.where('sessionId').equals(id).delete();
    await db.sessions.delete(id);
  });
}

/* ------------------------------ Take ------------------------------ */

export async function listTakes(): Promise<TakeRow[]> {
  return db.takes.toArray();
}

export async function putTake(row: TakeRow): Promise<void> {
  await db.transaction('rw', [db.sessions, db.takes], async () => {
    const session = await db.sessions.get(row.sessionId);
    if (!session) throw new EditConflictError('invalid', '所属场次不存在，无法标记 Take');
    const locked = lockedReason(session);
    if (locked) throw new EditConflictError('locked', `${locked}，不能在该场次新增 Take`);
    await db.takes.put(row);
  });
}

/**
 * 更新一条 Take（乐观并发）。
 * - 所属场次已封版 → 拒绝（封版后录音师只读）
 * - Take 行或场次行在打开弹窗后被另一方改动 → 拒绝并提示「场次已改动」
 * - 时间码 / 评级 / 问题标签一旦改动：该 Take 的优选立刻失效待复核，
 *   所属曲目已排期的补录计划退回待安排（同一事务内完成）
 */
export async function updateTake(
  id: string,
  patch: Partial<Take>,
  options: WriteOptions = {}
): Promise<TakeSaveResult> {
  const result: TakeSaveResult = { invalidatedPicks: 0, resetRetakes: 0 };
  await db.transaction('rw', [db.sessions, db.takes, db.picks, db.retakes], async () => {
    const prev = await db.takes.get(id);
    if (!prev) throw new EditConflictError('stale', 'Take 已被另一方删除');
    const session = await db.sessions.get(prev.sessionId);
    const locked = lockedReason(session);
    if (locked) throw new EditConflictError('locked', `${locked}，Take 只读，不能修改`);
    assertNotStale(prev.updatedAt, options.expectedUpdatedAt);
    // 弹窗期间场次被另一方编辑（含封版）也要提示，避免旧版本覆盖
    if (session) assertNotStale(session.updatedAt, options.expectedSessionUpdatedAt);

    const now = Date.now();
    await db.takes.update(id, { ...patch, updatedAt: now } as never);

    if (isTakeCoreChanged(prev, patch) && session) {
      const note = invalidationNote(prev, patch);
      const picks = await db.picks.where('takeId').equals(id).toArray();
      for (const pick of picks) {
        await db.picks.update(pick.id, {
          reviewState: '待复核',
          reviewNote: note,
          updatedAt: now
        } as never);
      }
      result.invalidatedPicks = picks.length;
      const retakes = await db.retakes
        .where('songId')
        .equals(session.songId)
        .filter((item) => item.state === '已排期')
        .toArray();
      for (const retake of retakes) {
        await db.retakes.update(retake.id, { state: '待安排', updatedAt: now } as never);
      }
      result.resetRetakes = retakes.length;
    }
  });
  return result;
}

/** 批量改评级：任一选中条次属于已封版场次则整批拒绝（同事务全有或全无）；评级实际改动同样触发级联 */
export async function bulkUpdateGrade(ids: string[], grade: Take['grade']): Promise<TakeSaveResult> {
  const result: TakeSaveResult = { invalidatedPicks: 0, resetRetakes: 0 };
  await db.transaction('rw', [db.sessions, db.takes, db.picks, db.retakes], async () => {
    const now = Date.now();
    const affectedSongs = new Set<string>();
    const invalidatedTakeNos = new Map<string, Take>();
    for (const id of ids) {
      const take = await db.takes.get(id);
      if (!take) continue;
      const session = await db.sessions.get(take.sessionId);
      const locked = lockedReason(session);
      if (locked) {
        throw new EditConflictError(
          'locked',
          `${locked}：条次 ${take.takeNo} 所属场次不可改评级，请先取消选择或由制作人重开`
        );
      }
      if (take.grade !== grade) {
        if (session) affectedSongs.add(session.songId);
        invalidatedTakeNos.set(id, take);
        await db.takes.update(id, { grade, updatedAt: now } as never);
      }
    }
    if (invalidatedTakeNos.size > 0) {
      const picks = await db.picks.where('takeId').anyOf([...invalidatedTakeNos.keys()]).toArray();
      const noteByTake = new Map<string, string>();
      for (const [takeId, take] of invalidatedTakeNos) {
        noteByTake.set(takeId, invalidationNote(take, { grade }));
      }
      for (const pick of picks) {
        await db.picks.update(pick.id, {
          reviewState: '待复核',
          reviewNote: noteByTake.get(pick.takeId) ?? '源 Take 评级已改动，优选失效待复核',
          updatedAt: now
        } as never);
      }
      result.invalidatedPicks = picks.length;
      if (affectedSongs.size > 0) {
        const retakes = await db.retakes
          .where('songId')
          .anyOf([...affectedSongs])
          .filter((item) => item.state === '已排期')
          .toArray();
        for (const retake of retakes) {
          await db.retakes.update(retake.id, { state: '待安排', updatedAt: now } as never);
        }
        result.resetRetakes = retakes.length;
      }
    }
  });
  return result;
}

/** 删除 Take：所属场次已封版则拒绝；原有的优选级联删除保留 */
export async function removeTake(id: string): Promise<void> {
  await db.transaction('rw', [db.sessions, db.takes, db.picks], async () => {
    const take = await db.takes.get(id);
    if (take) {
      const session = await db.sessions.get(take.sessionId);
      const locked = lockedReason(session);
      if (locked) throw new EditConflictError('locked', `${locked}，不能删除该 Take`);
    }
    await db.picks.where('takeId').equals(id).delete();
    await db.takes.delete(id);
  });
}

/* ------------------------------ 优选 ------------------------------ */

/** 校验一个 Take 是否可做优选写操作：所属场次封版后只读 */
async function assertPickTakeWritable(takeId: string): Promise<TakeRow> {
  const take = await db.takes.get(takeId);
  if (!take) throw new EditConflictError('invalid', '被优选的 Take 不存在');
  const session = await db.sessions.get(take.sessionId);
  const locked = lockedReason(session);
  if (locked) throw new EditConflictError('locked', `${locked}，优选记录只读`);
  return take;
}

export async function listPicks(): Promise<PickRow[]> {
  const rows = await db.picks.toArray();
  return rows.sort((a, b) => a.order - b.order);
}

/** 新增优选：目标 Take 所属场次已封版则拒绝 */
export async function putPick(row: PickRow): Promise<void> {
  await db.transaction('rw', [db.sessions, db.takes, db.picks], async () => {
    await assertPickTakeWritable(row.takeId);
    await db.picks.put(row);
  });
}

/** 编辑优选：若改选了 Take，新旧两个场次都必须未封版；封版场次只读 */
export async function updatePick(id: string, patch: Partial<Pick>): Promise<void> {
  await db.transaction('rw', [db.sessions, db.takes, db.picks], async () => {
    const current = await db.picks.get(id);
    if (!current) throw new EditConflictError('stale', '优选记录已被另一方删除');
    await assertPickTakeWritable(current.takeId);
    if (patch.takeId && patch.takeId !== current.takeId) {
      await assertPickTakeWritable(patch.takeId);
    }
    await db.picks.update(id, { ...patch, updatedAt: Date.now() } as never);
  });
}

/**
 * 复核通过：待复核优选重新生效（清空失效原因），并把顺序追加到清单末尾，
 * 避免恢复生效时与现有 order 撞号（拖拽子清单的顺序号即按恢复后的顺序重新计算）。
 * 所属场次仍处于封版时同样只读，需制作人重开后才能确认。
 */
export async function confirmPickReview(id: string): Promise<void> {
  await db.transaction('rw', [db.sessions, db.takes, db.picks], async () => {
    const current = await db.picks.get(id);
    if (!current) throw new EditConflictError('stale', '优选记录已被另一方删除');
    await assertPickTakeWritable(current.takeId);
    const rows = await db.picks.toArray();
    const nextOrder = rows.reduce((max, row) => Math.max(max, row.order), 0) + 1;
    await db.picks.update(id, {
      reviewState: '生效中',
      reviewNote: '',
      order: nextOrder,
      updatedAt: Date.now()
    } as never);
  });
}

/**
 * 拖拽 / 上下移后按新顺序批量写回。
 * orderedActiveIds 只含「生效中」优选（待复核项不参与拖拽），写回时保留
 * 待复核项在原顺序中的相对槽位，合并后统一重编号，避免顺序号撞车。
 * 任一生效条次所属场次已封版则整批拒绝。
 */
export async function reorderPicks(orderedActiveIds: string[]): Promise<void> {
  await db.transaction('rw', [db.sessions, db.takes, db.picks], async () => {
    if (orderedActiveIds.length > 0) {
      const picks = await db.picks.bulkGet(orderedActiveIds);
      for (const pick of picks) {
        if (pick) await assertPickTakeWritable(pick.takeId);
      }
    }
    const all = (await db.picks.toArray()).sort((a, b) => a.order - b.order);
    // 待复核项占住自己原来的顺序槽位；生效项按拖拽后的新顺序填入其余空槽
    const slots: (PickRow | null)[] = new Array(all.length).fill(null);
    all.forEach((row, index) => {
      if (row.reviewState === '待复核') slots[index] = row;
    });
    const activeInNewOrder = orderedActiveIds
      .map((id) => all.find((row) => row.id === id))
      .filter((row): row is PickRow => Boolean(row));
    // 拖拽列表未覆盖到的生效项（防御性）按原顺序补到队尾
    for (const row of all) {
      if (row.reviewState !== '待复核' && !activeInNewOrder.some((item) => item.id === row.id)) {
        activeInNewOrder.push(row);
      }
    }
    let cursor = 0;
    for (let slot = 0; slot < slots.length; slot += 1) {
      if (!slots[slot]) {
        slots[slot] = activeInNewOrder[cursor] ?? null;
        cursor += 1;
      }
    }
    for (let index = 0; index < slots.length; index += 1) {
      const row = slots[index];
      if (row && row.order !== index + 1) {
        await db.picks.update(row.id, { order: index + 1, updatedAt: Date.now() } as never);
      }
    }
  });
}

export async function nextPickOrder(): Promise<number> {
  const rows = await db.picks.toArray();
  return rows.reduce((max, row) => Math.max(max, row.order), 0) + 1;
}

/** 移出优选：所属场次已封版则拒绝 */
export async function removePick(id: string): Promise<void> {
  await db.transaction('rw', [db.sessions, db.takes, db.picks], async () => {
    const current = await db.picks.get(id);
    if (current) await assertPickTakeWritable(current.takeId);
    await db.picks.delete(id);
  });
}

/* ------------------------------ 补录 ------------------------------ */

/**
 * 由问题 Take 生成补录前的封版校验：
 * 封版场次的 Take 只读，不能在封版状态下基于它新增补录计划。
 */
export async function assertTakeSessionWritable(takeId: string): Promise<SessionRow> {
  const take = await db.takes.get(takeId);
  if (!take) throw new EditConflictError('invalid', '该条次不存在');
  const session = await db.sessions.get(take.sessionId);
  if (!session) throw new EditConflictError('invalid', '该条次所属场次已删除');
  const locked = lockedReason(session);
  if (locked) throw new EditConflictError('locked', `${locked}，不能基于该 Take 生成补录`);
  return session;
}

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
  songs: Song[];
  sessions: Session[];
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

/** 兼容旧备份：为场次补齐封版字段 */
function migrateSessionRow(row: Session): Session {
  const data = row as unknown as Record<string, unknown>;
  return {
    ...row,
    finalized: typeof data.finalized === 'boolean' ? (data.finalized as boolean) : false,
    lockLogs: Array.isArray(data.lockLogs) ? (data.lockLogs as Session['lockLogs']) : []
  };
}

/** 兼容旧备份：为优选补齐复核字段 */
function migratePickRow(row: Pick): Pick {
  const data = row as unknown as Record<string, unknown>;
  return {
    ...row,
    reviewState: data.reviewState === '待复核' ? '待复核' : '生效中',
    reviewNote: typeof data.reviewNote === 'string' ? data.reviewNote : ''
  };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', [db.projects, db.songs, db.sessions, db.takes, db.picks, db.retakes], async () => {
    await Promise.all([
      db.projects.clear(),
      db.songs.clear(),
      db.sessions.clear(),
      db.takes.clear(),
      db.picks.clear(),
      db.retakes.clear()
    ]);
    await db.projects.bulkPut(snapshot.projects.map(stamp));
    await db.songs.bulkPut(snapshot.songs.map(stamp));
    await db.sessions.bulkPut(snapshot.sessions.map((row) => stamp(migrateSessionRow(row))));
    await db.takes.bulkPut(snapshot.takes.map(stamp));
    await db.picks.bulkPut(snapshot.picks.map((row) => stamp(migratePickRow(row))));
    await db.retakes.bulkPut(snapshot.retakes.map(stamp));
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
