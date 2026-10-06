/** /picks 优选 Take 汇总与备注：按用途排序、复核并生成剪接清单 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message
} from 'antd';
import { HolderOutlined, LockOutlined, PlusOutlined } from '@ant-design/icons';
import FilterBar from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import TakeBadge from '@/components/common/TakeBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useIdbTable } from '@/hooks/useIdbTable';
import { usePickStore } from '@/stores/pickStore';
import { useRoleStore } from '@/stores/roleStore';
import { db, type PickRow, type ProjectRow, type SessionRow, type SongRow, type TakeRow } from '@/utils/db';
import { PICK_USAGES, createEmptyPick, type Pick } from '@/types/pick';
import { isProducerRole } from '@/types/role';
import { isSessionLocked } from '@/types/session';
import { isSessionLockedError } from '@/utils/guards';
import type { FilterModel, FilterSelectConfig } from '@/types/filter';
import { buildEditList, formatDuration, takeDuration, totalDuration } from '@/utils/timecode';

const asArray = (value: string | string[] | boolean | undefined): string[] => (Array.isArray(value) ? value : []);

export default function PickSummary() {
  const [searchParams, setSearchParams] = useSearchParams();
  const picks = useIdbTable<PickRow>(db.picks);
  const takes = useIdbTable<TakeRow>(db.takes);
  const sessions = useIdbTable<SessionRow>(db.sessions);
  const songs = useIdbTable<SongRow>(db.songs);
  const projects = useIdbTable<ProjectRow>(db.projects);

  const filters = usePickStore((state) => state.filters);
  const setFilters = usePickStore((state) => state.setFilters);
  const resetFilters = usePickStore((state) => state.resetFilters);
  const createPick = usePickStore((state) => state.createPick);
  const editPick = usePickStore((state) => state.editPick);
  const reviewPick = usePickStore((state) => state.reviewPick);
  const deletePick = usePickStore((state) => state.deletePick);
  const move = usePickStore((state) => state.move);
  const role = useRoleStore((state) => state.role);
  const producer = isProducerRole(role);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PickRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [form] = Form.useForm<Omit<Pick, 'id' | 'order' | 'reviewState' | 'reviewNote'>>();

  const takeById = useMemo(() => new Map(takes.map((take) => [take.id, take])), [takes]);
  const sessionById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const lockedSessionIds = useMemo(
    () => new Set(sessions.filter((session) => isSessionLocked(session)).map((session) => session.id)),
    [sessions]
  );

  useEffect(() => {
    setFilters({
      keyword: searchParams.get('keyword') ?? '',
      usages: searchParams.get('usages') ? (searchParams.get('usages') as string).split(',') : [],
      reviewStates: searchParams.get('reviewStates') ? (searchParams.get('reviewStates') as string).split(',') : []
    });
    // 仅首次挂载还原 URL 筛选
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyFilters(next: FilterModel): void {
    setFilters(next);
    const params: Record<string, string> = {};
    if (String(next.keyword ?? '').length > 0) params.keyword = String(next.keyword);
    asArray(next.usages).length > 0 && (params.usages = asArray(next.usages).join(','));
    asArray(next.reviewStates).length > 0 && (params.reviewStates = asArray(next.reviewStates).join(','));
    setSearchParams(params, { replace: true });
  }

  const takeOf = (takeId: string): TakeRow | null => takeById.get(takeId) ?? null;

  const sessionLabel = (sessionId: string): string => {
    const session = sessionById.get(sessionId);
    if (!session) return '场次已删除';
    const song = songs.find((item) => item.id === session.songId);
    const project = song ? projects.find((item) => item.id === song.projectId) : undefined;
    return `${song ? song.title : '未知曲目'}${project ? ` · ${project.name}` : ''} · ${session.date} ${session.period}`;
  };

  const filtered = useMemo(() => {
    const keyword = String(filters.keyword ?? '').trim().toLowerCase();
    const usages = asArray(filters.usages);
    const reviewStates = asArray(filters.reviewStates);
    return picks
      .filter((pick) => {
        const take = takeOf(pick.takeId);
        const label = `${pick.usage} ${pick.note} ${take ? take.takeNo : ''}`.toLowerCase();
        if (keyword && !label.includes(keyword)) return false;
        if (usages.length > 0 && !usages.includes(pick.usage)) return false;
        if (reviewStates.length > 0 && !reviewStates.includes(pick.reviewState)) return false;
        return true;
      })
      .sort((a, b) => a.order - b.order);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picks, takes, filters]);

  /** 剪接清单只收「有效」优选；待复核的优选失效后不再进入剪接清单 */
  const effectivePicks = useMemo(() => filtered.filter((pick) => pick.reviewState === '有效'), [filtered]);

  const editList = useMemo(
    () =>
      effectivePicks
        .map((pick) => takeById.get(pick.takeId))
        .filter((take): take is TakeRow => take !== undefined)
        .map((take) => ({ takeNo: take.takeNo, startTc: take.startTc, endTc: take.endTc })),
    [effectivePicks, takeById]
  );

  const pendingReviewCount = picks.filter((pick) => pick.reviewState === '待复核').length;

  const totals = useMemo(() => {
    const usable = takes.filter((take) => take.grade === '可用').length;
    return {
      pickCount: picks.length,
      usableTakeCount: usable,
      pickRatio: usable > 0 ? Math.round((picks.length / usable) * 100) : 0,
      durationText: formatDuration(totalDuration(editList)),
      usageCount: new Set(picks.map((item) => item.usage)).size
    };
  }, [picks, takes, editList]);

  /** 只有「可用」评级、尚未被优选且所属场次未封版的条次可作为候选（封版场次只读，选了也存不进） */
  const candidates = useMemo(
    () =>
      takes.filter(
        (take) =>
          take.grade === '可用' &&
          !picks.some((pick) => pick.takeId === take.id) &&
          !lockedSessionIds.has(take.sessionId)
      ),
    [takes, picks, lockedSessionIds]
  );

  async function submit(): Promise<void> {
    const values = await form.validateFields();
    setError(null);
    try {
      if (editing) {
        await editPick(editing.id, values);
        message.success('优选记录已更新');
      } else {
        await createPick(values);
        message.success('已加入剪接清单');
      }
      setDialogOpen(false);
      setEditing(null);
      form.resetFields();
    } catch (submitError) {
      const text = submitError instanceof Error ? submitError.message : '保存失败';
      setError(text);
      if (!isSessionLockedError(submitError)) {
        message.error(text);
      }
    }
  }

  async function handleDrop(index: number): Promise<void> {
    const from = dragIndex;
    setDragIndex(null);
    setOverIndex(null);
    if (from === null || from === index) return;
    try {
      await move(filtered as Pick[], from, index);
      message.success('剪接顺序已更新并写回本地库');
    } catch (moveError) {
      message.error(moveError instanceof Error ? moveError.message : '调整顺序失败');
    }
  }

  async function handleReview(pick: PickRow): Promise<void> {
    await reviewPick(pick.id);
    message.success('复核通过，优选已恢复有效并重新纳入剪接清单');
  }

  const selects: FilterSelectConfig[] = [
    { key: 'usages', label: '用途', options: PICK_USAGES.map((item) => ({ label: item, value: item })) },
    {
      key: 'reviewStates',
      label: '复核',
      options: [
        { label: '有效', value: '有效' },
        { label: '待复核', value: '待复核' }
      ]
    }
  ];

  /** 编辑弹窗中可选条次：未封版场次的可用条次，外加编辑行自身（即便已失效待复核也要回显） */
  const editableTakeOptions = useMemo(() => {
    const openUsable = takes.filter(
      (take) => take.grade === '可用' && !lockedSessionIds.has(take.sessionId)
    );
    if (!editing) return openUsable;
    const self = takeById.get(editing.takeId);
    return self && !openUsable.some((take) => take.id === self.id) ? [self, ...openUsable] : openUsable;
  }, [takes, lockedSessionIds, editing, takeById]);

  const editingTake = editing ? takeById.get(editing.takeId) : undefined;
  const editingLocked = editingTake ? lockedSessionIds.has(editingTake.sessionId) : false;

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h2 className="page__title">优选 Take 汇总与剪接清单</h2>
          <p className="page__subtitle">
            从「可用」条次中挑选排序；来源 Take 时间码 / 评级 / 问题标签一改动，优选立即失效待复核，复核通过后才重新进入剪接清单。
          </p>
        </div>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          disabled={candidates.length === 0}
          onClick={() => {
            setEditing(null);
            setError(null);
            form.setFieldsValue({ ...createEmptyPick(), takeId: candidates[0]?.id ?? '' });
            setDialogOpen(true);
          }}
        >
          加入优选
        </Button>
      </div>

      <div className="badge-row">
        <StatBadge label="优选条次" value={totals.pickCount} suffix="条" tone="primary" icon="files" />
        <StatBadge label="待复核" value={pendingReviewCount} suffix="条" tone="danger" icon="warning" />
        <StatBadge label="可用 Take" value={totals.usableTakeCount} suffix="条" tone="success" icon="grid" />
        <StatBadge label="优选覆盖率" value={totals.pickRatio} percent={totals.pickRatio} showPercent tone="warning" icon="pie" />
        <StatBadge label="剪接总时长" value={totals.durationText} tone="info" icon="histogram" />
        <StatBadge label="用途种类" value={totals.usageCount} suffix="类" tone="default" icon="trend" />
      </div>

      {pendingReviewCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`有 ${pendingReviewCount} 条优选因来源 Take 改动而失效待复核`}
          description={
            producer
              ? '这些优选已暂时移出剪接清单，请逐条核对来源条次后点「复核通过」；所属场次封版时仍可复核。'
              : '这些优选已暂时移出剪接清单，需由制作人核对后复核恢复。'
          }
        />
      ) : null}

      <FilterBar
        modelValue={filters}
        selects={selects}
        keywordPlaceholder="搜索用途 / 备注 / Take 号…"
        onChange={applyFilters}
        onReset={() => {
          resetFilters();
          setSearchParams({}, { replace: true });
        }}
        extra={<Tag color="blue">候选可用 Take {candidates.length} 条</Tag>}
      />

      {filtered.length === 0 ? (
        <EmptyPanel
          title="剪接清单还是空的"
          description="从可用评级的 Take 中挑选片段，组成主歌 / 副歌 / 独奏的剪接清单。"
          showCreate={candidates.length > 0}
          createText="加入优选"
          onCreate={() => {
            setEditing(null);
            form.setFieldsValue({ ...createEmptyPick(), takeId: candidates[0]?.id ?? '' });
            setDialogOpen(true);
          }}
        />
      ) : (
        <Row gutter={16}>
          <Col xs={24} xl={15}>
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              {filtered.map((pick, index) => {
                const take = takeOf(pick.takeId);
                const locked = take ? lockedSessionIds.has(take.sessionId) : false;
                const pending = pick.reviewState === '待复核';
                return (
                  <Card
                    key={pick.id}
                    size="small"
                    draggable={!locked}
                    className={[
                      dragIndex === index ? 'is-dragging' : '',
                      overIndex === index ? 'is-over' : '',
                      pending ? 'pick-pending' : ''
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onDragStart={() => setDragIndex(index)}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setOverIndex(index);
                    }}
                    onDrop={() => void handleDrop(index)}
                    onDragEnd={() => setDragIndex(null)}
                    title={
                      <Space wrap>
                        <HolderOutlined className="drag-handle" />
                        <span>#{index + 1}</span>
                        <Tag color="blue">{pick.usage}</Tag>
                        {pending ? <Tag color="orange">待复核</Tag> : <Tag color="green">有效</Tag>}
                        {locked ? (
                          <Tooltip title="所属场次已封版，优选只读">
                            <Tag color="red" icon={<LockOutlined />}>
                              封版
                            </Tag>
                          </Tooltip>
                        ) : null}
                        {take ? <TakeBadge grade={take.grade} issues={take.issues} showIssues={false} /> : null}
                      </Space>
                    }
                    extra={
                      <Space>
                        {pending ? (
                          <Tooltip title={producer ? '' : '只有制作人可以复核优选'}>
                            <Button
                              size="small"
                              type="primary"
                              ghost
                              disabled={!producer}
                              onClick={() => void handleReview(pick)}
                            >
                              复核通过
                            </Button>
                          </Tooltip>
                        ) : null}
                        <Button
                          size="small"
                          disabled={index === 0 || locked}
                          onClick={() => void move(filtered as Pick[], index, index - 1).catch((moveError: unknown) => message.error(moveError instanceof Error ? moveError.message : '调整顺序失败'))}
                        >
                          上移
                        </Button>
                        <Button
                          size="small"
                          disabled={index === filtered.length - 1 || locked}
                          onClick={() => void move(filtered as Pick[], index, index + 1).catch((moveError: unknown) => message.error(moveError instanceof Error ? moveError.message : '调整顺序失败'))}
                        >
                          下移
                        </Button>
                        <Button
                          size="small"
                          type="link"
                          onClick={() => {
                            setEditing(pick);
                            setError(null);
                            form.setFieldsValue({ takeId: pick.takeId, usage: pick.usage, note: pick.note });
                            setDialogOpen(true);
                          }}
                        >
                          编辑
                        </Button>
                        <Popconfirm
                          title="移出剪接清单？"
                          onConfirm={async () => {
                            await deletePick(pick.id);
                            message.success('已移出剪接清单');
                          }}
                        >
                          <Button size="small" type="link" danger disabled={locked}>
                            删除
                          </Button>
                        </Popconfirm>
                      </Space>
                    }
                  >
                    <Space direction="vertical" size={2}>
                      <Typography.Text>
                        {take ? `${take.takeNo} · ${take.startTc} → ${take.endTc}` : '条次已删除'}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        {take ? `${sessionLabel(take.sessionId)} · 时长 ${formatDuration(takeDuration(take.startTc, take.endTc))}` : '—'}
                      </Typography.Text>
                      <Typography.Text type="secondary">备注：{pick.note || '—'}</Typography.Text>
                      {pending ? (
                        <Typography.Text type="warning">失效原因：{pick.reviewNote || '来源 Take 已改动'}</Typography.Text>
                      ) : null}
                    </Space>
                  </Card>
                );
              })}
            </Space>
          </Col>
          <Col xs={24} xl={9}>
            <Card title={`剪接清单（自动生成，仅有效优选 · ${editList.length} 段）`}>
              {editList.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可拼接的有效片段（待复核优选不计入）" />
              ) : (
                <List
                  size="small"
                  dataSource={editList}
                  footer={
                    <Typography.Text strong>
                      合计时长 {formatDuration(totalDuration(editList))} · 共 {editList.length} 段
                    </Typography.Text>
                  }
                  renderItem={(item, index) => (
                    <List.Item>
                      <Space>
                        <Tag>{index + 1}</Tag>
                        <span>{item.takeNo}</span>
                        <Typography.Text type="secondary">
                          {item.startTc} → {item.endTc}
                        </Typography.Text>
                      </Space>
                    </List.Item>
                  )}
                />
              )}
              <Typography.Paragraph copyable={{ text: buildEditList(editList) }} style={{ marginTop: 12 }}>
                <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap' }}>{buildEditList(editList) || '（空）'}</pre>
              </Typography.Paragraph>
            </Card>
          </Col>
        </Row>
      )}

      <Card title="优选明细表">
        <Table<PickRow>
          rowKey="id"
          dataSource={[...filtered].sort((a, b) => a.order - b.order)}
          pagination={false}
          locale={{ emptyText: '暂无优选记录' }}
          columns={[
            { title: '顺序', dataIndex: 'order', width: 80 },
            { title: '用途', dataIndex: 'usage', width: 100 },
            {
              title: '复核状态',
              dataIndex: 'reviewState',
              width: 110,
              render: (value: Pick['reviewState']) =>
                value === '待复核' ? <Tag color="orange">待复核</Tag> : <Tag color="green">有效</Tag>
            },
            {
              title: '条次',
              minWidth: 200,
              render: (_, row) => {
                const take = takeOf(row.takeId);
                return take ? `${take.takeNo} · ${take.startTc} → ${take.endTc}` : '条次已删除';
              }
            },
            {
              title: '失效 / 备注',
              minWidth: 220,
              render: (_, row) => (
                <Space direction="vertical" size={0}>
                  <span>备注：{row.note || '—'}</span>
                  {row.reviewState === '待复核' ? (
                    <Typography.Text type="warning">{row.reviewNote || '来源 Take 已改动'}</Typography.Text>
                  ) : null}
                </Space>
              )
            },
            {
              title: '时长',
              width: 100,
              render: (_, row) => {
                const take = takeOf(row.takeId);
                return take ? formatDuration(takeDuration(take.startTc, take.endTc)) : '—';
              }
            }
          ]}
        />
      </Card>

      <Modal
        open={dialogOpen}
        title={editingLocked ? '查看已封版场次的优选' : editing ? '编辑优选记录' : '加入剪接清单'}
        onCancel={() => setDialogOpen(false)}
        onOk={submit}
        okText={editingLocked ? '关闭' : '保存'}
        cancelText="取消"
        footer={
          editingLocked
            ? [
                <Button key="close" type="primary" onClick={() => setDialogOpen(false)}>
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
            message="所属场次已封版，优选只可查看"
            description="如需调整用途、备注或条次，请由制作人在「场次安排」重开（写原因）后再编辑。"
          />
        ) : null}
        {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
        <Form form={form} layout="vertical" disabled={editingLocked}>
          <Form.Item name="takeId" label="条次" rules={[{ required: true, message: '请选择条次' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={editableTakeOptions.map((take) => ({
                label: `${take.takeNo} · ${take.startTc} → ${take.endTc}`,
                value: take.id
              }))}
            />
          </Form.Item>
          <Form.Item name="usage" label="用途" rules={[{ required: true }]}>
            <Select options={PICK_USAGES.map((item) => ({ label: item, value: item }))} />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} placeholder="如：鼓组干净，可作主歌第一段" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
