/** /picks 优选 Take 汇总与备注：按用途排序并生成剪接清单 */
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
import RoleSwitch from '@/components/common/RoleSwitch';
import ReviewStateTag from '@/components/common/ReviewStateTag';
import { useIdbTable } from '@/hooks/useIdbTable';
import { usePickStore } from '@/stores/pickStore';
import { db, type PickRow, type ProjectRow, type SessionRow, type SongRow, type TakeRow } from '@/utils/db';
import { PICK_USAGES, createEmptyPick, type Pick } from '@/types/pick';
import type { FilterModel, FilterSelectConfig } from '@/types/filter';
import { EditConflictError } from '@/utils/lockdown';
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
  const deletePick = usePickStore((state) => state.deletePick);
  const reviewPick = usePickStore((state) => state.reviewPick);
  const move = usePickStore((state) => state.move);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PickRow | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [form] = Form.useForm<Omit<Pick, 'id' | 'order'>>();

  useEffect(() => {
    setFilters({
      keyword: searchParams.get('keyword') ?? '',
      usages: searchParams.get('usages') ? (searchParams.get('usages') as string).split(',') : []
    });
    // 仅首次挂载还原 URL 筛选
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyFilters(next: FilterModel): void {
    setFilters(next);
    const params: Record<string, string> = {};
    if (String(next.keyword ?? '').length > 0) params.keyword = String(next.keyword);
    asArray(next.usages).length > 0 && (params.usages = asArray(next.usages).join(','));
    setSearchParams(params, { replace: true });
  }

  const takeOf = (takeId: string): TakeRow | null => takes.find((item) => item.id === takeId) ?? null;

  /** 优选所属场次是否已封版：封版后优选只读 */
  const pickLocked = (pick: PickRow): boolean => {
    const take = takeOf(pick.takeId);
    if (!take) return false;
    return sessions.find((item) => item.id === take.sessionId)?.finalized ?? false;
  };

  const sessionLabel = (sessionId: string): string => {
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) return '场次已删除';
    const song = songs.find((item) => item.id === session.songId);
    const project = song ? projects.find((item) => item.id === song.projectId) : undefined;
    return `${song ? song.title : '未知曲目'}${project ? ` · ${project.name}` : ''} · ${session.date} ${session.period}`;
  };

  const filtered = useMemo(() => {
    const keyword = String(filters.keyword ?? '').trim().toLowerCase();
    const usages = asArray(filters.usages);
    return picks
      .filter((pick) => {
        const take = takeOf(pick.takeId);
        const label = `${pick.usage} ${pick.note} ${take ? take.takeNo : ''}`.toLowerCase();
        if (keyword && !label.includes(keyword)) return false;
        if (usages.length > 0 && !usages.includes(pick.usage)) return false;
        return true;
      })
      .sort((a, b) => {
        // 卡片清单：生效项在前（按顺序），待复核项排到清单末尾，恢复后回到末尾槽位
        if ((a.reviewState === '待复核') !== (b.reviewState === '待复核')) {
          return a.reviewState === '待复核' ? 1 : -1;
        }
        return a.order - b.order;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picks, takes, filters]);

  /** 只有「可用」评级、尚未被优选且所属场次未封版的条次可作为候选 */
  const candidates = useMemo(() => {
    const lockedSessionIds = new Set(sessions.filter((session) => session.finalized).map((session) => session.id));
    return takes.filter(
      (take) =>
        take.grade === '可用' &&
        !picks.some((pick) => pick.takeId === take.id) &&
        !lockedSessionIds.has(take.sessionId)
    );
  }, [takes, picks, sessions]);

  const pendingReviewCount = picks.filter((pick) => pick.reviewState === '待复核').length;
  const lockedPickCount = picks.filter(pickLocked).length;

  /** 待复核片段不进入剪接清单（复核通过后恢复） */
  const activePicks = useMemo(() => filtered.filter((pick) => pick.reviewState !== '待复核'), [filtered]);

  const editList = useMemo(
    () =>
      activePicks
        .map((pick) => takeOf(pick.takeId))
        .filter((take): take is TakeRow => take !== null)
        .map((take) => ({ takeNo: take.takeNo, startTc: take.startTc, endTc: take.endTc })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activePicks, takes]
  );

  const totals = useMemo(() => {
    const usable = takes.filter((take) => take.grade === '可用').length;
    return {
      pickCount: picks.length,
      usableTakeCount: usable,
      pickRatio: usable > 0 ? Math.round((picks.length / usable) * 100) : 0,
      durationText: formatDuration(totalDuration(editList)),
      usageCount: new Set(picks.map((item) => item.usage)).size,
      pendingReview: pendingReviewCount
    };
  }, [picks, takes, editList, pendingReviewCount]);

  async function submit(): Promise<void> {
    const values = await form.validateFields();
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
    } catch (error) {
      if (error instanceof EditConflictError) {
        message.error(error.message);
        return;
      }
      message.error(error instanceof Error ? error.message : '保存失败');
    }
  }

  async function handleDrop(index: number): Promise<void> {
    const from = dragIndex;
    setDragIndex(null);
    setOverIndex(null);
    if (from === null || from === index) return;
    try {
      // 拖拽子清单只含生效中的优选，移动时按生效清单的下标映射回完整优选列表
      await move(activePicks as Pick[], from, index);
      message.success('剪接顺序已更新并写回本地库');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '调整顺序失败');
    }
  }

  async function handleReview(pick: PickRow): Promise<void> {
    try {
      await reviewPick(pick.id);
      message.success('复核通过，优选已重新生效');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '复核失败');
    }
  }

  const selects: FilterSelectConfig[] = [
    { key: 'usages', label: '用途', options: PICK_USAGES.map((item) => ({ label: item, value: item })) }
  ];

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h2 className="page__title">优选 Take 汇总与剪接清单</h2>
          <p className="page__subtitle">从「可用」评级的条次中挑选，拖拽卡片或用上下移按钮调整剪接顺序。</p>
        </div>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          disabled={candidates.length === 0}
          onClick={() => {
            setEditing(null);
            form.setFieldsValue({ ...createEmptyPick(), takeId: candidates[0]?.id ?? '' });
            setDialogOpen(true);
          }}
        >
          加入优选
        </Button>
      </div>

      <div className="badge-row">
        <StatBadge label="优选条次" value={totals.pickCount} suffix="条" tone="primary" icon="files" />
        <StatBadge label="可用 Take" value={totals.usableTakeCount} suffix="条" tone="success" icon="grid" />
        <StatBadge label="优选覆盖率" value={totals.pickRatio} percent={totals.pickRatio} showPercent tone="warning" icon="pie" />
        <StatBadge label="待复核" value={totals.pendingReview} suffix="条" tone="danger" icon="warning" />
        <StatBadge label="剪接总时长" value={totals.durationText} tone="info" icon="histogram" />
        <StatBadge label="用途种类" value={totals.usageCount} suffix="类" tone="danger" icon="trend" />
      </div>

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

      {pendingReviewCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`有 ${pendingReviewCount} 条优选因源 Take 的时间码 / 评级 / 问题标签改动而失效，待制作人复核`}
          description="待复核条次暂不进入剪接清单；请核对源 Take 后点「复核通过」，或删除重选。"
        />
      ) : null}
      {lockedPickCount > 0 ? (
        <Alert
          type="info"
          showIcon
          icon={<LockOutlined />}
          message={`${lockedPickCount} 条优选属于已封版场次，仅可查看，不能编辑 / 排序 / 移出`}
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
        extra={
          <Space>
            <Tag color="blue">候选可用 Take {candidates.length} 条</Tag>
            <RoleSwitch compact />
          </Space>
        }
      />

      {filtered.length === 0 ? (
        <EmptyPanel
          title="剪接清单还是空的"
          description="从可用评级、未封版场次的 Take 中挑选片段，组成主歌 / 副歌 / 独奏的剪接清单。"
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
              {filtered.map((pick) => {
                const take = takeOf(pick.takeId);
                const locked = pickLocked(pick);
                const activeIndex = activePicks.findIndex((item) => item.id === pick.id);
                return (
                  <Card
                    key={pick.id}
                    size="small"
                    draggable={!locked && pick.reviewState !== '待复核'}
                    className={[
                      dragIndex === activeIndex ? 'is-dragging' : '',
                      overIndex === activeIndex ? 'is-over' : '',
                      locked ? 'session-row-locked' : '',
                      pick.reviewState === '待复核' ? 'pick-row-review' : ''
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onDragStart={() => setDragIndex(activeIndex)}
                    onDragOver={(event) => {
                      if (locked || activeIndex < 0) return;
                      event.preventDefault();
                      setOverIndex(activeIndex);
                    }}
                    onDrop={() => void handleDrop(activeIndex)}
                    onDragEnd={() => {
                      setDragIndex(null);
                      setOverIndex(null);
                    }}
                    title={
                      <Space wrap>
                        <HolderOutlined className="drag-handle" />
                        <span>#{activeIndex >= 0 ? activeIndex + 1 : '—'}</span>
                        <Tag color="blue">{pick.usage}</Tag>
                        {take ? <TakeBadge grade={take.grade} issues={take.issues} showIssues={false} /> : null}
                        <ReviewStateTag pick={pick} />
                        {locked ? (
                          <Tooltip title="所属场次已封版，只读">
                            <Tag icon={<LockOutlined />} color="red">
                              封版只读
                            </Tag>
                          </Tooltip>
                        ) : null}
                      </Space>
                    }
                    extra={
                      <Space wrap>
                        {pick.reviewState === '待复核' ? (
                          <Button
                            size="small"
                            type="primary"
                            ghost
                            disabled={locked}
                            onClick={() => void handleReview(pick)}
                          >
                            复核通过
                          </Button>
                        ) : null}
                        <Button
                          size="small"
                          disabled={activeIndex <= 0 || locked}
                          onClick={() => void move(activePicks as Pick[], activeIndex, activeIndex - 1)}
                        >
                          上移
                        </Button>
                        <Button
                          size="small"
                          disabled={activeIndex < 0 || activeIndex >= activePicks.length - 1 || locked}
                          onClick={() => void move(activePicks as Pick[], activeIndex, activeIndex + 1)}
                        >
                          下移
                        </Button>
                        <Button
                          size="small"
                          type="link"
                          disabled={locked}
                          onClick={() => {
                            setEditing(pick);
                            form.setFieldsValue({ takeId: pick.takeId, usage: pick.usage, note: pick.note });
                            setDialogOpen(true);
                          }}
                        >
                          编辑
                        </Button>
                        <Popconfirm
                          title="移出剪接清单？"
                          onConfirm={async () => {
                            try {
                              await deletePick(pick.id);
                              message.success('已移出剪接清单');
                            } catch (error) {
                              message.error(error instanceof Error ? error.message : '删除失败');
                            }
                          }}
                          disabled={locked}
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
                      {pick.reviewState === '待复核' ? (
                        <Typography.Text type="warning">{pick.reviewNote || '源 Take 已改动，优选失效待复核'}</Typography.Text>
                      ) : null}
                    </Space>
                  </Card>
                );
              })}
            </Space>
          </Col>
          <Col xs={24} xl={9}>
            <Card title="剪接清单（自动生成）">
              {editList.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可拼接的片段" />
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
              title: '条次',
              minWidth: 200,
              render: (_, row) => {
                const take = takeOf(row.takeId);
                return take ? `${take.takeNo} · ${take.startTc} → ${take.endTc}` : '条次已删除';
              }
            },
            {
              title: '复核状态',
              width: 110,
              render: (_, row) => <ReviewStateTag pick={row} />
            },
            { title: '备注', dataIndex: 'note', minWidth: 200 },
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
        title={editing ? '编辑优选记录' : '加入剪接清单'}
        onCancel={() => setDialogOpen(false)}
        onOk={submit}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        {editing?.reviewState === '待复核' ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={editing.reviewNote || '源 Take 已改动，该优选待复核'}
            description="修改并保存后请返回清单点「复核通过」，或直接在清单上确认。"
          />
        ) : null}
        <Form form={form} layout="vertical">
          <Form.Item name="takeId" label="条次" rules={[{ required: true, message: '请选择条次' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              disabled={editing ? pickLocked(editing) : false}
              options={(editing
                ? takes.filter(
                    (take) =>
                      (take.grade === '可用' || take.id === editing.takeId) &&
                      !sessions.find((session) => session.id === take.sessionId && session.finalized)
                  )
                : candidates
              ).map((take) => ({
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
