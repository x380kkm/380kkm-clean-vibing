// audience: internal
// # scout-first-read
// 侦察先行的读码 workflow 模板：先派只读侦察子 agent 产出 path:line 锚点地图，
// 再对每个锚点派带有界检索纪律的子 agent 做有界提取与分析。压制子 agent 用 Read
// 整文件灌爆上下文——后续 agent 拿现成锚点直接按字节跨度取片段，不必自己摸索。
//
// 运行前提：主 agent 在调用前已按 CLAUDE.md「做事前增量更新索引」刷新过正式索引。
// 入参 args：{ goal: string（侦察目标，必填）, root: string（项目根，默认 '.'） }。
export const meta = {
  name: 'scout-first-read',
  description: '侦察先行：只读子 agent 先产出 path:line 锚点地图，再 fan out 有界提取',
  phases: [
    { title: 'Scout', detail: '只读 cleanread/cleanscan 侦察，产出锚点地图' },
    { title: 'Extract', detail: '按锚点 fan out 有界提取，每个子 agent 带纪律提示' },
  ],
}

const goal = (args && args.goal) || '（未指定目标）'
const root = (args && args.root) || '.'

//// 侦察阶段产出的锚点地图结构 ////
const MAP_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['index_ok', 'anchors'],
  properties: {
    index_ok: { type: 'boolean', description: '正式索引可用且看起来不过时' },
    anchors: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['symbol', 'anchor', 'role'],
        properties: {
          symbol: { type: 'string' },
          anchor: { type: 'string', description: 'path:line 锚点' },
          role: { type: 'string', description: '该符号一句话的作用' },
          depends_on: { type: 'array', items: { type: 'string' } },
          used_by: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

//// 提取阶段每个子 agent 的产出结构 ////
const EXTRACT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['symbol', 'anchor', 'finding'],
  properties: {
    symbol: { type: 'string' },
    anchor: { type: 'string' },
    finding: { type: 'string', description: '基于有界提取片段的分析结论' },
  },
}

//// 有界检索纪律：每个子 agent 提示都带这段 ////
const DISCIPLINE =
  '纪律：先用 cleanscan 定位到 path:line，再用 cleanread 的 slice_bytes 按字节跨度有界提取对应片段；' +
  '不要 Read 整个文件，也不要用 ls 或 grep 扫仓库。'

phase('Scout')
const map = await agent(
  `侦察目标：${goal}\n项目根：${root}\n` +
  `用 cleanread 与 cleanscan 在 ${root}/cleanread 的正式索引上定位，产出带 path:line 锚点的清单。`,
  { agentType: 'cleantools-scout', label: 'scout', phase: 'Scout', schema: MAP_SCHEMA }
)

const anchors = (map && map.anchors) || []
if (map && map.index_ok === false) {
  log('侦察报告正式索引缺失或过时：请先跑 index_build 加 enrich_treesitter 再重试。')
}
if (!anchors.length) {
  log('侦察未产出锚点，结束。')
  return { goal, index_ok: map ? map.index_ok : null, anchors: 0, results: [] }
}
log(`侦察得到 ${anchors.length} 个锚点，开始有界提取。`)

phase('Extract')
const results = await parallel(anchors.map(a => () =>
  agent(
    `有界提取并分析符号 ${a.symbol}（锚点 ${a.anchor}，作用：${a.role}）。\n` +
    `结合侦察阶段给出的依赖关系判断它在目标「${goal}」中的角色。\n${DISCIPLINE}`,
    { label: `extract:${a.symbol}`, phase: 'Extract', schema: EXTRACT_SCHEMA }
  )
))

return { goal, index_ok: map ? map.index_ok : null, anchors: anchors.length, results: results.filter(Boolean) }
