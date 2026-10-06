/** /takes Take 标记台：录入起止时间码、问题标签与评级，支持批量改评级；封版场次只读 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  message
} from 'antd';
import { LockOutlined, PlusOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import FilterBar from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import TakeBadge from '@/components/common/TakeBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import RoleSwitch from '@/components/common/RoleSwitch';
import { useIdbTable } from '@/hooks/useIdbTable';
import { useTakeFilter } from '@/hooks/useTakeFilter';
import { useTakeStore } from '@/stores/takeStore';
import { useSessionStore } from '@/stores/sessionStore';
import { db, type ProjectRow, type SessionRow, type SongRow, type TakeRow, type TakeSaveResult } from '@/utils/db';
import { TAKE_GRADES, TAKE_ISSUES, createEmptyTake, type Take, type TakeGrade } from '@/types/take';
import type { FilterSelectConfig } from '@/types/filter';
import { EditConflictError } from '@/utils/lockdown';
import {
  formatDuration,
  isOverlapping,
  isTimecode,
  takeDuration,
  tcToSeconds,
  totalDuration,
  suggestNextTakeNo,
  sortByStart
} from '@/utils/timecode';

const asArray = (value: string | string[] | boolean | undefined): string[] => (Array.isArray(value) ? value : []);

export default function TakeBoard() {
  const [searchParams, setSearchParams] = useSearchParams();
  const takes = useIdbTable<TakeRow>(db.takes);
  const sessions = useIdbTable<SessionRow>(db.sessions);
  const songs = useIdbTable<SongRow>(db.songs);
  const projects = useIdbTable<ProjectRow>(db.projects);

  const { filters, setFilters, resetFilters, filtered } = useTakeFilter(takes, sessions);
  const selectedIds = useTakeStore((state) => state.selectedIds);
  const toggleSelected = useTakeStore((state) => state.toggleSelected);
  const setSelected = useTakeStore((state) => state.setSelected);
  const createTake = useTakeStore((state) => state.createTake);
  const editTake = useTakeStore((state) => state.editTake);
  const deleteTake = useTakeStore((state) => state.deleteTake);
  const batchGrade = useTakeStore((state) => state.batchGrade);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);

  const [dialogOpen, setDialogOpen] = useState(false);
  /** 只读查看（封版场次的 Take） */
  const [readOnly, setReadOnly] = useState(false);
  const [editing, setEditing] = useState<TakeRow | null>(null);
  /** 乐观并发依据：编辑前 Take 行 / 场次行的 updatedAt */
  const [baseTakeVersion, setBaseTakeVersion] = useState<number | undefined>(undefined);
  const [baseSessionVersion, setBaseSessionVersion] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [form] = Form.useForm<Omit<Take, 'id'>>();
  /** 表单内当前选择的场次是否已封版（用于禁用保存） */
  const pickedSessionId = Form.useWatch('sessionId', form) as string | undefined;

  useEffect(() => {
    setFilters({
      keyword: searchParams.get('keyword') ?? '',
      grades: searchParams.get('grades') ? (searchParams.get('grades') as string).split(',') : [],
      issues: searchParams.get('issues') ? (searchParams.get('issues') as string).split(',') : [],
      sessionIds: searchParams.get('sessionIds') ? (searchParams.get('sessionIds') as string).split(',') : [],
      minTc: searchParams.get('minTc') ?? '',
      maxTc: searchParams.get('maxTc') ?? ''
    });
    // 仅首次挂载还原 URL 筛选
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyFilters(next: typeof filters): void {
    setFilters(next);
    const params: Record<string, string> = {};
    if (String(next.keyword ?? '').length > 0) params.keyword = String(next.keyword);
    asArray(next.grades).length > 0 && (params.grades = asArray(next.grades).join(','));
    asArray(next.issues).length > 0 && (params.issues = asArray(next.issues).join(','));
    asArray(next.sessionIds).length > 0 && (params.sessionIds = asArray(next.sessionIds).join(','));
    if (String(next.minTc ?? '').length > 0) params.minTc = String(next.minTc);
    if (String(next.maxTc ?? '').length > 0) params.maxTc = String(next.maxTc);
    setSearchParams(params, { replace: true });
  }

  const sessionOf = (sessionId: string): SessionRow | null => sessions.find((item) => item.id === sessionId) ?? null;

  const sessionLabel = (sessionId: string): string => {
    const session = sessionOf(sessionId);
    if (!session) return '场次已删除';
    const song = songs.find((item) => item.id === session.songId);
    const project = song ? projects.find((item) => item.id === song.projectId) : undefined;
    return `${song ? song.title : '未知曲目'}${project ? ` · ${project.name}` : ''} · ${session.date} ${session.period} · ${session.roomNo}`;
  };

  const selects: FilterSelectConfig[] = useMemo(
    () => [
      { key: 'grades', label: '评级', options: TAKE_GRADES.map((item) => ({ label: item, value: item })) },
      { key: 'issues', label: '问题标签', options: TAKE_ISSUES.map((item) => ({ label: item, value: item })) },
      {
        key: 'sessionIds',
        label: '场次',
        options: sessions.map((item) => ({ label: `${item.date} ${item.period} ${item.roomNo}`, value: item.id }))
      }
    ],
    [sessions]
  );

  const scoped = useMemo(
    () => (currentSessionId ? filtered.filter((take) => take.sessionId === currentSessionId) : filtered),
    [filtered, currentSessionId]
  );

  const lockedSessionCount = useMemo(() => sessions.filter((session) => session.finalized).length, [sessions]);

  const totals = useMemo(() => {
    const usable = scoped.filter((take) => take.grade === '可用').length;
    const issues = scoped.filter((take) => take.issues.some((issue) => issue !== '无')).length;
    return {
      total: scoped.length,
      usable,
      pending: scoped.filter((take) => take.grade === '待定').length,
      discarded: scoped.filter((take) => take.grade === '废').length,
      usableRatio: scoped.length > 0 ? Math.round((usable / scoped.length) * 100) : 0,
      issueCount: issues,
      durationText: formatDuration(totalDuration(scoped)),
      lockedTakes: scoped.filter((take) => sessionOf(take.sessionId)?.finalized).length
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped, sessions]);

  function reportCascade(result: TakeSaveResult): void {
    if (result.invalidatedPicks > 0) {
      message.warning(`优选 Take 已失效 ${result.invalidatedPicks} 条，置为待复核，请制作人确认`);
    }
    if (result.resetRetakes > 0) {
      message.warning(`同曲目已排期补录计划 ${result.resetRetakes} 条已退回待安排`);
    }
  }

  const columns: ColumnsType<TakeRow> = [
    {
      title: '场次',
      minWidth: 240,
      render: (_, row) => {
        const session = sessionOf(row.sessionId);
        return (
          <div>
            <div>{sessionLabel(row.sessionId)}</div>
            <div className="muted">
              时长 {formatDuration(takeDuration(row.startTc, row.endTc))} · 条次 {row.takeNo}
            </div>
            {session?.finalized ? (
              <Tag icon={<LockOutlined />} color="red" style={{ marginTop: 4 }}>
                场次已封版 · 只读
              </Tag>
            ) : null}
          </div>
        );
      }
    },
    { title: 'Take 号', dataIndex: 'takeNo', width: 90 },
    { title: '起始时间码', dataIndex: 'startTc', width: 130 },
    { title: '结束时间码', dataIndex: 'endTc', width: 130 },
    {
      title: '评级 / 问题标签',
      width: 210,
      render: (_, row) => <TakeBadge grade={row.grade} issues={row.issues} />
    },
    {
      title: '操作',
      width: 150,
      render: (_, row) => {
        const locked = sessionOf(row.sessionId)?.finalized ?? false;
        return (
          <Space>
            <Button
              type="link"
              size="small"
              onClick={() => {
                const session = sessionOf(row.sessionId);
                setEditing(row);
                setError(null);
                setStale(false);
                setReadOnly(locked);
                setBaseTakeVersion(row.updatedAt);
                setBaseSessionVersion(session?.updatedAt);
                form.setFieldsValue({
                  sessionId: row.sessionId,
                  takeNo: row.takeNo,
                  startTc: row.startTc,
                  endTc: row.endTc,
                  grade: row.grade,
                  issues: row.issues
                });
                setDialogOpen(true);
              }}
            >
              {locked ? '查看' : '编辑'}
            </Button>
            <Popconfirm
              title="删除该条次？"
              description={
                locked ? '场次已封版，Take 只读' : '对应的优选记录也会一并删除'
              }
              onConfirm={async () => {
                try {
                  await deleteTake(row.id);
                  message.success('条次已删除');
                } catch (error) {
                  message.error(error instanceof Error ? error.message : '删除失败');
                }
              }}
              disabled={locked}
            >
              <Button type="link" size="small" danger disabled={locked}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        );
      }
    }
  ];

  async function submit(): Promise<void> {
    const values = await form.validateFields();
    const start = tcToSeconds(values.startTc);
    const end = tcToSeconds(values.endTc);
    if (Number.isNaN(start) || !isTimecode(values.startTc)) {
      setError('起始时间码格式应为 HH:MM:SS:FF');
      return;
    }
    if (Number.isNaN(end) || !isTimecode(values.endTc)) {
      setError('结束时间码格式应为 HH:MM:SS:FF');
      return;
    }
    if (end <= start) {
      setError('结束时间码必须晚于起始时间码');
      return;
    }
    const siblings = takes.filter((take) => take.sessionId === values.sessionId && take.id !== editing?.id);
    const clash = siblings.find((take) => isOverlapping(values.startTc, values.endTc, take.startTc, take.endTc));
    setError(null);
    const targetSession = sessionOf(values.sessionId);
    if (targetSession?.finalized) {
      setError('该场次已封版，不能新增或修改 Take，请由制作人重开后再试');
      message.error('场次已封版');
      return;
    }
    try {
      if (editing) {
        const result = await editTake(editing.id, values, {
          expectedUpdatedAt: baseTakeVersion,
          expectedSessionUpdatedAt: baseSessionVersion
        });
        message.success('条次已更新');
        reportCascade(result);
      } else {
        await createTake(values);
        message.success('条次已标记');
      }
      if (clash) {
        message.warning(`注意：与同场次 ${clash.takeNo}（${clash.startTc} → ${clash.endTc}）时间码重叠`);
      }
      setDialogOpen(false);
      setEditing(null);
      setReadOnly(false);
      setBaseTakeVersion(undefined);
      setBaseSessionVersion(undefined);
      form.resetFields();
    } catch (submitError) {
      // 冲突：保留弹窗与输入，按已封版 / 已改动提示，不覆盖新版本
      if (submitError instanceof EditConflictError) {
        setError(submitError.message);
        if (submitError.kind === 'stale') {
          setStale(true);
          message.warning('场次或条次已改动，本条次未保存，请载入最新版本核对（输入已保留）');
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

  /** 冲突后载入最新版本：保留弹窗，仅把字段刷新为库里的新版本，用户可在其上继续改 */
  function reloadLatest(): void {
    if (!editing) return;
    const fresh = takes.find((item) => item.id === editing.id);
    const freshSession = fresh ? sessionOf(fresh.sessionId) : undefined;
    if (!fresh) {
      message.error('该条次已被另一方删除');
      setDialogOpen(false);
      setEditing(null);
      return;
    }
    setEditing(fresh);
    setBaseTakeVersion(fresh.updatedAt);
    setBaseSessionVersion(freshSession?.updatedAt);
    setReadOnly(Boolean(freshSession?.finalized));
    setStale(false);
    setError(null);
    form.setFieldsValue({
      sessionId: fresh.sessionId,
      takeNo: fresh.takeNo,
      startTc: fresh.startTc,
      endTc: fresh.endTc,
      grade: fresh.grade,
      issues: fresh.issues
    });
    message.info('已载入另一方保存的最新版本，您的输入可在其基础上继续修改');
  }

  /** 打开新增弹窗时自动递增 Take 号 */
  function openCreate(): void {
    const targetSessionId = currentSessionId ?? sessions.find((session) => !session.finalized)?.id ?? sessions[0]?.id ?? '';
    const siblings = takes.filter((take) => take.sessionId === targetSessionId);
    setEditing(null);
    setReadOnly(false);
    setBaseTakeVersion(undefined);
    setBaseSessionVersion(undefined);
    setError(null);
    setStale(false);
    form.setFieldsValue({
      ...createEmptyTake(),
      sessionId: targetSessionId,
      takeNo: suggestNextTakeNo(sortByStart(siblings))
    });
    setDialogOpen(true);
  }

  const selectedLockedCount = selectedIds.filter((id) => {
    const take = takes.find((item) => item.id === id);
    return take ? sessionOf(take.sessionId)?.finalized : false;
  }).length;

  async function handleBatchGrade(grade: TakeGrade): Promise<void> {
    try {
      const result = await batchGrade(selectedIds, grade);
      message.success(`已将 ${selectedIds.length} 条改为「${grade}」`);
      reportCascade(result);
    } catch (error) {
      if (error instanceof EditConflictError) {
        message.error(error.message);
        return;
      }
      message.error(error instanceof Error ? error.message : '批量改评级失败');
    }
  }

  const watchedSessionLocked = pickedSessionId ? sessionOf(pickedSessionId)?.finalized : false;

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h2 className="page__title">Take 标记台</h2>
          <p className="page__subtitle">
            时间码格式 HH:MM:SS:FF（{25} 帧）；封版场次只读；时间码 / 评级 / 问题标签改动会立刻使优选失效、补录退回待安排。
          </p>
        </div>
        <Space>
          <RoleSwitch compact />
          <Button type="primary" icon={<PlusOutlined />} disabled={sessions.length === 0} onClick={openCreate}>
            标记 Take
          </Button>
        </Space>
      </div>

      <div className="badge-row">
        <StatBadge label="条次总数" value={totals.total} suffix="条" tone="primary" icon="files" />
        <StatBadge label="可用" value={totals.usable} suffix="条" tone="success" icon="grid" />
        <StatBadge label="待定" value={totals.pending} suffix="条" tone="warning" icon="histogram" />
        <StatBadge label="废条" value={totals.discarded} suffix="条" tone="danger" icon="warning" />
        <StatBadge label="封版只读" value={totals.lockedTakes} suffix="条" tone="danger" icon="warning" />
        <StatBadge label="可用率" value={totals.usableRatio} percent={totals.usableRatio} showPercent tone="info" icon="pie" />
        <StatBadge label="有问题的条次" value={totals.issueCount} suffix="条" tone="danger" icon="warning" />
        <StatBadge label="合计时长" value={totals.durationText} tone="default" icon="trend" />
      </div>

      {lockedSessionCount > 0 ? (
        <Alert
          type="info"
          showIcon
          message={`已有 ${lockedSessionCount} 个场次封版，封版场次的 Take 仅可查看，不能增删改或批量改评级`}
        />
      ) : null}

      <FilterBar
        modelValue={filters}
        selects={selects}
        keywordPlaceholder="搜索 Take 号 / 时间码 / 棚号 / 录音师…"
        onChange={applyFilters}
        onReset={() => {
          resetFilters();
          setSearchParams({}, { replace: true });
        }}
        extra={
          <Space size={6}>
            <span className="filter-bar__label">时间码区间</span>
            <Input
              style={{ width: 140 }}
              placeholder="起始 HH:MM:SS:FF"
              value={String(filters.minTc ?? '')}
              onChange={(event) => applyFilters({ ...filters, minTc: event.target.value })}
            />
            <Input
              style={{ width: 140 }}
              placeholder="结束 HH:MM:SS:FF"
              value={String(filters.maxTc ?? '')}
              onChange={(event) => applyFilters({ ...filters, maxTc: event.target.value })}
            />
          </Space>
        }
      />

      <Card
        title={`条次清单（${scoped.length}）`}
        extra={
          <Space>
            <span className="muted">已选 {selectedIds.length} 条</span>
            {selectedLockedCount > 0 ? (
              <Tooltip title="选中条次包含封版场次，整批会被拦截">
                <Tag color="red">含 {selectedLockedCount} 条封版只读</Tag>
              </Tooltip>
            ) : null}
            <Segmented
              options={TAKE_GRADES}
              disabled={selectedIds.length === 0}
              onChange={(value) => {
                void handleBatchGrade(value as TakeGrade);
              }}
            />
            <Button size="small" disabled={selectedIds.length === 0} onClick={() => setSelected([])}>
              清空选择
            </Button>
          </Space>
        }
      >
        {scoped.length === 0 ? (
          <EmptyPanel
            title="暂无 Take 标记"
            description="为场次标记起止时间码、问题标签与评级。"
            showCreate={sessions.length > 0}
            createText="标记 Take"
            onCreate={openCreate}
          />
        ) : (
          <Table<TakeRow>
            rowKey="id"
            dataSource={scoped}
            columns={columns}
            pagination={false}
            rowClassName={(row) => (sessionOf(row.sessionId)?.finalized ? 'session-row-locked' : '')}
            rowSelection={{
              selectedRowKeys: selectedIds,
              onChange: (keys) => setSelected(keys as string[]),
              onSelect: (row) => toggleSelected(row.id),
              getCheckboxProps: (row) => ({
                disabled: sessionOf(row.sessionId)?.finalized ?? false
              })
            }}
          />
        )}
      </Card>

      <Modal
        open={dialogOpen}
        title={
          readOnly
            ? '查看条次（场次已封版 · 只读）'
            : editing
              ? '编辑条次'
              : '标记 Take'
        }
        onCancel={() => {
          setDialogOpen(false);
          setEditing(null);
          setReadOnly(false);
          setBaseTakeVersion(undefined);
          setBaseSessionVersion(undefined);
        }}
        onOk={submit}
        okText="保存"
        cancelText="取消"
        okButtonProps={{ disabled: readOnly || watchedSessionLocked }}
        destroyOnClose
      >
        {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} action={
          stale ? <Button size="small" onClick={reloadLatest}>载入最新版本</Button> : undefined
        } /> : null}
        {watchedSessionLocked ? (
          <Alert
            type="error"
            showIcon
            icon={<LockOutlined />}
            style={{ marginBottom: 12 }}
            message="该场次已封版，不能在此新增 / 修改 Take；请由制作人重开后再试。"
          />
        ) : null}
        <Form form={form} layout="vertical" disabled={readOnly}>
          <Form.Item name="sessionId" label="场次" rules={[{ required: true, message: '请选择场次' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={sessions.map((session) => ({
                label: `${session.finalized ? '🔒 ' : ''}${sessionLabel(session.id)}`,
                value: session.id
              }))}
              onChange={(value: string) => {
                const siblings = takes.filter((take) => take.sessionId === value);
                form.setFieldsValue({ takeNo: suggestNextTakeNo(sortByStart(siblings)) });
              }}
            />
          </Form.Item>
          <Space size={12} wrap>
            <Form.Item name="takeNo" label="Take 号" rules={[{ required: true, message: '请填写 Take 号' }]}>
              <Input style={{ width: 120 }} placeholder="如：T04" />
            </Form.Item>
            <Form.Item
              name="startTc"
              label="起始时间码"
              rules={[{ required: true, message: '请填写起始时间码' }]}
              extra={<span className="muted">HH:MM:SS:FF</span>}
            >
              <Input style={{ width: 170 }} placeholder="00:00:00:00" />
            </Form.Item>
            <Form.Item
              name="endTc"
              label="结束时间码"
              rules={[{ required: true, message: '请填写结束时间码' }]}
              extra={<span className="muted">需晚于起始</span>}
            >
              <Input style={{ width: 170 }} placeholder="00:03:20:00" />
            </Form.Item>
          </Space>
          <Form.Item name="grade" label="评级" rules={[{ required: true }]}>
            <Select options={TAKE_GRADES.map((item) => ({ label: item, value: item }))} />
          </Form.Item>
          <Form.Item name="issues" label="问题标签">
            <Select
              mode="multiple"
              options={TAKE_ISSUES.map((item) => ({
                label: item,
                value: item
              }))}
            />
          </Form.Item>
        </Form>
        <Tooltip title="同场次内 Take 号会自动递增，也可手动修改">
          <span className="muted">提示：切换到其它场次会自动带出下一个 Take 号；封版场次仅供查看。</span>
        </Tooltip>
      </Modal>
    </div>
  );
}
