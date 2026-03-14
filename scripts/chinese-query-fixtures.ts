export type ChineseBenchmarkCase = {
  id: string;
  fact: string;
  query: string;
  expected: string;
};

export const CHINESE_BENCHMARK_CASES: ChineseBenchmarkCase[] = [
  { id: "zh01", fact: "用户更喜欢茉莉花茶而不是咖啡。", query: "用户偏好喝什么饮料？", expected: "茉莉花茶" },
  { id: "zh02", fact: "用户主要使用 Neovim 作为编辑器。", query: "用户主要用什么编辑器？", expected: "neovim" },
  { id: "zh03", fact: "用户的常用时区是 UTC+8。", query: "用户使用什么时区？", expected: "utc+8" },
  { id: "zh04", fact: "用户每个工作日早上 7 点到 9 点做深度工作。", query: "用户的深度工作时间是什么时候？", expected: "7 点到 9 点" },
  { id: "zh05", fact: "用户每周五晚上打羽毛球。", query: "用户什么时候打羽毛球？", expected: "周五晚上" },
  { id: "zh06", fact: "用户 10 点前不接电话。", query: "用户几点前不接电话？", expected: "10 点" },
  { id: "zh07", fact: "用户用 Python 写数据流水线。", query: "用户用什么语言写数据流水线？", expected: "python" },
  { id: "zh08", fact: "用户主要使用 PostgreSQL 作为数据库。", query: "用户主要用什么数据库？", expected: "postgresql" },
  { id: "zh09", fact: "用户偏好使用 pnpm 作为 JavaScript 包管理工具。", query: "用户更喜欢用什么包管理工具？", expected: "pnpm" },
  { id: "zh10", fact: "用户在大重构之前会先写单元测试。", query: "用户在大重构前会先做什么？", expected: "单元测试" },
  { id: "zh11", fact: "用户的伴侣住在西安。", query: "用户的伴侣住在哪里？", expected: "西安" },
  { id: "zh12", fact: "用户在新加坡办公室办公。", query: "用户在哪个办公室办公？", expected: "新加坡办公室" },
  { id: "zh13", fact: "用户每个月的阅读目标是四本书。", query: "用户每月的阅读目标是什么？", expected: "四本书" },
  { id: "zh14", fact: "用户每周日晚上做备餐。", query: "用户什么时候备餐？", expected: "周日晚上" },
  { id: "zh15", fact: "用户不喜欢香菜。", query: "用户不喜欢什么香草？", expected: "香菜" },
  { id: "zh16", fact: "用户的主力笔记应用是 Obsidian。", query: "用户主要用什么笔记应用？", expected: "obsidian" },
  { id: "zh17", fact: "用户的任务追踪工具是 Linear。", query: "用户用什么任务追踪工具？", expected: "linear" },
  { id: "zh18", fact: "用户用飞书日历管理会议。", query: "用户用什么日历工具管理会议？", expected: "飞书日历" },
  { id: "zh19", fact: "用户偏好在日志里使用 UTC 时间戳。", query: "用户偏好在日志里使用什么时间格式？", expected: "utc 时间戳" },
  { id: "zh20", fact: "用户偏好使用 Mermaid 来画图。", query: "用户偏好用什么图表格式？", expected: "mermaid" },
];
