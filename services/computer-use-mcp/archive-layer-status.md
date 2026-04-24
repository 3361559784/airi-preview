# Archive Layer Status

当前这条 memory 线的状态，不是“长期记忆已完成”，而是：

- transcript truth source 已落地
- transcript projection 已落地
- archived context write path 已经长出来
- 但 Archive Layer V1 **还没有收成干净 baseline**

这份文档只记录当前 archive layer 的真实状态，避免后续切去别的工作时把问题忘掉。

## 当前已确认事实

- `src/transcript/projector.ts` 已经开始返回 `archiveCandidates`
- `src/archived-context/*` 已经存在：
  - `store.ts`
  - `serializer.ts`
  - `types.ts`
  - `index.ts`
- `src/coding-runner/service.ts` 已经开始生成 `runId` 并在每轮 projection 后写 archive
- `src/archived-context/archived-context.test.ts` 与 `src/transcript/transcript.test.ts` 当前可跑通

这说明 archive layer 不是空设计，代码已经在仓库里了。

## 当前剩余问题

### 1. `transcript.test.ts` 新增 archive 测试不 typecheck

问题位置：

- `src/transcript/transcript.test.ts`

问题本质：

- 新增 `archiveCandidates` 测试块里的 `baseOpts.runState` 只是残缺对象
- `projectTranscript()` 现在要求完整 `RunState`
- `vitest` 会转译执行，所以测试能绿
- 但 `tsc --noEmit -p tsconfig.json` 会在这些调用点报错

这不是已有旧错，而是这波 archive 改动自己带进来的新问题。

### 2. `maxCompactedBlocks = 0` 时，projector 会把同一批 block 同时当成 compacted 和 dropped

问题位置：

- `src/transcript/projector.ts`

问题本质：

- 当前切分逻辑用了 `slice(-maxCompactedBlocks)`
- 在 JavaScript 里，`slice(-0)` 等于 `slice(0)`
- 所以当 `maxCompactedBlocks = 0` 时：
  - `compactedSourceBlocks` 会拿到整批 `blocksToCompact`
  - `droppedSourceBlocks` 也会拿到整批 `blocksToCompact`

结果：

- 同一批 block 会生成两份 `archiveCandidates`
- `reason` 分别是 `compacted` 和 `dropped`
- archive 语义直接打架

这不是测试问题，是实际逻辑 bug。

## 为什么现在不该继续做 retrieval

原因很简单：

- archive write path 还没收成 typecheck-clean
- projector 的 zero-value 分支还有逻辑 bug

这时候继续往 retrieval 走，只会把一个没收口的 baseline 继续往上叠，后面更难拆。

## 当前最值得做的事

先把 Archive Layer V1 收成干净 baseline，只做这两件事：

1. 修 `src/transcript/transcript.test.ts` 的 `RunState` 类型问题
2. 修 `src/transcript/projector.ts` 在 `maxCompactedBlocks = 0` 时的切分逻辑

在这两个问题修完之前，不要继续做：

- retrieval
- workspace memory promotion
- GUI

## 当前结论

这条线现在准确的判断应该是：

- **档案层代码已落地**
- **但 Archive Layer V1 还没收完**

不要把它说成“长期记忆层已成”，也不要把它当成可以继续往 retrieval 开工的稳定基线。
