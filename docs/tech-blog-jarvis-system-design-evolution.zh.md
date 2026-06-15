# Jarvis 的系统设计演化：把 AI 放进关键时刻的 Runtime

Jarvis 一开始看起来像一个会议辅助软件。原始需求集中在三个能力上：屏幕共享时不要被看到，能听到会议里的系统声音，能读懂对方共享的屏幕，并实时给出回答建议。

如果只按这个功能列表做，很容易得到一个截图加语音转文字加大模型总结的工具。它可以演示，但在真实会议里会很脆弱。会议和面试真正困难的地方不在于“有没有一个答案”，而在于用户需要在很短时间里判断对方到底问了什么，当前问题属于什么任务，哪些上下文可信，哪些上下文会误导，以及自己下一句话应该怎么自然地说出来。

这也是 Jarvis 后来逐渐成型的产品定义：它不是一个泛会议记录工具，而是一个 private critical-moment assistant。它服务的是高压力技术对话里的关键时刻。用户需要在那个时刻理解问题、选择正确方向、组织可说出口的回答，并且尽量不暴露等待、卡顿、跟读和上下文混乱。

这篇文章总结 Jarvis 从早期原型到接近可用产品的系统设计过程。重点不放在具体按钮或某次 prompt 调整上，而放在更可复用的工程判断：哪些部分应该交给 AI，哪些必须交给架构、schema 和 runtime；为了 north star 做了哪些取舍；以及我们如何用 evaluation infrastructure 把主观体感变成可复盘的工程数据。

## 从能力列表到关键时刻

早期需求可以被翻译成三种底层能力：

- 获取会议声音。
- 获取当前屏幕。
- 给出实时建议。

这些能力本身不足以定义产品。真正的问题是：什么时候 Jarvis 应该介入，介入时应该给什么，以及它错了以后用户怎么恢复。

在前几轮设计里，我们先保留了 Tauri + Rust + React 的技术路线，而不是直接重写。这个决定很重要。Rust 负责系统层能力，例如系统音频、VAD、窗口和屏幕捕获、快捷键、窗口可见性控制。React/TypeScript 负责 provider 配置、prompt orchestration、meeting state、UI 和 debug surfaces。这样做把平台能力和产品逻辑分开，也避免了在产品问题还没收敛时就进入 Swift/AppKit 重写。

第一版 MVP 的架构可以粗略看成这样：

```text
Rust native capture
  -> audio segments / screen capture / window control
  -> TypeScript meeting runtime
  -> STT / vision-capable LLM / advisor LLM
  -> overlay UI
```

这个模型能跑通核心链路，但它也暴露了一个问题：把音频、截图和历史对话都塞进 prompt，让模型自己决定一切，会在真实场景中快速失控。模型擅长理解模糊语义和生成自然语言，但它不适合承担所有运行时责任。任务身份、状态边界、事实来源、缓存生命周期、评估记录，这些都必须由代码和 schema 管。

这成为 Jarvis 后续设计的主线。

## Screen 是任务锚点，audio 是补充约束

第一个重要转向发生在 screen workflow 上。最初的截图功能更像“解释这张图”。这对会议帮助有限，因为真实场景里屏幕上可能有多个问题、IDE、网页、题库、干扰项和语言选择。用户需要的不是泛泛解释，而是回答当前正在处理的那一道题。

于是 screen contract 被改成了 screen-anchored technical answer：截图是 primary source of truth，模型必须优先回答屏幕上可见的主问题。语音只作为 clarification、constraint 或 follow-up，不允许覆盖可见屏幕事实。

这背后有一个 source-of-truth 设计：

```text
visible screen question
  > latest interviewer clarification
  > explicit user correction
  > interview brief
  > curated memory
  > old transcript
  > model-generated text
```

这里的关键不是让 AI 更聪明，而是让 AI 少猜。代码负责捕获 active window、记录 cursor metadata、生成 focus band、优化 image payload、记录 capture target；prompt 负责让 vision model 在这些证据中选择主问题并给出结构化答案。

后续多个优化都沿着这条线展开：

- active-window capture 替代整屏猜测。
- cursor-centered horizontal focus band 帮助模型锁定用户鼠标附近的问题。
- 全局图和 focus 图一起发送，兼顾定位和上下文。
- PNG 改为压缩后的 JPEG，降低 payload 和 latency。
- screen model output 改为结构化 section，便于 UI 把 `Answer`、`Approach`、`Code`、`Complexity` 分开渲染。
- coding artifact cache 保留代码和复杂度，避免后续非 coding follow-up 把代码区清掉。

这里有一个可复用经验：多模态 AI 产品不要让模型自己在所有输入中“民主投票”。每种输入源都要有身份。屏幕、对方语音、用户语音、brief、memory、旧 transcript 的优先级必须可解释。

## 语音链路先保证顺序和边界，再追求实时

音频链路也经历了类似取舍。理论上，最理想的 meeting assistant 应该使用 streaming STT 和 partial transcript。现实中，Jarvis 第一阶段选择了 VAD 分段后的 request/response STT。

这个选择牺牲了一点实时性，但保留了更清晰的控制点。系统可以在 `speech-detected` 后生成一个完整音频段，转写为 final transcript，再决定是否触发 advisor。这对于早期可靠性更重要，因为用户真正不能接受的是旧 session 的 STT 结果污染新 session，或者并发音频段乱序进入 transcript。

后来的 code review 指出了这个风险：STT 请求如果没有串行化，stop/start 之间旧结果晚回来，就可能污染新会话。修复方向不是换模型，而是 runtime guard：audio segment FIFO queue、sequence id、session id guard、stale-result drop。

这体现了 Jarvis 的第二条工程原则：实时 AI 系统里，时序和所有权由代码管理。LLM 可以理解一句话的意思，但不应该负责判断这句话属于哪个 session、哪个 segment、哪个 parent task。

随后 microphone-side context fusion 进入设计。真实面试里用户会临时向面试官确认：“你说的是 RAG，不是 rec，对吗？”面试官可能只回答一句 “right”。如果 Jarvis 只听对方声音，就会丢失前半句；如果把用户说的所有内容都显示在 transcript 里，又会干扰用户看对方问题。

最后的设计是：

- normal 和 Focus UI 只显示 `them` transcript。
- `me` transcript 只进入 Debug/trace surfaces。
- `me` 只有在满足可量化条件时进入 advisor context，例如短澄清、紧邻对方确认、有相似上下文、长度和时间窗符合规则。
- raw `me` 可以记录在本地调试数据里，但不会变成事实锚点。

这里的 AI 角色是理解“RAG not rec”这类语义修正；代码角色是判断它能不能进入上下文，以及进入后属于 correction、clarification 还是 attempted answer。

## 从回答问题到推进任务

Jarvis 的产品跃迁发生在 interview-like 场景收窄之后。泛会议太宽，输入太游离，评估也困难。我们把主验证场景收窄成 one-on-one remote interview 或 interview-like technical discussion。这个约束带来了重要简化：

- 对方大概率是提问者。
- 用户大概率是回答者。
- 一个 task block 大概持续 15 到 30 分钟。
- 对话围绕一个问题持续补充，而不是像闲聊一样频繁漂移。

这个收窄让 Jarvis 可以从 answer generation 升级为 trajectory support。

Coding 题需要问题理解、算法选择、代码、复杂度和 follow-up 修改。General system design 需要澄清需求、估算 QPS、API/data model、架构、瓶颈和 tradeoff。AI/ML system design 需要目标、数据、模型、serving、metrics、evaluation loop 和 observability。Project deep dive 需要守住事实锚点，解释设计、取舍、影响和复盘。Behavioral 题需要选择真实故事，并按公司风格调整表达。

这些流程不应该完全交给 LLM 即兴发挥。于是 Jarvis 引入 Interview Playbook。

Playbook 不是知识库。KMB 解决 “Jarvis knows what”；Playbook 解决 “Jarvis should do what next”。它决定当前问题应该先回答、先问澄清、先估 scale、先选故事、先解释概念，还是先保留上下文等待 follow-up。

后来的 mock interview 又暴露了另一类问题：有些任务不应该每次现场推理。Self-intro 和 project-intro 属于高频固定入口，它们需要根据公司、面试官和 interview brief 微调，但主体最好来自预先准备好的模板和真实 profile。Project deep dive 也不只是一个 answer type，而是一个可以持续 20 分钟的 parent task；中间可以穿插 field knowledge、behavioral、coding 或 tradeoff child probe，之后还要能回到原来的项目主线。

runtime 层级因此变成：

```text
Perception
  -> Classification
  -> Task Continuity
  -> Playbook
  -> Memory Policy
  -> Prompt / Model Route
  -> Response
  -> Evaluation
```

这条链路里，AI 仍然参与 classification、语义理解和最终表达，但关键决策不能只藏在 prompt 里。question type、task relation、subtask intent、playbook phase、memory family、model route 都需要 schema 化，否则后续无法 debug，也无法评价。

## Task ontology：从 activeScreenTask 到 ActiveMeetingTask

早期 screen workflow 使用 `activeScreenTask`。这在第一阶段合理，因为 screen task 是最稳定的任务锚点。但随着 voice-only、mixed task、parent-child task、Focus Mode、session recording 和 human evaluation 出现，`activeScreenTask` 开始表达不够。

举一个真实边界场景：

```text
Parent task: AI/ML system design, design a self-improving agent
Child probe: field knowledge, what is RAG?
Child probe: coding, write a loss function
Resume parent: what metrics would prove the agent improved?
```

如果把 “what is RAG” 直接当成新的 top-level task，Jarvis 会丢掉原来的 AI/ML design trajectory。它可能重新问需求，也可能把 metrics follow-up 当成 field-knowledge。反过来，如果强行把所有 follow-up 都塞回 parent，又会让 coding child probe 污染 design prompt。

解决方法不是继续扩展 `ScreenTaskKind`，而是把概念分层：

- `questionType`: 稳定任务家族，例如 `coding`、`general-system-design`、`ai-ml-system-design`、`project-deep-dive`、`behavioral`、`field-knowledge`。
- `taskRelation`: 最新输入和当前任务的关系，例如 `new-parent`、`followup-parent`、`child-probe`、`resume-parent`、`correction`。
- `subtaskIntent`: 子问题意图，例如 `metric-probe`、`concept-probe`、`implementation-probe`。
- `playbookPhase`: 当前任务流程阶段，例如 requirement clarification、evaluation metrics、tradeoff。

这就是 `ActiveMeetingTask` adapter 的来源。第一步不是一次性重写状态，而是在现有 `activeScreenTask + activeInterviewTask` bridge 上加一个统一视图，让 prompt、session recording、Focus Mode、cache、model route 和 human evaluation 先读取同一个 parent task identity。

后续迁移继续沿着这个方向推进：screen、voice、correction、manual type override 和 manual next 都逐步通过同一套 task identity 合流。这个 adapter-first migration 是一个重要取舍。直接删除旧 state 会制造大量回归；继续让各模块各读各的 state，会让系统行为不可解释。先统一消费边界，再迁移写入路径，最后才考虑删除 legacy state。

## Memory 不是相似度排序问题

Jarvis 进入 interview 阶段后，Knowledge / Memory Base 变得很有价值。用户可以提前放入个人经历、项目总结、question bank、company interview guide、AI/ML system design 材料。模型回答 behavioral 或 project deep dive 时，有真实素材可以用，质量明显提升。

但 memory 也带来最大的风险之一：错误注入比不注入更糟。

最早的 KMB 设计没有急着上 embedding。第一版选择 curated Markdown + local SQLite runtime index + deterministic retrieval。原因很务实：当 memory 内容含有个人经历、项目事实、公司面试风格和 behavioral story 时，最重要的问题不是“语义召回够不够广”，而是“这条 memory 是否允许在当前问题里出现”。

所以 Jarvis 把 memory retrieval 拆成两步：

1. 先做 policy gate：question type、interview type、company、playbook allowed families、blocked families、required tags。
2. 再做 ranking：关键词、标签、priority、use case、project anchor、topic domain。

例如 Amazon Leadership Principle rubric 只应该进入 Amazon behavioral question。它不应该污染 AI/ML system design 或 project deep dive。behavioral story 可以支撑 behavioral answer，但 system design question 不应该被公司文化 guide 带偏。project docs 可以作为事实证据，但 raw source 不一定适合直接注入 prompt。

这套设计后来继续发展成 FactAnchorDecision：

- `strong-anchor`: 有具体 memory/story/project 支撑，可以回答。
- `weak-anchor`: 有相关事实，但不能支持所有细节，回答要降低承诺强度。
- `no-anchor`: 没有事实锚点，应该问澄清或提供 supported choices。
- `not-required`: coding、field knowledge、一般 system design 等场景不需要个人事实锚点。

这条规则来自一次 mock interview failure：模型虚构了一个项目经历，用户跟着说了出来，之后 behavioral answer 又把这个虚构经历当作事实复用。这个失败说明，生成内容一旦进入 transcript，就可能污染后续任务。

Jarvis 的最终原则是：模型生成过的内容不是事实来源。可用事实只来自用户明确提供或确认的内容、curated KMB、屏幕可见事实、confirmed transcript context 和 explicit manual correction。

随着 system design 和 AI/ML design 进入验证，KMB 又增加了另一种用法：diagram memory。这里的 memory 不再只是给模型一段文字，而是提供可复用的架构图、组件关系和 whiteboard overlay。它依旧要经过 policy gate：只有题型、domain 和当前 playbook phase 合适时，才会进入 Whiteboard 生成。这样一来，memory 从“可召回的文本”扩展成“可被 runtime 控制的 artifact substrate”。

## UI 的取舍：降低会议中的操作成本

Jarvis 的 UI 演化也围绕 north star 做取舍。早期面板承载了很多配置、debug、response actions、transcript、trace、memory detail。它适合调试，不适合面试。

于是 Focus Mode 出现了。它把面试时真正需要看的内容拆成两个窗口：

- 上方主窗口：Answer、中文思路、Code、Complexity、Clarifying question、latest reliable answer。
- 下方控制窗口：interview type、latest transcript、speech correction、pause/start。

后来又继续削减：Focus Mode 隐藏主 bar 和 icon bar，减少视觉干扰；通过 hotkey 切换；保留 interview type selector，因为它是低摩擦高收益的背景约束；移除 bilingual action，改成永远生成中文思路，避免后处理翻译慢且不完整。

再往后，UI 的重点从“少显示一点”变成“让长轨迹任务可控”。System design 和 AI/ML design 不能只靠一条 answer 走完，它们需要持续演进的 whiteboard artifact：requirements、组件、数据流、瓶颈、metrics 和 tradeoff 会随着对话更新。`Next` 也不是普通 regenerate button，而是用户用一次低摩擦操作推进 playbook phase：runtime 先提交 `manualPhaseFrom -> manualPhaseTo`，再让模型按新的阶段生成内容。

这里的判断是：高压力场景里，功能越多不等于越好。UI 的任务是让用户尽快开始自然回答，同时给用户保留少量能改变 trajectory 的控制点。Debug Mode 可以承载复杂信息；Focus Mode 只保留当场有用的显示和动作。

## Evaluation infrastructure 是产品基础设施

Jarvis 后期最大的变化，不是增加某个新模型，而是建立可复盘的 evaluation infrastructure。

早期我们只能靠体感说“这次回答还不错”或“好像慢了”。Trace instrumentation 先解决了单次 workflow 的可见性：截图、音频、memory retrieval、prompt、first token、raw output、state update 和 total latency 都有记录。它能回答“慢在哪里”“模型看到了什么”“memory 注入了什么”。

Session Recording 把评价对象从 single trace 扩展到完整 mock interview。一次 session 会落盘 transcript、screenshots、prompts、raw outputs、memory artifacts、task snapshots、compact metrics 和 human evaluation。这样就可以复盘一条 trajectory，而不是孤立地看某个回答。

Human Evaluation v2 又补上了最关键的一环：人类标签。它不只评价一条 trace 成功或失败，还能在 question level 标注：

- question type 是否正确。
- playbook 是否正确。
- phase 是否合理。
- memory 是否 relevant、irrelevant、forbidden。
- 是否缺失 expected memory。
- guardrail 是否正确。
- answer 是否有帮助。

这让 Jarvis 的优化目标从“调 prompt 直到感觉好一点”变成“沿着 evidence chain 定位 failure layer”。

最近一轮又补上了 task-level review index。`tasks/review-index.latest.json` 和 `tasks/<taskId>/review-summary.json` 会把 compact trace summaries 和 question-level labels 按 stable task / parent / child / trace ids join 起来。这样 review 的问题就变了：这个 parent task 经历了哪些 phase？哪次 `Next` 真的推进了？Whiteboard 哪一轮变 stale？哪条 diagram overlay 被选中或拒绝？哪个 human label 对应哪个 runtime layer？

一次 session review 可以把问题归到不同层：

- perception: 截错窗口或 STT 误听。
- classification: question type 或 company 判断错。
- task continuity: 旧任务污染、parent-child 丢失、低价值语音触发重刷。
- memory policy: over-injection、missing memory、forbidden memory hit。
- fact grounding: unsupported story 或 no-anchor fallback 失败。
- playbook: phase 错、没有澄清需求、过早给最终答案。
- model route: coding 题没有走高智模型，或非 coding 题误走慢模型。
- response rendering: markdown、code、math、section parser 出错。

这套证据链改变了产品开发方式。很多 P0 不再来自想象中的功能，而来自 mock interview 的 failure pattern：context pollution、voice task boundary、unsupported story reuse、AI/ML metrics answer too shallow、session recording backfill、human evaluation 粒度太粗。产品学习闭环因此变成：record session，label question/artifact/memory，归因 failure layer，修 runtime contract，再用下一轮 session 验证。

## 哪些交给 AI，哪些交给代码

Jarvis 最核心的系统设计经验可以总结成一句话：把语义不确定性交给 AI，把运行时边界交给代码。

适合交给 AI 的部分：

- 从截图和语音中理解自然语言问题。
- 在多个可见问题中判断用户当前可能关注哪一个。
- 把 interviewer 的补充约束融合进当前回答。
- 按题型生成可说出口的回答。
- 在 coding、system design、AI/ML design、behavioral、project deep dive 中选择合适表达。
- 把 curated memory 转化为自然、简洁、符合场景的表达。
- 把 whiteboard overlay 或 project memory 转成符合当前阶段的表达。

必须由代码、schema 或 runtime 管的部分：

- 当前 active task 是谁。
- 最新输入和 active task 的关系。
- 哪些 memory family 允许被注入。
- generated answer 能不能成为事实来源。
- provider/model route 和 timeout policy。
- coding artifact 和 latest reliable answer 的生命周期。
- session recording 的边界和 join keys。
- trace metrics、human evaluation、hard reject telemetry。
- Whiteboard、Manual Next、diagram overlay 这类中间 artifact 的 metadata contract。
- Debug Mode 与 Focus Mode 的显示策略。
- 隐藏、快捷键、窗口、capture target、音频 segment 顺序。

这个边界不是为了减少 AI 使用，而是为了让 AI 在合适的位置发挥作用。模型越强，越需要清楚地告诉它哪些事实可信、当前任务是什么、它应该按哪个过程推进，以及哪些内容绝不能推断。

## 为 north star 做过的取舍

Jarvis 的 north star 是 critical moment success：在用户需要开口前，给出可信、相关、可用的帮助。

这带来一组取舍。

**手动 hotkey 优先于全自动观察。** 自动屏幕观察听起来更智能，但在 task boundary 和 evaluation corpus 稳定前，它会放大错误触发和上下文污染。手动 screen capture 给用户一个明确的 task start signal，也让 trace 更容易复盘。

**最终转写优先于 streaming rewrite。** Streaming STT 会更实时，但如果顺序、session guard、low-value gating 没做好，错误会更早进入系统。Jarvis 先把音频段顺序、session id、stale result drop 做稳，再考虑 partial transcript。

**Deterministic KMB 优先于 embedding。** Embedding 可以改善语义召回，但第一阶段的主要风险是错误 memory injection。先做 family gating、tag hints、fact anchor 和 reject telemetry，才有足够数据判断 embedding 是否值得加。

**短回答优先于完整长稿。** 面试中用户需要先开口，而不是等一篇完整答案。对于 system design 这类长轨迹任务，Jarvis 应该更愿意给 clarifying question、assumption 和 phased trajectory，而不是一次性猜完整系统。

**模板化 opening 优先于每次即兴生成。** Self-intro、resume walkthrough 和核心项目介绍不应该完全依赖现场生成。它们需要稳定、真实、可练习的主体，再由 Jarvis 根据公司、面试官和 interview brief 做轻量适配。

**Whiteboard artifact 优先于一次性 system design answer。** 长轨迹设计题需要一个可更新的设计状态，而不是每轮重新生成一段文字。Whiteboard 让 requirements、组件、数据流、metrics 和 tradeoff 可以在同一个 parent task 里演进。

**Deterministic Next 优先于让模型猜阶段。** 用户点击 `Next` 时，Jarvis 先在 runtime 里推进 playbook phase，再生成下一步内容。这样用户能用一个低摩擦动作控制 trajectory，而不是等待模型自己判断“现在该进入下一阶段”。

**Focus Mode 优先于配置完整性。** 普通模式保留 Debug 和配置；Focus Mode 只保留面试时要看的东西。这样牺牲了一部分现场可调性，换来更低的视觉和操作成本。

**Coding 题使用更强模型。** Coding 错误代价高，考官对等待时间容忍度更高，所以 Jarvis 为 coding question 增加单独 model route、timeout 和 output budget。其他题型保持更快的模型，保证对话流畅。

**个人本地工具优先于生产级权限体系。** 由于 Jarvis 是个人本地工具，早期 Debug Mode 可以显示完整 prompt、memory 和 trace。这个选择加快了迭代。未来如果要发布给更广泛用户，secrets、retention、redaction、visibility claims 都需要重新设计。

## 结论

Jarvis 的成熟过程说明，AI assistant 的难点通常不在于能不能调用一个更强模型，而在于能不能把模型放进一个可靠的 runtime。

模型负责理解和表达。架构负责边界、状态、证据和恢复。代码负责让每一次回答都有上下文身份、事实来源、memory policy、model route、UI 生命周期和 evaluation trail。

对于 live assistant 来说，单次回答质量只是表层。真正决定可用性的，是系统能否在连续对话中保持正确 trajectory：什么时候回答，什么时候澄清，什么时候保留 parent task，什么时候进入 child probe，什么时候拒绝使用 unsupported memory，什么时候保留旧代码，什么时候保持沉默。

这也是 Jarvis 从“会议辅助软件”演化为“critical-moment assistant”的核心逻辑。它不是把更多东西交给 AI，而是把 AI 放在一套更清楚的系统边界里，让它在用户最需要的那个时刻真正有用。
