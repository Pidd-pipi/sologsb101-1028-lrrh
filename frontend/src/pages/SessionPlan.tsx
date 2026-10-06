/** /sessions 场次安排与参与乐手：按日期/棚号排期，封版锁定与冲突提示 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  message
} from 'antd';
import { LockOutlined, UnlockOutlined } from '@ant-design/icons';
import FilterBar from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useIdbTable } from '@/hooks/useIdbTable';
import { useSessionStore } from '@/stores/sessionStore';
import { useProjectStore } from '@/stores/projectStore';
import { useRoleStore } from '@/stores/roleStore';
import { db, type ProjectRow, type SessionRow, type SongRow, type TakeRow } from '@/utils/db';
import {
  SESSION_LOCK_STATES,
  SESSION_PERIODS,
  SESSION_STATES,
  STUDIO_ROOMS,
  createEmptySession,
  isSessionLocked,
  type Session
} from '@/types/session';
import { isProducerRole } from '@/types/role';
import type { FilterModel, FilterSelectConfig } from '@/types/filter';
import { isSessionLockedError, isStaleRowError } from '@/utils/guards';
import { formatDuration, totalDuration } from '@/utils/timecode';

const asArray = (value: string | string[] | boolean | undefined): string[] => (Array.isArray(value) ? value : []);

/** 表单字段（不含封版留痕：那部分由封版 / 重开动作写入） */
type SessionFormValues = Pick<
  Session,
  'songId' | 'date' | 'period' | 'engineer' | 'roomNo' | 'musicians' | 'state'
>;

function formatAt(at: string): string {
  return at ? at.slice(0, 19).replace('T', ' ') : '—';
}

export default function SessionPlan() {
  const [searchParams, setSearchParams] = useSearchParams();
  const sessions = useIdbTable<SessionRow>(db.sessions);
  const songs = useIdbTable<SongRow>(db.songs);
  const projects = useIdbTable<ProjectRow>(db.projects);
  const takes = useIdbTable<TakeRow>(db.takes);

  const filters = useSessionStore((state) => state.filters);
  const setFilters = useSessionStore((state) => state.setFilters);
  const resetFilters = useSessionStore((state) => state.resetFilters);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const selectSession = useSessionStore((state) => state.selectSession);
  const createSession = useSessionStore((state) => state.createSession);
  const editSession = useSessionStore((state) => state.editSession);
  const deleteSession = useSessionStore((state) => state.deleteSession);
  const lockSession = useSessionStore((state) => state.lockSession);
  const reopenSession = useSessionStore((state) => state.reopenSession);
  const currentProjectId = useProjectStore((state) => state.currentProjectId);
  const role = useRoleStore((state) => state.role);
  const producer = isProducerRole(role);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SessionRow | null>(null);
  /** 打开弹窗时行的版本（updatedAt），落后保存时据此判定并发冲突 */
  const [baselineAt, setBaselineAt] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  /** 本次提交是否撞上封版 / 并发落后（保留输入时给出「载入最新版本」） */
  const [submitBlocked, setSubmitBlocked] = useState(false);
  const [reopenTarget, setReopenTarget] = useState<SessionRow | null>(null);
  const [reopenReason, setReopenReason] = useState('');
  const [reopenError, setReopenError] = useState<string | null>(null);
  const [form] = Form.useForm<SessionFormValues>();

  useEffect(() => {
    setFilters({
      keyword: searchParams.get('keyword') ?? '',
      rooms: searchParams.get('rooms') ? (searchParams.get('rooms') as string).split(',') : [],
      periods: searchParams.get('periods') ? (searchParams.get('periods') as string).split(',') : [],
      states: searchParams.get('states') ? (searchParams.get('states') as string).split(',') : [],
      lockStates: searchParams.get('lockStates') ? (searchParams.get('lockStates') as string).split(',') : []
    });
    // 仅首次挂载还原 URL 筛选
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selects: FilterSelectConfig[] = useMemo(
    () => [
      { key: 'rooms', label: '棚号', options: STUDIO_ROOMS.map((item) => ({ label: item, value: item })) },
      { key: 'periods', label: '时段', options: SESSION_PERIODS.map((item) => ({ label: item, value: item })) },
      { key: 'states', label: '状态', options: SESSION_STATES.map((item) => ({ label: item, value: item })) },
      {
        key: 'lockStates',
        label: '封版',
        options: SESSION_LOCK_STATES.map((item) => ({ label: item, value: item }))
      }
    ],
    []
  );

  function applyFilters(next: FilterModel): void {
    setFilters(next);
    const params: Record<string, string> = {};
    if (String(next.keyword ?? '').length > 0) params.keyword = String(next.keyword);
    asArray(next.rooms).length > 0 && (params.rooms = asArray(next.rooms).join(','));
    asArray(next.periods).length > 0 && (params.periods = asArray(next.periods).join(','));
    asArray(next.states).length > 0 && (params.states = asArray(next.states).join(','));
    asArray(next.lockStates).length > 0 && (params.lockStates = asArray(next.lockStates).join(','));
    setSearchParams(params, { replace: true });
  }

  const songOf = (songId: string): SongRow | null => songs.find((item) => item.id === songId) ?? null;
  const projectNameOf = (songId: string): string => {
    const song = songOf(songId);
    const project = song ? projects.find((item) => item.id === song.projectId) : undefined;
    return project ? project.name : '项目已删除';
  };

  const filtered = useMemo(() => {
    const keyword = String(filters.keyword ?? '').trim().toLowerCase();
    const rooms = asArray(filters.rooms);
    const periods = asArray(filters.periods);
    const states = asArray(filters.states);
    const lockStates = asArray(filters.lockStates);
    return sessions.filter((session) => {
      const song = songOf(session.songId);
      const label = `${song ? song.title : ''} ${projectNameOf(session.songId)} ${session.engineer} ${session.musicians} ${session.roomNo}`.toLowerCase();
      if (keyword && !label.includes(keyword)) return false;
      if (rooms.length > 0 && !rooms.includes(session.roomNo)) return false;
      if (periods.length > 0 && !periods.includes(session.period)) return false;
      if (states.length > 0 && !states.includes(session.state)) return false;
      if (lockStates.length > 0 && !lockStates.includes(session.lockState)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, songs, projects, filters]);

  const scopedSessions = currentProjectId
    ? filtered.filter((session) => songOf(session.songId)?.projectId === currentProjectId)
    : filtered;

  /** 棚号时段占用矩阵提示：同一棚号同一天同一时段出现多次即为冲突 */
  const conflicts = useMemo(() => {
    const seen = new Map<string, number>();
    sessions.forEach((session) => {
      if (session.state === '已取消') return;
      const key = `${session.roomNo}|${session.date}|${session.period}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    });
    return Array.from(seen.entries())
      .filter(([, count]) => count > 1)
      .map(([key]) => key.replace(/\|/g, ' · '));
  }, [sessions]);

  const totals = useMemo(() => {
    const relevantTakes = takes.filter((take) =>
      scopedSessions.map((session) => session.id).includes(take.sessionId)
    );
    return {
      sessionCount: scopedSessions.length,
      scheduled: scopedSessions.filter((item) => item.state === '已排期').length,
      done: scopedSessions.filter((item) => item.state === '已完成').length,
      locked: scopedSessions.filter((item) => isSessionLocked(item)).length,
      musicianSlots: scopedSessions.reduce(
        (sum, item) => sum + item.musicians.split(/[、,，]/).filter((name) => name.trim().length > 0).length,
        0
      ),
      durationText: formatDuration(totalDuration(relevantTakes))
    };
  }, [scopedSessions, takes]);

  /** 用当前库里的最新行刷新弹窗（并发落后时「载入最新版本」） */
  async function reloadEditing(id: string): Promise<void> {
    const latest = await db.sessions.get(id);
    if (!latest) {
      message.error('该场次已被其它标签页删除');
      setDialogOpen(false);
      setEditing(null);
      return;
    }
    setEditing(latest);
    setBaselineAt(latest.updatedAt);
    form.setFieldsValue({
      songId: latest.songId,
      date: latest.date,
      period: latest.period,
      engineer: latest.engineer,
      roomNo: latest.roomNo,
      musicians: latest.musicians,
      state: latest.state
    });
  }

  async function submit(): Promise<void> {
    const values = await form.validateFields();
    setError(null);
    setSubmitBlocked(false);
    try {
      if (editing) {
        await editSession(editing.id, values, baselineAt);
        message.success('场次已更新');
      } else {
        await createSession({ ...createEmptySession(), ...values });
        message.success('场次已排期');
      }
      setDialogOpen(false);
      setEditing(null);
      form.resetFields();
    } catch (submitError) {
      const text = submitError instanceof Error ? submitError.message : '保存失败';
      setError(text);
      if (isSessionLockedError(submitError) || isStaleRowError(submitError)) {
        // 封版 / 并发落后：保留用户输入，弹窗不关闭，由用户选择载入最新版本或放弃
        setSubmitBlocked(true);
        return;
      }
      message.error(text);
    }
  }

  function openCreate(): void {
    setEditing(null);
    setBaselineAt(undefined);
    setError(null);
    setSubmitBlocked(false);
    form.setFieldsValue({
      ...createEmptySession(),
      songId: songs.find((song) => song.projectId === currentProjectId)?.id ?? songs[0]?.id ?? ''
    });
    setDialogOpen(true);
  }

  function openEdit(row: SessionRow): void {
    setEditing(row);
    setBaselineAt(row.updatedAt);
    setError(null);
    setSubmitBlocked(false);
    form.setFieldsValue({
      songId: row.songId,
      date: row.date,
      period: row.period,
      engineer: row.engineer,
      roomNo: row.roomNo,
      musicians: row.musicians,
      state: row.state
    });
    setDialogOpen(true);
  }

  async function handleLock(row: SessionRow): Promise<void> {
    try {
      await lockSession(row.id, role);
      message.success(`场次（${row.date} ${row.period}）已封版，录音师现在只可查看`);
    } catch (lockError) {
      message.error(lockError instanceof Error ? lockError.message : '封版失败');
    }
  }

  async function submitReopen(): Promise<void> {
    if (!reopenTarget) return;
    setReopenError(null);
    if (!reopenReason.trim()) {
      setReopenError('重开场次必须填写原因');
      return;
    }
    try {
      await reopenSession(reopenTarget.id, role, reopenReason);
      message.success('场次已重开，可继续修改；本次原因已记入封版留痕');
      setReopenTarget(null);
      setReopenReason('');
    } catch (reopenErr) {
      setReopenError(reopenErr instanceof Error ? reopenErr.message : '重开失败');
    }
  }

  const dialogReadOnly = editing !== null && isSessionLocked(editing);

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h2 className="page__title">场次安排与参与乐手</h2>
          <p className="page__subtitle">
            同一棚号同一天同一时段只允许一场；制作人封版后录音师只可查看，重开需制作人填写原因。
          </p>
        </div>
        <Button type="primary" onClick={openCreate} disabled={songs.length === 0}>
          新增场次
        </Button>
      </div>

      <div className="badge-row">
        <StatBadge label="场次数" value={totals.sessionCount} suffix="场" tone="primary" icon="files" />
        <StatBadge label="已排期" value={totals.scheduled} suffix="场" tone="warning" icon="grid" />
        <StatBadge label="已完成" value={totals.done} suffix="场" tone="success" icon="histogram" />
        <StatBadge label="已封版" value={totals.locked} suffix="场" tone="danger" icon="warning" />
        <StatBadge label="乐手席位" value={totals.musicianSlots} suffix="人次" tone="info" icon="trend" />
        <StatBadge label="已录时长" value={totals.durationText} tone="default" icon="pie" />
      </div>

      {conflicts.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`检测到 ${conflicts.length} 处棚号时段占用冲突`}
          description={conflicts.join('；')}
        />
      ) : null}

      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError(null)} /> : null}

      <FilterBar
        modelValue={filters}
        selects={selects}
        keywordPlaceholder="搜索曲目 / 项目 / 录音师 / 乐手…"
        onChange={applyFilters}
        onReset={() => {
          resetFilters();
          setSearchParams({}, { replace: true });
        }}
      />

      {scopedSessions.length === 0 ? (
        <EmptyPanel
          title="暂无场次安排"
          description="为曲目安排录制场次，填写棚号、时段、录音师与参与乐手。"
          createText="新增场次"
          showCreate={songs.length > 0}
          onCreate={openCreate}
        />
      ) : (
        <Card title={`场次清单（${scopedSessions.length}）`}>
          <Table<SessionRow>
            rowKey="id"
            dataSource={scopedSessions}
            pagination={false}
            rowClassName={(row) => (row.id === currentSessionId ? 'take-row-selected' : '')}
            onRow={(row) => ({ onClick: () => selectSession(row.id) })}
            columns={[
              {
                title: '曲目 / 项目',
                minWidth: 200,
                render: (_, row) => (
                  <div>
                    <div>{songOf(row.songId)?.title ?? '曲目已删除'}</div>
                    <div className="muted">{projectNameOf(row.songId)}</div>
                  </div>
                )
              },
              { title: '日期', dataIndex: 'date', width: 120 },
              { title: '时段', dataIndex: 'period', width: 90 },
              { title: '棚号', dataIndex: 'roomNo', width: 100 },
              { title: '录音师', dataIndex: 'engineer', width: 100 },
              { title: '参与乐手', dataIndex: 'musicians', minWidth: 200 },
              {
                title: '状态',
                dataIndex: 'state',
                width: 100,
                render: (value: string) => (
                  <Tag color={value === '已完成' ? 'green' : value === '已取消' ? 'default' : 'blue'}>{value}</Tag>
                )
              },
              {
                title: '封版',
                width: 150,
                render: (_, row) =>
                  isSessionLocked(row) ? (
                    <Tooltip
                      title={
                        <div>
                          <div>封版人：{row.lockedBy || '—'}</div>
                          <div>封版时间：{formatAt(row.lockedAt)}</div>
                          <div>最近重开原因：{row.reopenReason || '—'}</div>
                          <div>留痕 {row.lockHistory.length} 条</div>
                        </div>
                      }
                    >
                      <Tag color="red" icon={<LockOutlined />}>
                        已封版
                      </Tag>
                    </Tooltip>
                  ) : (
                    <Tag color="green" icon={<UnlockOutlined />}>
                      未封版
                    </Tag>
                  )
              },
              {
                title: 'Take 条数',
                width: 90,
                render: (_, row) => takes.filter((take) => take.sessionId === row.id).length
              },
              {
                title: '操作',
                width: 260,
                render: (_, row) => {
                  const locked = isSessionLocked(row);
                  return (
                    <Space onClick={(event) => event.stopPropagation()} size={4} wrap>
                      {locked ? (
                        <Button type="link" size="small" onClick={() => openEdit(row)}>
                          查看
                        </Button>
                      ) : (
                        <Button type="link" size="small" onClick={() => openEdit(row)}>
                          编辑
                        </Button>
                      )}
                      {locked ? (
                        <Tooltip title={producer ? '重开需填写原因' : '只有制作人可以重开已封版场次'}>
                          <Button
                            type="link"
                            size="small"
                            disabled={!producer}
                            onClick={() => {
                              setReopenTarget(row);
                              setReopenReason(row.reopenReason);
                              setReopenError(null);
                            }}
                          >
                            重开
                          </Button>
                        </Tooltip>
                      ) : (
                        <Popconfirm
                          title="封版该场次？"
                          description="封版后录音师只可查看 Take / 优选，改动需重开（写原因）"
                          okText="封版"
                          cancelText="取消"
                          onConfirm={() => void handleLock(row)}
                        >
                          <Tooltip title={producer ? '' : '只有制作人可以封版'}>
                            <Button type="link" size="small" disabled={!producer}>
                              封版
                            </Button>
                          </Tooltip>
                        </Popconfirm>
                      )}
                      <Popconfirm
                        title="删除该场次？"
                        description={locked ? '已封版场次不能删除，请先由制作人重开' : '会级联删除其 Take 与对应优选'}
                        okText="删除"
                        cancelText="取消"
                        onConfirm={async () => {
                          try {
                            await deleteSession(row.id);
                            message.success('场次已删除');
                          } catch (deleteError) {
                            message.error(deleteError instanceof Error ? deleteError.message : '删除失败');
                          }
                        }}
                      >
                        <Button type="link" size="small" danger disabled={locked}>
                          删除
                        </Button>
                      </Popconfirm>
                    </Space>
                  );
                }
              }
            ]}
          />
        </Card>
      )}

      <Modal
        open={dialogOpen}
        title={
          dialogReadOnly
            ? `查看已封版场次（${editing?.date ?? ''} ${editing?.period ?? ''}）`
            : editing
              ? '编辑场次'
              : '新增场次'
        }
        onCancel={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        onOk={submit}
        okText={dialogReadOnly ? '知道了' : '保存'}
        cancelText={dialogReadOnly ? '关闭' : '取消'}
        footer={
          dialogReadOnly
            ? [
                <Button
                  key="close"
                  type="primary"
                  onClick={() => {
                    setDialogOpen(false);
                    setEditing(null);
                  }}
                >
                  关闭
                </Button>
              ]
            : undefined
        }
        destroyOnClose
      >
        {dialogReadOnly ? (
          <Alert
            type="error"
            showIcon
            icon={<LockOutlined />}
            style={{ marginBottom: 12 }}
            message="场次已封版，当前只可查看"
            description={`制作人 ${editing?.lockedBy || '—'} 于 ${formatAt(editing?.lockedAt ?? '')} 封版；录音师改 Take 会被拦截。如需改动，请由制作人重开并填写原因。`}
          />
        ) : null}
        {!dialogReadOnly && error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
        <Form form={form} layout="vertical" disabled={dialogReadOnly}>
          <Form.Item name="songId" label="曲目" rules={[{ required: true, message: '请选择曲目' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={songs.map((song) => ({
                label: `${song.title}（${projects.find((item) => item.id === song.projectId)?.name ?? '未知项目'}）`,
                value: song.id
              }))}
            />
          </Form.Item>
          <Space size={12}>
            <Form.Item name="date" label="日期" rules={[{ required: true, message: '请选择日期' }]}>
              <Input type="date" style={{ width: 180 }} />
            </Form.Item>
            <Form.Item name="period" label="时段" rules={[{ required: true }]}>
              <Select style={{ width: 140 }} options={SESSION_PERIODS.map((item) => ({ label: item, value: item }))} />
            </Form.Item>
            <Form.Item name="roomNo" label="棚号" rules={[{ required: true }]}>
              <Select style={{ width: 160 }} options={STUDIO_ROOMS.map((item) => ({ label: item, value: item }))} />
            </Form.Item>
          </Space>
          <Form.Item name="engineer" label="录音师" rules={[{ required: true, message: '请填写录音师' }]}>
            <Input placeholder="如：赵鸣" />
          </Form.Item>
          <Form.Item name="musicians" label="参与乐手（顿号分隔）">
            <Input placeholder="如：鼓：许峰、贝斯：黎川" />
          </Form.Item>
          <Form.Item name="state" label="场次状态" rules={[{ required: true }]}>
            <Select options={SESSION_STATES.map((item) => ({ label: item, value: item }))} />
          </Form.Item>
        </Form>

        {dialogReadOnly && editing ? (
          <Descriptions column={1} size="small" bordered style={{ marginTop: 4 }}>
            <Descriptions.Item label="封版人">{editing.lockedBy || '—'}</Descriptions.Item>
            <Descriptions.Item label="封版时间">{formatAt(editing.lockedAt)}</Descriptions.Item>
            <Descriptions.Item label="最近重开原因">{editing.reopenReason || '—'}</Descriptions.Item>
            <Descriptions.Item label="封版 / 重开留痕">
              {editing.lockHistory.length === 0
                ? '—'
                : editing.lockHistory
                    .map((entry) => `${formatAt(entry.at)} ${entry.actor} ${entry.action}${entry.reason ? `：${entry.reason}` : ''}`)
                    .join('；')}
            </Descriptions.Item>
          </Descriptions>
        ) : null}

        {!dialogReadOnly && submitBlocked && editing ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 12 }}
            message="输入已保留，旧内容未覆盖新版本"
            description="场次已封版或已被另一标签页改动，本次基于旧版本的保存未写入。可载入最新版本对照后重新编辑，或关闭放弃。"
            action={
              <Button size="small" onClick={() => void reloadEditing(editing.id)}>
                载入最新版本
              </Button>
            }
          />
        ) : null}
      </Modal>

      <Modal
        open={reopenTarget !== null}
        title={`重开场次（${reopenTarget?.date ?? ''} ${reopenTarget?.period ?? ''} · ${reopenTarget?.roomNo ?? ''}）`}
        onCancel={() => {
          setReopenTarget(null);
          setReopenReason('');
          setReopenError(null);
        }}
        onOk={() => void submitReopen()}
        okText="确认重开"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        destroyOnClose
      >
        {reopenError ? <Alert type="error" showIcon message={reopenError} style={{ marginBottom: 12 }} /> : null}
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="重开后录音师可以继续修改 Take；原因会写入封版留痕，再次封版时保留。"
        />
        <Input.TextArea
          rows={3}
          autoFocus
          value={reopenReason}
          onChange={(event) => setReopenReason(event.target.value)}
          placeholder="请填写重开原因（必填），如：T03 噪声问题需补录标记"
        />
      </Modal>
    </div>
  );
}
