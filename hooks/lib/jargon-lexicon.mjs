// audience: internal
// # jargon-lexicon
// 常见中文黑话词典与确定性扫描器:把历次审计沉淀下来的黑话(比喻,拟人,口语缩略,
// 颜色喻状态,生造压缩)列成 bad -> good 对照表,供 jargon-audit 钩子在调用模型前先做
// 一次零成本的字符串扫描 - 命中即刻给出精确改法,让审计更敏捷.模型只需再判词典外的
// 新黑话.
// 收词纪律:只收几乎在任何代码注释里都是黑话的词;确立的 CS/领域术语(见 KEEP)与
// 短到会误伤的虚词(别,跑,走,装,进)不入词典,留给模型按上下文判.
// good 串绝不包含对应 bad 串(如"算完"是"计算完毕"的子串,故不收),以免改对后仍误报.

// //// 黑话对照表:bad 命中即报,good 为建议改法 [@380kkm 2026-07-07] ////
export const LEXICON = [
  // 比喻:把抽象动作/关系说成形象词
  { bad: "回落", good: "减小" },
  { bad: "落位", good: "取到给定值" },
  { bad: "烧进", good: "存入" },
  { bad: "抽象缝", good: "抽象边界" },
  { bad: "拼串", good: "拼接字符串" },
  { bad: "接线", good: "组装连接" },
  { bad: "红线", good: "硬约束" },
  { bad: "打通", good: "贯通" },
  { bad: "闭环", good: "完整流程" },
  { bad: "金标准", good: "权威基准" },
  { bad: "驱动器", good: "执行程序" },
  { bad: "锁住", good: "约束住" },
  // 拟人:让代码/函数/文件有人的动作
  { bad: "互不相识", good: "互不依赖" },
  { bad: "只回答", good: "只给出" },
  { bad: "只认", good: "只支持" },
  { bad: "体会", good: "理解" },
  // 口语缩略(安全多字词)
  { bad: "放开到", good: "扩展到" },
  { bad: "无视", good: "忽略" },
  { bad: "肉眼", good: "人工核验" },
  { bad: "家族", good: "组" },
  { bad: "指令族", good: "指令类别" },
  { bad: "分支族", good: "分支组" },
  { bad: "玩具", good: "示例或简化" },
  { bad: "玩法", good: "用法" },
  { bad: "消掉", good: "消除" },
  { bad: "想快就别选", good: "追求速度时不建议" },
  { bad: "仓库体检", good: "仓库自查" },
  { bad: "并发立场", good: "并发原则" },
  { bad: "自证", good: "自行验证" },
  // 颜色喻状态
  { bad: "全绿", good: "全部通过" },
  { bad: "练绿", good: "练到全部通过" },
  { bad: "绿三角", good: "可运行标记" },
  // 生造压缩
  { bad: "产像素", good: "生成像素" },
  { bad: "验像素", good: "验证像素" },
  { bad: "显像素", good: "显示像素" },
  { bad: "opxam", good: "op 与 am 的分解" },
];
// //// /黑话对照表:bad 命中即报,good 为建议改法 ////

// //// 确立术语与字面词白名单:模型审词典外新黑话时排除这些 [@380kkm 2026-07-07] ////
export const KEEP = [
  "constexpr", "concept", "static_assert", "谓词", "内联", "平凡可拷贝", "差分对拍",
  "查表分发", "镜像", "寻址", "回卷", "opcode", "总线", "时钟域", "组合根", "IIFE",
  "NTTP", "DMA", "名称表", "扫描线", "门控", "静态库", "契约", "职责", "骨架", "线或",
  "假总线", "自检", "别名", "魔数", "脚手架", "胶水代码", "钩子", "黑屏", "花屏",
];
// //// /确立术语与字面词白名单 ////

// //// 扫描一份 diff 的新增内容,返回命中的黑话 [@380kkm 2026-07-07] ////
// 只看新增行:git diff 里以 + 开头(非 +++)的行,以及未跟踪新文件整段内容.
// 跳过词典与钩子自身文件,避免这些文件里列举的 bad 词把自己判成黑话.
export function scanJargon(diff) {
  if (!diff) return [];
  const lines = diff.split(/\r?\n/);
  const hits = new Map();                                  // term -> {good, sample}
  let curFile = "";
  let untracked = false;                                   // 是否在未跟踪新文件整段内
  const selfFile = (f) => /jargon-lexicon|jargon-audit/.test(f);

  for (const raw of lines) {
    // 跟踪 diff 的文件头
    const mUn = raw.match(/^=== 未跟踪新文件:\s*(.+?)\s*===/);
    if (mUn) { curFile = mUn[1]; untracked = true; continue; }
    const mPp = raw.match(/^\+\+\+ b\/(.+)$/);
    if (mPp) { curFile = mPp[1]; untracked = false; continue; }
    if (/^--- a\//.test(raw) || /^diff --git/.test(raw)) { untracked = false; continue; }

    if (selfFile(curFile)) continue;                       // 跳过词典/钩子自身

    // 取本行的"新增内容"文本
    let text = null;
    if (untracked) text = raw;
    else if (raw.startsWith("+") && !raw.startsWith("+++")) text = raw.slice(1);
    if (text == null) continue;

    for (const { bad, good } of LEXICON) {
      if (text.includes(bad) && !hits.has(bad)) {
        hits.set(bad, { good, sample: text.trim().slice(0, 80) });
      }
    }
  }
  return [...hits].map(([term, v]) => ({ term, good: v.good, sample: v.sample }));
}
// //// /扫描一份 diff 的新增内容,返回命中的黑话 ////
