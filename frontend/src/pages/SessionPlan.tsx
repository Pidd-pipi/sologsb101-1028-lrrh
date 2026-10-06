/** /sessions 场次安排与参与乐手：按日期/棚号排期、冲突拦截与场次封版 */
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
  Timeline,
  message
} from 'antd';
import { LockOutlined, PlusOutlined, UnlockOutlined } from '@ant-design/icons';
import FilterBar from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import RoleSwitch from '@/components/common/RoleSwitch';
import LockStatusTag from '@/components/common/LockStatusTag';
import { useIdbTable } from '@/hooks/useIdbTable';
import { useSessionStore } from '@/stores/sessionStore';
import { useProjectStore } from '@/stores/projectStore';
import { db, type ProjectRow, type SessionRow, type SongRow, type TakeRow } from '@/utils/db';
import {
  SESSION_PERIODS,
  SESSION_STATES,
  STUDIO_ROOMS,
  createEmptySession,
  type Session
} from '@/types/session';
import type { FilterModel, FilterSelectConfig } from '@/types/filter';
import { EditConflictError, formatStamp } from '@/utils/lockdown';
import { formatDuration, totalDuration } from '@/utils/timecode';

const asArray = (value: string | string[] | boolean | undefined): string[] => (Array.isArray(value) ? value : []);

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
  const reopenSessionStore = useSessionStore((state) => state.reopenSession);
  const role = useSessionStore((state) => state.role);
  const currentProjectId = useProjectStore((state) => state.currentProjectId);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SessionRow | null>(null);
  /** 打开编辑弹窗时捕获的行版本，用于乐观并发 */
  const [baseVersion, setBaseVersion] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [reopenTarget, setReopenTarget] = useState<SessionRow | null>(null);
  const [reopenReason, setReopenReason] = useState('');
  const [reopenError, setReopenError] = useState<string | null>(null);
  const [reopenVersion, setReopenVersion] = useState<number | undefined>(undefined);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [form] = Form.useForm<Omit<Session, 'id' | 'finalized' | 'lockLogs'>>();

  useEffect(() => {
    setFilters({
      keyword: searchParams.get('keyword') ?? '',
      rooms: searchParams.get('rooms') ? (searchParams.get('rooms') as string).split(',') : [],
      periods: searchParams.get('periods') ? (searchParams.get('periods') as string).split(',') : [],
      states: searchParams.get('states') ? (searchParams.get('states') as string).split(',') : []
    });
    // 仅首次挂载还原 URL 筛选
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selects: FilterSelectConfig[] = useMemo(
    () => [
      { key: 'rooms', label: '棚号', options: STUDIO_ROOMS.map((item) => ({ label: item, value: item })) },
      { key: 'periods', label: '时段', options: SESSION_PERIODS.map((item) => ({ label: item, value: item })) },
      { key: 'states', label: '状态', options: SESSION_STATES.map((item) => ({ label: item, value: item })) }
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
    return sessions.filter((session) => {
      const song = songOf(session.songId);
      const label = `${song ? song.title : ''} ${projectNameOf(session.songId)} ${session.engineer} ${session.musicians} ${session.roomNo}`.toLowerCase();
      if (keyword && !label.includes(keyword)) return false;
      if (rooms.length > 0 && !rooms.includes(session.roomNo)) return false;
      if (periods.length > 0 && !periods.includes(session.period)) return false;
      if (states.length > 0 && !states.includes(session.state)) return false;
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
      locked: scopedSessions.filter((item) => item.finalized).length,
      scheduled: scopedSessions.filter((item) => item.state === '已排期').length,
      done: scopedSessions.filter((item) => item.state === '已完成').length,
      musicianSlots: scopedSessions.reduce(
        (sum, item) => sum + item.musicians.split(/[、,，]/).filter((name) => name.trim().length > 0).length,
        0
      ),
      durationText: formatDuration(totalDuration(relevantTakes))
    };
  }, [scopedSessions, takes]);

  const detailSession = detailId ? sessions.find((item) => item.id === detailId) ?? null : null;

  async function submit(): Promise<void> {
    const values = await form.validateFields();
    setError(null);
    try {
      if (editing) {
        await editSession(editing.id, values, baseVersion);
        message.success('场次已更新');
      } else {
        await createSession({ ...values, finalized: false, lockLogs: [] });
        message.success('场次已排期');
      }
      setDialogOpen(false);
      setEditing(null);
      setBaseVersion(undefined);
      form.resetFields();
    } catch (submitError) {
      // 冲突时保留弹窗与已输入内容，按封版 / 已改动给出不同提示，不覆盖新版本
      if (submitError instanceof EditConflictError) {
        setError(submitError.message);
        if (submitError.kind === 'stale') {
          setStale(true);
          message.warning('场次已改动，本次保存未写入；可载入最新版本后再改（输入已保留）');
        } else {
          message.error(submitError.message);
        }
        return;
      }
      const text = submitError instanceof Error ? submitError.message : '保存失败';
      setError(text);
      message.error(text);
    }
  }

  function openEdit(row: SessionRow): void {
    if (row.finalized) {
      message.warning('场次已封版，录音师只可查看；需要修改请由制作人重开');
      setDetailId(row.id);
      return;
    }
    setEditing(row);
    setError(null);
    setStale(false);
    setBaseVersion(row.updatedAt);
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

  /** 冲突后载入另一方保存的最新场次，保留弹窗继续在新版本上修改 */
  function reloadLatestSession(): void {
    if (!editing) return;
    const fresh = sessions.find((item) => item.id === editing.id);
    if (!fresh) {
      message.error('该场次已被另一方删除');
      setDialogOpen(false);
      setEditing(null);
      return;
    }
    setEditing(fresh);
    setBaseVersion(fresh.updatedAt);
    setStale(false);
    setError(null);
    form.setFieldsValue({
      songId: fresh.songId,
      date: fresh.date,
      period: fresh.period,
      engineer: fresh.engineer,
      roomNo: fresh.roomNo,
      musicians: fresh.musicians,
      state: fresh.state
    });
    message.info('已载入另一方保存的最新版本，您的输入可在其基础上继续修改');
  }

  function openReopen(row: SessionRow): void {
    setReopenTarget(row);
    setReopenReason('');
    setReopenError(null);
    setReopenVersion(row.updatedAt);
  }

  async function submitReopen(): Promise<void> {
    if (!reopenTarget) return;
    setReopenError(null);
    try {
      await reopenSessionStore(reopenTarget.id, reopenReason, reopenVersion);
      message.success('场次已重开，原因已记入封版日志');
      setReopenTarget(null);
    } catch (error) {
      if (error instanceof EditConflictError) {
        setReopenError(error.message);
        if (error.kind === 'stale') {
          const fresh = reopenTarget ? sessions.find((item) => item.id === reopenTarget.id) ?? null : null;
          if (fresh) {
            setReopenTarget(fresh);
            setReopenVersion(fresh.updatedAt);
          }
          message.warning('场次已改动，已为您刷新到最新版本，请再确认重开');
        }
        return;
      }
      const text = error instanceof Error ? error.message : '重开失败';
      setReopenError(text);
      message.error(text);
    }
  }

  async function handleFinalize(row: SessionRow): Promise<void> {
    try {
      await lockSession(row.id, row.updatedAt);
      message.success(`场次 ${row.date} ${row.period} 已封版`);
    } catch (error) {
      if (error instanceof EditConflictError) {
        if (error.kind === 'stale') message.error('场次已改动，请刷新后重新封版');
        else message.error(error.message);
        return;
      }
      message.error(error instanceof Error ? error.message : '封版失败');
    }
  }

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h2 className="page__title">场次安排、乐手与封版</h2>
          <p className="page__subtitle">
            制作人封版后录音师只可查看，重开需填写原因；封版场次的 Take、优选与补录同步只读。
          </p>
        </div>
        <Space>
          <RoleSwitch />
          <Button
            type="primary"
            icon={<PlusOutlined />}
            disabled={songs.length === 0}
            onClick={() => {
              setEditing(null);
              setBaseVersion(undefined);
              setError(null);
              setStale(false);
              form.setFieldsValue({
                ...createEmptySession(),
                songId: songs.find((song) => song.projectId === currentProjectId)?.id ?? songs[0]?.id ?? ''
              });
              setDialogOpen(true);
            }}
          >
            新增场次
          </Button>
        </Space>
      </div>

      <div className="badge-row">
        <StatBadge label="场次数" value={totals.sessionCount} suffix="场" tone="primary" icon="files" />
        <StatBadge label="已封版" value={totals.locked} suffix="场" tone="danger" icon="warning" />
        <StatBadge label="已排期" value={totals.scheduled} suffix="场" tone="warning" icon="grid" />
        <StatBadge label="已完成" value={totals.done} suffix="场" tone="success" icon="histogram" />
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
          onCreate={() => {
            setEditing(null);
            setBaseVersion(undefined);
            form.setFieldsValue(createEmptySession());
            setDialogOpen(true);
          }}
        />
      ) : (
        <Card
          title={`场次清单（${scopedSessions.length}）`}
          extra={<span className="muted">封版后录音师仅可查看；点「封版日志」查看操作留痕</span>}
        >
          <Table<SessionRow>
            rowKey="id"
            dataSource={scopedSessions}
            pagination={false}
            rowClassName={(row) => (row.finalized ? 'session-row-locked' : row.id === currentSessionId ? 'take-row-selected' : '')}
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
              { title: '日期', dataIndex: 'date', width: 110 },
              { title: '时段', dataIndex: 'period', width: 80 },
              { title: '棚号', dataIndex: 'roomNo', width: 90 },
              { title: '录音师', dataIndex: 'engineer', width: 90 },
              { title: '参与乐手', dataIndex: 'musicians', minWidth: 180 },
              {
                title: '状态',
                dataIndex: 'state',
                width: 90,
                render: (value: string) => (
                  <Tag color={value === '已完成' ? 'green' : value === '已取消' ? 'default' : 'blue'}>{value}</Tag>
                )
              },
              {
                title: '封版',
                width: 100,
                render: (_, row) => <LockStatusTag session={row} />
              },
              {
                title: 'Take 条数',
                width: 90,
                render: (_, row) => takes.filter((take) => take.sessionId === row.id).length
              },
              {
                title: '操作',
                width: 280,
                render: (_, row) => (
                  <Space onClick={(event) => event.stopPropagation()} size={2} wrap>
                    <Button type="link" size="small" onClick={() => openEdit(row)}>
                      {row.finalized ? '查看' : '编辑'}
                    </Button>
                    <Button type="link" size="small" onClick={() => setDetailId(row.id)}>
                      封版日志
                    </Button>
                    {row.finalized ? (
                      <Button
                        type="link"
                        size="small"
                        icon={<UnlockOutlined />}
                        disabled={role !== '制作人'}
                        onClick={() => openReopen(row)}
                      >
                        重开
                      </Button>
                    ) : (
                      <Popconfirm
                        title="封版该场次？"
                        description="封版后录音师对场次、Take、优选与补录只可查看"
                        onConfirm={() => void handleFinalize(row)}
                        onPopupClick={(event) => event.stopPropagation()}
                        disabled={role !== '制作人'}
                      >
                        <Button type="link" size="small" icon={<LockOutlined />} disabled={role !== '制作人'}>
                          封版
                        </Button>
                      </Popconfirm>
                    )}
                    <Popconfirm
                      title="删除该场次？"
                      description={row.finalized ? '场次已封版，需先由制作人重开' : '会级联删除其 Take 与对应优选'}
                      onConfirm={async () => {
                        try {
                          await deleteSession(row.id);
                          message.success('场次已删除');
                        } catch (error) {
                          message.error(error instanceof Error ? error.message : '删除失败');
                        }
                      }}
                      onPopupClick={(event) => event.stopPropagation()}
                      disabled={row.finalized}
                    >
                      <Button type="link" size="small" danger disabled={row.finalized}>
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                )
              }
            ]}
          />
        </Card>
      )}

      <Modal
        open={dialogOpen}
        title={editing ? '编辑场次' : '新增场次'}
        onCancel={() => {
          setDialogOpen(false);
          setEditing(null);
          setBaseVersion(undefined);
        }}
        onOk={submit}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        {error ? (
          <Alert
            type="error"
            showIcon
            message={error}
            style={{ marginBottom: 12 }}
            action={
              stale ? (
                <Button size="small" onClick={reloadLatestSession}>
                  载入最新版本
                </Button>
              ) : undefined
            }
          />
        ) : null}
        {editing ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="保存时若另一标签页已改动本场次，将提示「场次已改动」且不会覆盖新版本，您填写的内容会保留在表单中。"
          />
        ) : null}
        <Form form={form} layout="vertical">
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
      </Modal>

      <Modal
        open={reopenTarget !== null}
        title={`重开场次 · ${reopenTarget ? `${reopenTarget.date} ${reopenTarget.period} ${reopenTarget.roomNo}` : ''}`}
        onCancel={() => setReopenTarget(null)}
        onOk={submitReopen}
        okText="确认重开"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        destroyOnClose
      >
        {reopenError ? <Alert type="error" showIcon message={reopenError} style={{ marginBottom: 12 }} /> : null}
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="重开后录音师可再次修改 Take；重开原因会写入封版日志留痕。"
        />
        <Input.TextArea
          rows={3}
          value={reopenReason}
          onChange={(event) => setReopenReason(event.target.value)}
          placeholder="必填：说明重开原因，如「制作人复核后同意补录副歌段落」"
        />
      </Modal>

      <Modal
        open={detailSession !== null}
        title={detailSession ? `封版日志 · ${detailSession.date} ${detailSession.period} ${detailSession.roomNo}` : ''}
        footer={null}
        onCancel={() => setDetailId(null)}
        width={560}
      >
        {detailSession ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="封版状态">
                <LockStatusTag session={detailSession} />
              </Descriptions.Item>
              <Descriptions.Item label="录音师">{detailSession.engineer}</Descriptions.Item>
              <Descriptions.Item label="Take 条数">
                {takes.filter((take) => take.sessionId === detailSession.id).length} 条
              </Descriptions.Item>
            </Descriptions>
            {detailSession.lockLogs.length === 0 ? (
              <Alert type="info" showIcon message="该场次尚未封版，暂无封版日志。" />
            ) : (
              <Timeline
                items={detailSession.lockLogs.map((log) => ({
                  color: log.action === '封版' ? 'red' : 'green',
                  children: (
                    <div>
                      <div>
                        <Tag color={log.action === '封版' ? 'red' : 'green'}>{log.action}</Tag>
                        <span className="muted">
                          {formatStamp(log.at)} · {log.role}
                        </span>
                      </div>
                      {log.reason ? <div>重开原因：{log.reason}</div> : null}
                    </div>
                  )
                }))}
              />
            )}
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}
