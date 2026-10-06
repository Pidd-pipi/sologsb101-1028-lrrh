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
import { LockOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import FilterBar from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import TakeBadge from '@/components/common/TakeBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useIdbTable } from '@/hooks/useIdbTable';
import { useTakeFilter } from '@/hooks/useTakeFilter';
import { useTakeStore } from '@/stores/takeStore';
import { useSessionStore } from '@/stores/sessionStore';
import { db, type ProjectRow, type SessionRow, type SongRow, type TakeRow } from '@/utils/db';
import { TAKE_GRADES, TAKE_ISSUES, createEmptyTake, type Take, type TakeGrade } from '@/types/take';
import type { FilterSelectConfig } from '@/types/filter';
import { isSessionLocked } from '@/types/session';
import { isSessionLockedError, isStaleRowError } from '@/utils/guards';
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
  const [editing, setEditing] = useState<TakeRow | null>(null);
  /** 打开弹窗时条次的版本（updatedAt）：另一标签页已改动则拒绝旧内容覆盖 */
  const [baselineAt, setBaselineAt] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  /** 本次保存被封版 / 并发拦截（保留输入，给出载入最新版本入口） */
  const [submitBlocked, setSubmitBlocked] = useState(false);
  const [form] = Form.useForm<Omit<Take, 'id'>>();

  const lockedSessionIds = useMemo(
    () => new Set(sessions.filter((session) => isSessionLocked(session)).map((session) => session.id)),
    [sessions]
  );  useEffect(() => {
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

  const sessionLabel = (sessionId: string): string => {
    const session = sessions.find((item) => item.id === sessionId);
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

  /** 当前选中的条次里属于已封版场次的（批量改评级前拦截） */
  const takeById = useMemo(() => new Map(takes.map((take) => [take.id, take])), [takes]);
  const selectedLocked = useMemo(
    () => selectedIds.some((id) => lockedSessionIds.has(takeById.get(id)?.sessionId ?? '')),
    [selectedIds, takeById, lockedSessionIds]
  );

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
      lockedCount: scoped.filter((take) => lockedSessionIds.has(take.sessionId)).length,
      durationText: formatDuration(totalDuration(scoped))
    };
  }, [scoped, lockedSessionIds]);

  const columns: ColumnsType<TakeRow> = [
    {
      title: '场次',
      minWidth: 240,
      render: (_, row) => (
        <div>
          <div>
            {lockedSessionIds.has(row.sessionId) ? (
              <Tag color="red" icon={<LockOutlined />} style={{ marginInlineEnd: 6 }}>
                已封版
              </Tag>
            ) : null}
            {sessionLabel(row.sessionId)}
          </div>
          <div className="muted">
            时长 {formatDuration(takeDuration(row.startTc, row.endTc))} · 条次 {row.takeNo}
          </div>
        </div>
      )
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
        const locked = lockedSessionIds.has(row.sessionId);
        return (
          <Space>
            <Button
              type="link"
              size="small"
              onClick={() => {
                setEditing(row);
                setBaselineAt(row.updatedAt);
                setError(null);
                setSubmitBlocked(false);
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
              description={locked ? '所属场次已封版，只可查看' : '对应的优选记录也会一并删除'}
              okText="删除"
              cancelText="取消"
              onConfirm={async () => {
                try {
                  await deleteTake(row.id);
                  message.success('条次已删除');
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
  ];

  /** 用库里最新行刷新弹窗（并发落后时载入新版本） */
  async function reloadEditing(id: string): Promise<void> {
    const latest = await db.takes.get(id);
    if (!latest) {
      message.error('该条次已被其它标签页删除');
      setDialogOpen(false);
      setEditing(null);
      return;
    }
    setEditing(latest);
    setBaselineAt(latest.updatedAt);
    setSubmitBlocked(false);
    setError(null);
    form.setFieldsValue({
      sessionId: latest.sessionId,
      takeNo: latest.takeNo,
      startTc: latest.startTc,
      endTc: latest.endTc,
      grade: latest.grade,
      issues: latest.issues
    });
  }

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
    setSubmitBlocked(false);
    try {
      if (editing) {
        const cascade = await editTake(editing.id, values, baselineAt);
        message.success('条次已更新');
        if (cascade.invalidatedPicks > 0 || cascade.demotedRetakes > 0) {
          message.warning(
            `关联联动：${cascade.invalidatedPicks} 条优选已失效待复核，${cascade.demotedRetakes} 条已排期补录退回待安排`
          );
        }
      } else {
        await createTake(values);
        message.success('条次已标记');
      }
      if (clash) {
        message.warning(`注意：与同场次 ${clash.takeNo}（${clash.startTc} → ${clash.endTc}）时间码重叠`);
      }
      setDialogOpen(false);
      setEditing(null);
      form.resetFields();
    } catch (submitError) {
      const text = submitError instanceof Error ? submitError.message : '保存失败';
      setError(text);
      if (isSessionLockedError(submitError) || isStaleRowError(submitError)) {
        // 封版 / 并发落后：输入保留、弹窗不关闭
        setSubmitBlocked(true);
        return;
      }
      message.error(text);
    }
  }

  /** 打开新增弹窗时自动递增 Take 号 */
  function openCreate(): void {
    const targetSessionId = currentSessionId ?? sessions[0]?.id ?? '';
    const siblings = takes.filter((take) => take.sessionId === targetSessionId);
    setEditing(null);
    setBaselineAt(undefined);
    setError(null);
    setSubmitBlocked(false);
    form.setFieldsValue({
      ...createEmptyTake(),
      sessionId: targetSessionId,
      takeNo: suggestNextTakeNo(sortByStart(siblings))
    });
    setDialogOpen(true);
  }

  const editingLocked = editing !== null && lockedSessionIds.has(editing.sessionId);
  const createTargetLocked =
    !editing && currentSessionId !== null ? lockedSessionIds.has(currentSessionId) : false;

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h2 className="page__title">Take 标记台</h2>
          <p className="page__subtitle">
            时间码格式 HH:MM:SS:FF（25 帧）；结束时间码必须晚于起始。场次封版后只可查看；时间码 / 评级 /
            问题标签一改动，优选立即失效待复核，已排期补录退回待安排。
          </p>
        </div>
        <Button type="primary" disabled={sessions.length === 0 || createTargetLocked} onClick={openCreate}>
          标记 Take
        </Button>
      </div>

      <div className="badge-row">
        <StatBadge label="条次总数" value={totals.total} suffix="条" tone="primary" icon="files" />
        <StatBadge label="可用" value={totals.usable} suffix="条" tone="success" icon="grid" />
        <StatBadge label="待定" value={totals.pending} suffix="条" tone="warning" icon="histogram" />
        <StatBadge label="废条" value={totals.discarded} suffix="条" tone="danger" icon="warning" />
        <StatBadge label="封版场次条次" value={totals.lockedCount} suffix="条" tone="default" icon="warning" />
        <StatBadge label="有问题的条次" value={totals.issueCount} suffix="条" tone="danger" icon="warning" />
        <StatBadge label="合计时长" value={totals.durationText} tone="info" icon="trend" />
      </div>

      {selectedLocked ? (
        <Alert
          type="error"
          showIcon
          icon={<LockOutlined />}
          message="选中的条次中包含已封版场次"
          description="已封版场次只可查看，无法批量改评级；请先在「场次安排」由制作人重开（写原因），或取消选择这些条次。"
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
            <Segmented
              options={TAKE_GRADES}
              disabled={selectedIds.length === 0 || selectedLocked}
              onChange={(value) => {
                void (async () => {
                  try {
                    const count = selectedIds.length;
                    const cascade = await batchGrade(selectedIds, value as TakeGrade);
                    message.success(`已将 ${count} 条改为「${value}」`);
                    if (cascade.invalidatedPicks > 0 || cascade.demotedRetakes > 0) {
                      message.warning(
                        `关联联动：${cascade.invalidatedPicks} 条优选已失效待复核，${cascade.demotedRetakes} 条已排期补录退回待安排`
                      );
                    }
                  } catch (batchError) {
                    message.error(batchError instanceof Error ? batchError.message : '批量改评级失败');
                  }
                })();
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
            rowSelection={{
              selectedRowKeys: selectedIds,
              onChange: (keys) => setSelected(keys as string[]),
              onSelect: (row) => toggleSelected(row.id),
              getCheckboxProps: (row) => ({ disabled: lockedSessionIds.has(row.sessionId) })
            }}
          />
        )}
      </Card>

      <Modal
        open={dialogOpen}
        title={editingLocked ? '查看已封版场次的 Take' : editing ? '编辑条次' : '标记 Take'}
        onCancel={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        onOk={submit}
        okText={editingLocked ? '关闭' : '保存'}
        cancelText="取消"
        footer={
          editingLocked
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
        {editingLocked ? (
          <Alert
            type="error"
            showIcon
            icon={<LockOutlined />}
            style={{ marginBottom: 12 }}
            message="所属场次已封版，当前只可查看"
            description="时间码、评级与问题标签的改动会被拦截；如需修改，请由制作人在「场次安排」重开并填写原因。"
          />
        ) : null}
        {!editingLocked && createTargetLocked ? (
          <Alert
            type="warning"
            showIcon
            icon={<LockOutlined />}
            style={{ marginBottom: 12 }}
            message="当前场次已封版"
            description="新建 Take 会被拦截，请先切换到未封版场次或由制作人重开当前场次。"
          />
        ) : null}
        {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
        <Form form={form} layout="vertical" disabled={editingLocked}>
          <Form.Item name="sessionId" label="场次" rules={[{ required: true, message: '请选择场次' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={sessions.map((session) => ({
                label: `${session.lockState === '已封版' ? '🔒 ' : ''}${sessionLabel(session.id)}`,
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
          <span className="muted">提示：切换到其它场次会自动带出下一个 Take 号</span>
        </Tooltip>

        {submitBlocked && editing ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 12 }}
            message="输入已保留，旧内容未覆盖新版本"
            description="所属场次已封版，或该条次已被另一标签页改动。可载入最新版本对照后再决定，或关闭放弃。"
            action={
              <Button size="small" onClick={() => void reloadEditing(editing.id)}>
                载入最新版本
              </Button>
            }
          />
        ) : null}
      </Modal>
    </div>
  );
}
