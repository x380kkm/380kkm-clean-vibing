// audience: internal
// # scout-first-read
// 侦察先行的读码 workflow 模板：先派只读侦察子 agent 探索定位、把查询沉淀进 trace，
// 再对每个子任务派正常全工具子 agent——开工先 trace preflight 复用前人的定位查询、跳过
// 重新摸索；复用到或定位到之后自由选 grep 与 Read 探索。侦察子遇发散目标追不动时标记
// 未探明，落在未探明区的子任务转为自由探索。强调的是复用而非有界。
//
// 运行前提：主 agent 在调用前已按 CLAUDE.md「做事前增量更新索引」刷新过正式索引。
// 入参 args：{ goal: string（侦察目标，必填）, root: string（项目根，默认 '.'）,
//             subtasks: string[]（可选，要分派的子任务；缺省则只做侦察产锚点） }。
export const meta = {
  name: 'scout-first-read',
  description: '侦察先行：只读子 agent 探索定位并沉淀 trace，下游 agent 先复用再自由探索',
  phases: [
    { title: 'Scout', detail: '只读 cleanread/cleanscan 探索，沉淀 trace，产锚点（可标未探明）' },
    { title: 'Fan', detail: '每个子任务先 trace preflight 复用，再自由探索' },
  ],
}

const goal = (args && args.goal) || '（未指定目标）'
const root = (args && args.root) || '.'
const subtasks = (args && Array.isArray(args.subtasks)) ? args.subtasks : []

//// 侦察阶段产出的锚点地图结构 ////
const MAP_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['index_ok', 'coverage', 'anchors', 'unexplored'],
  properties: {
    index_ok: { type: 'boolean', description: '正式索引可用且看起来不过时' },
    coverage: { type: 'string', enum: ['complete', 'partial'], description: '探索是否覆盖完整；发散追不动时为 partial' },
    anchors: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['symbol', 'anchor', 'role'],
        properties: {
          symbol: { type: 'string' },
          anchor: { type: 'string', description: 'path:line 锚点' },
          role: { type: 'string', description: '该符号一句话的作用' },
        },
      },
    },
    unexplored: { type: 'array', items: { type: 'string' }, description: '追不动、未探明的区域，交给自由探索' },
  },
}

//// 子任务作答结构 ////
const ANSWER_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['subtask', 'answer'],
  properties: {
    subtask: { type: 'string' },
    answer: { type: 'string' },
    anchors: { type: 'array', items: { type: 'string' } },
  },
}

phase('Scout')
const map = await agent(
  `侦察目标：${goal}\n项目根：${root}\n` +
  `用 cleanread 与 cleanscan 在 ${root}/cleanread 的正式索引上探索定位，查询不加 --no-log（沉淀进 trace 供下游复用），` +
  `产出带 path:line 锚点的清单。遇依赖追踪这类发散目标追不动时，交回已得锚点、把未探明区域列进 unexplored、coverage 标 partial。`,
  { agentType: 'cleantools-scout', label: 'scout', phase: 'Scout', schema: MAP_SCHEMA, model: 'sonnet' }
)

const anchors = (map && map.anchors) || []
const unexplored = (map && map.unexplored) || []
if (map && map.index_ok === false) {
  log('侦察报告正式索引缺失或过时：请先跑 index_build 加 enrich_treesitter 再重试。')
}
log(`侦察得到 ${anchors.length} 个锚点，coverage=${map ? map.coverage : '?'}，未探明 ${unexplored.length} 处。`)

if (!subtasks.length) {
  // 只做侦察：返回锚点地图供主 agent 自行分派
  return { goal, index_ok: map ? map.index_ok : null, coverage: map ? map.coverage : null, anchors, unexplored }
}

//// 锚点地图与未探明清单，喂给每个子任务的提示 ////
const mapText = anchors.map(a => `${a.symbol} @ ${a.anchor} — ${a.role}`).join('\n') || '（无）'
const unexploredText = unexplored.join('；') || '（无）'
const DISCIPLINE =
  '开工先用 `trace preflight <关键词>` 复用前人探到的定位查询，命中就跳过重新摸索。' +
  '强调复用而非有界：复用到、或用 cleanscan/cleanread 定位到之后，可自由选 grep 与 Read 精读探索。' +
  '若你的子任务落在「未探明」区域，直接自由用 grep 与 Read 探索，不必受限于有界检索。'

phase('Fan')
const results = await parallel(subtasks.map((st, i) => () =>
  agent(
    `子任务：${st}\n目标语境：${goal}\n项目根：${root}\n` +
    `--- 侦察锚点（可直接据此有界提取） ---\n${mapText}\n` +
    `--- 未探明区域（落在这里就自由探索） ---\n${unexploredText}\n` +
    `${DISCIPLINE}`,
    { label: `fan:${i + 1}`, agentType: 'general-purpose', phase: 'Fan', schema: ANSWER_SCHEMA, model: 'sonnet' }
  )
))

return {
  goal, index_ok: map ? map.index_ok : null, coverage: map ? map.coverage : null,
  anchors: anchors.length, unexplored, results: results.filter(Boolean),
}
