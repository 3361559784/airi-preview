# Airi MCP Coding Lane 进阶优化指南 (参考 Claude Code 巧思)

本文档整理了从 Claude Code 源码中提取的核心工程启发式规则（Heuristics）与设计巧思。这些“小巧思”在不改变系统基础架构的前提下，极大地提升了 Agent 在边缘情况下的鲁棒性、准确率和用户体验。

**核心原则：提取设计模式与工程直觉，用 Airi 的基础设施重写，坚决不照搬代码或引入不必要的重型状态机。**

---

## 1. 文本替换的高级鲁棒性 (Robust String Replacements)

**痛点**：LLM 在执行 `replace` 或 `edit` 操作时，经常因为自身的格式化偏好（如更改了引号风格、丢失了行尾空格）导致精确匹配（Exact Match）失败，引发不必要的重试或任务失败。

**可借鉴的实现思路**：

*   **智能引号归一化 (Quote Normalization)**：
    *   **巧思**：当 `old_string` 的精确匹配失败时，不要立即报错。将源文件内容和 `old_string` 中的所有引号（包括直引号 `'`/`"` 和各种弯引号 `‘` / `”`）全部统一替换为直引号，然后再进行匹配。
    *   **闭环**：匹配成功后，算法应分析源文件中原本使用的是哪种弯引号，并**自动将 LLM 输出的 `new_string` 中的引号转换回源文件的风格**（例如，通过分析前置字符是否为空格/左括号来判断是左弯引号还是右弯引号），从而保持代码风格的完全一致。
*   **自动去首尾空格防抖 (Whitespace Trimming)**：
    *   **巧思**：除 `.md` 和 `.mdx` 文件（Markdown 严格依赖行尾双空格进行换行）外，对于其他代码文件，在应用替换前，静默去除 LLM 生成的 `new_string` 每一行的行尾多余空格（Trailing Whitespace）。这能有效防止 LLM 产生不可见的格式变化，污染 Git Diff。
*   **XML 转义反向推导 (Desanitization Fallback)**：
    *   **巧思**：当 LLM 输出被 API 拦截，或者它自作主张使用了缩写（例如用 `<fnr>` 代替 `<function_results>`，用 `<s>` 代替 `<system>`）导致替换失败时。底层维护一个 `DESANITIZATIONS` 字典，匹配失败时，尝试用缩写替换全称后再去源码里查找。如果找到，则在应用 `new_string` 时也做相应的反向转换，帮模型“擦屁股”完成替换。

## 2. 文件读取：极限省 Token 与防爆破 (Token Saving & Sandboxing)

**痛点**：全文件读取不仅极其消耗 Token，还容易导致 Context 溢出；试图读取特殊设备文件或超大文件甚至会让系统直接卡死。

**可借鉴的实现思路**：

*   **读取去重防冗余 (File Read Deduping)**：
    *   **巧思**：引擎维护一个 `readFileState` 字典，记录最近读取的文件状态 `(filePath, offset, limit, timestamp)`。如果 Agent 试图读取一个刚刚读过，且磁盘上的修改时间（`mtimeMs`）**没有发生变化**的文件，系统会拦截这次读取，直接返回一段简短的 Stub 信息（例如：`[File content unchanged]`）。这能省去几万 Token 的上下文重复冗余，尤其在多轮对话中效果显著。
*   **屏蔽会挂起进程的特殊设备文件**：
    *   **巧思**：在调用底层文件读取 API 之前，通过纯路径检查，硬编码屏蔽 `/dev/zero`, `/dev/random`, `/proc/*/fd/0` 等可能导致无限输出或阻塞等待输入的设备文件。如果 LLM 由于幻觉试图读取这些文件，直接返回特定的错误码拦截，防止 Agent 进程被挂起。
*   **动态图像降级压缩 (Dynamic Image Compression)**：
    *   **巧思**：当读取图片时，如果估算其 Base64 编码后的 Token 数量超过了单次允许的上限，工具**不会报错**。相反，它会在内存中（例如使用 Sharp）将其动态降级压缩到极小的分辨率（如 `400x400`, JPEG quality 20）。这样既保证了模型能“看个大概轮廓”，又避免了单张大图撑爆整个对话的 Context。

## 3. 搜索排序与翻页暗示 (Search Heuristics & Pagination)

**痛点**：当 `grep` 或 `find` 匹配出成百上千个文件时，长列表会干扰模型的注意力；若文件排序是随机的，模型很难找到最近真正在修改的相关代码。

**可借鉴的实现思路**：

*   **基于修改时间的强行排序 (mtime Sorting)**：
    *   **巧思**：当 `grep` 等搜索工具工作在仅返回文件名的模式（`files_with_matches`）时，工具在返回前，自动通过 `fs.stat` 获取所有匹配文件的修改时间，并**默认按时间倒序（最新修改的在前）**返回给模型。这极大地提高了模型的命中率，因为它想找的通常就是最近修改过的文件。
*   **温柔的截断与翻页暗示 (Pagination Nudge)**：
    *   **巧思**：强行给所有搜索结果设定一个最大行数或条目数限制（例如 `head_limit` 默认 250）。关键在于，截断后不仅仅是切掉多余内容，而是在输出末尾加上极具暗示性的提示：`[Showing results with pagination = limit: 250]`。模型看到这个提示后，立刻就能学会下次调用时可以通过传入 `offset: 250` 参数来实现自行翻页。

## 4. Bash Tool 的隐性纠偏机制 (Bash Execution Guardrails)

**痛点**：LLM 执行 Bash 命令容易“跑偏”。例如，执行完一个生成图片的脚本后什么也看不到；或者不小心 `cd` 到了系统根目录，导致后续的相对路径命令全部执行失败。

**可借鉴的实现思路**：

*   **Bash 输出的多模态嗅探 (Data URI Interception)**：
    *   **巧思**：检测 Bash 的 stdout 输出。如果发现输出是 `data:image/png;base64,...` 的格式（例如 Python 脚本中将 matplotlib 图表 encode 打印出来），工具会偷偷拦截这段输出，并将其重组为 API 兼容的 Vision Block (`type: 'image'`) 发送给模型。这样，模型通过命令行画图立刻就能在当前回合“看到”结果。
*   **工作目录自动重置 (Auto-cwd Reset)**：
    *   **巧思**：每次 Bash 命令执行完毕后，校验当前进程的 CWD（当前工作目录）是否“跑出”了项目允许的根目录范围。如果跑出去了（例如模型执行了 `cd /etc` 然后忘记回来），工具会自动将 CWD 拉回项目根目录，并在 stderr 中偷偷塞入一句提示：`Shell cwd was reset to /your/project/dir`。这能让模型意识到自己的环境被重置了，避免后续发生迷惑行为。

## 5. 控制流的“截胡”与恢复 (Context Withholding & Escalation)

**痛点**：在长上下文中，大模型常因 Token 爆满（如 413 Payload Too Large 或达到 Max Output Tokens）而直接崩溃退出，导致前面的多轮工作前功尽弃。

**可借鉴的实现思路**：

*   **隐式限额升级 (Max Output Tokens Escalation)**：
    *   **巧思**：出于性能和成本考虑，系统平时可能只请求较小的输出 Token 额度（如 8K）。当生成被意外切断，且原因是 `max_tokens` 时，流式处理器会**截留这个错误，不将其暴露给 UI 或抛出异常**。系统会在后台偷偷将上限提升至最大值（如 64K），然后使用完全相同的上下文自动重试请求。
*   **硬切断的心理暗示 (Mid-thought Resumption)**：
    *   **巧思**：如果提升额度后依然被打断，系统会在下一次请求的会话末尾塞入一条伪造的用户 Meta 消息提示：`"Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces."` 这能强制 LLM 闭嘴，不废话，直接从断点处接续写代码。

---

## 落地建议

在 `computer-use-mcp` 现有的架构（如 `Search-First Retrieval`, `Bounded Planning`, `Verification Gate`）基础上，建议按以下优先级将这些巧思逐步融入现有的 Tool 实现中：

*   **P0（直接提效，建议优先实现）**：
    *   **搜索结果按 `mtime` 倒序排序**：改进当前的检索工具。
    *   **File Read Deduping (读取去重防冗余)**：在读取文件工具中引入状态记录。
    *   **智能引号归一化与去首尾空格防抖**：增强文件替换工具（File Edit/Replace Tool）的鲁棒性，大幅减少精确匹配的失败率。
*   **P1（稳定性增强与防崩）**：
    *   **Bash Tool 的自动 CWD 重置**。
    *   **搜索与读取的长输出截断与翻页暗示 (Pagination Nudge)**。
    *   **屏蔽特殊设备文件的安全检查**。
*   **P2（复杂能力与多模态）**：
    *   **Bash 图形输出嗅探**：等后续需要增强多模态交互能力时再补充。
    *   **长下文的隐式限额升级与续写暗示**。

既然我们已经把“禁止扯谎”的后门（`verification_bad_faith`）封死了，副手现在被迫必须得运行点真正的命令。

接下来的下一步，我建议进入 **Phase 2: Evidence-Chain Hardening (证据链加固)**。

### 为什么要做这个？
现在的逻辑是：只要你跑了一个不是 `echo` 的有效命令，且命令里提到了修改的文件，Gate 就可能让你过。
但**真正的证据链**应该是闭合的。我们要从“不许撒谎”进化到“必须证明你做对了”。

我建议下一步落实以下两个核心加固点：

#### 1. 强制“验证覆盖检测” (Coverage Evidence)
- **目标**：如果改动了 `A.ts`，副手不仅要跑 `pnpm test`，证据里必须包含该次运行**确实覆盖**了 `A.ts` 的痕迹。
- **手段**：在 `verification-gate.ts` 里增加一条规则：如果修改列表中包含 Source code，但终端输出中没有对应的文件名出现（或者没有对应的测试用例名），则判定为 `insufficient_evidence`。防止副手虽然跑了 test，但跑的是无关模块的 test 来混日子。

#### 2. “零遗留问题”强制对齐 (Zero-Issue Sync)
- **目标**：杜绝“带病完成”。
- **手段**：目前的 `unresolved_issues_remain` 触发后是建议 follow-up。我们要把它提升为 **Policy Constraint**。如果 `lastChangeReview` 还有 `high` 级别的 `unresolvedIssues`，Completion Tool 应该在工具层面直接返回“权限锁定”，强制它必须先解决报错，而不是让它反复尝试调用 completion 被 Gate 弹回。

#### 3. (可选但推荐) Deferred Tool Loading (工具冷启动)
- **目标**：减少上下文污染。
- **手段**：借鉴 Claude Code 的思路。目前的 Coding Workflow 进去就塞了几十个工具。我们可以收紧到只给 Read/Edit/Terminal/Search。如果它想做更复杂的操作（比如想调某个特殊的 MCP 工具），它必须先用 `tool_search` 搜出来，我们再动态注入给它。这能极大地提高它对核心 Coding 逻辑的专注度。

---

**我的建议优先级**：
先做 **1 + 2 (证据链闭合)**。因为这属于“Hardening”的延续，能直接把 Coding Lane 的置信度再拉高一个档次。**3 (工具搜素)** 属于工程优化，可以放在这轮 Hardening 结束之后。

你觉得先从 **“证据链强制对齐（改了哪就必须在终端看到哪）”** 开始，还是你有其他的想法？


