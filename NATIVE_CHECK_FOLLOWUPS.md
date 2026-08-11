# 原生冷启动检测:遗留改进项

> 来源:`agent/harden-native-check-update` 分支两轮评审
> （f679e11 初评 10 项 → 181952a 修 4 缓解 1;181952a 复评又出 10 项,
> 其中 6 项为修复自身引入,已并入下文）。
> 本文最初只记录开放项。2026-08-10 已完成代码项复核与修复；下文保留
> 原始问题描述用于追溯，处理结论以紧随其后的状态表为准。发版动作仍保留在
> 文末清单中，不因代码合入而自动视为完成。

## 2026-08-10 处理结论

| 项目 | 结论 | 落地方式 |
|---|---|---|
| P1 Android/Harmony 重复下载 | 已修复 | 任务真正开始时复查 `.pushy-complete` + bundle；失败清理检测到完整安装时不删目录。iOS 注册表同时升级为按 hash + artifact type 合流/排队 |
| P2 缓存 `ts` 锚点 | 已修复 | 三端在 check 响应到达时捕获时间，下载、补丁和激活结束后仍写该时间 |
| P2 下载轮次 deadline | 已修复 | 三端统一为 diff/pdiff 共享 600s、full 独享 600s；发起前检查绝对 deadline，下载任务在真正开跑时按剩余预算设置 whole-call timeout |
| P2 JS 配置回退竞态 | 已修复 | 在途写入期间仍记录与 `synced` 相同的最新期望值；B 完成后会继续把 A 写回；删除同步 throw 路径的无效递归 |
| P2 iOS 合流语义 | 已修复 | 同类型下载共享结果并向所有 join 者广播进度；不同类型按 hash 排队，避免把 diff 的失败错误归给 full |
| P3 `.pushy-complete` 迁移 | 接受一次性重下 | 不把仅有 bundle 的旧目录推断为完整安装，避免把半解压目录误标为成功；10.51.0 发布说明仍需明确这一流量成本 |
| P3 状态解析异常不调度 | 已修复 | 三端启动解析改为 finally 调度；正常路径保留最终 rollback 快照，异常路径使用空快照 |
| P3 无 hash 死弹窗 | 已修复 | Provider 将无 hash 的 update 降级为开发者日志/遥测与 `upToDate`，不再展示不可执行的确认按钮 |
| P3 `noArtifact` 静默 | 已修复 | 保持终端用户无感，同时恢复 `errorUpdate` 报告并携带目标 hash |
| P4 bundleHash 窗口 | 接受并记录 | `readNativeCheckCache` 已注明首启预取未完成时有意 cache miss，不为 hash 阻塞检查 |
| P4 缓存冗余解析 | 已修复 | 直接传入现成 `fetchBody`/native config 对象，只解析缓存中的字符串一侧 |
| P4 endpoint 斜杠重复 | 已修复 | 三端首轮请求也先查规范化后的 `tried` 集合，重复项不计入 8 次上限 |
| P4 Harmony 整请求超时 | 已修复 | check HTTP 增加 15s whole-call cap；更新下载增加绝对 deadline 并在超时后销毁请求 |

代码验证基线：JS 完整回归 173 项、Biome/TypeScript/Harmony strict 类型检查、
77 项 flow core ASan/UBSan、29 项 patch core、Harmony debug HAR、Android
Release Java 编译、iOS Release simulator 静态库构建均通过。

---

## 2026-08-10 第三轮评审(283dfd4)开放项

上表 13 项的修复经复评确认全部属实;以下为修复自身引入/暴露的新开放项
(详情与逐条修法见评审面板)。

复核后处理结论：

| 项 | 结论 | 落地方式 |
|---|---|---|
| 1 iOS joiner 预算 | 已修复 | 注册表记录 owner 的单调时钟 deadline；预算更长的 waiter 观察当前进度但 deferred，owner 成功时由完成标记立即命中，失败时以自己的完整预算重启 |
| 2 Harmony 外层时限 | 已修复 | `performAttempts` 用绝对单调 deadline 包住排队、HTTP、解压和 hpatch 的完整 Promise；底层串行任务即使晚结束也不再阻止编排器落响应缓存 |
| 3 壁钟 deadline | 已修复并修正文档结论 | iOS 改用 `systemUptime`，Harmony 改用 `systemDateTime.getUptime`；full 预算进入 full 阶段才创建，因此原文“增量阶段校时会同时耗尽尚未创建的 full 预算”不成立 |
| 4 Android full 判定 | 已修复 | 与分发逻辑及 iOS/Harmony 一致，非 diff/pdiff 统一视为 full；上游当前只生成三种合法类型，此项属于防御性收口 |
| 5 坏发布遥测膨胀 | 已修复 | 缺 hash 与 noArtifact 共用按 appKey/reason/hash 的进程内去重，保留一次服务端可见的坏发布信号 |
| 6 有 hash 无产物弹窗 | 已修复 | Provider 在展示/静默下载前复用 `decideDownload`，noArtifact 降级为 `upToDate` 与一次开发者遥测 |
| 7 deferred UX/deadline | 已修复 | deferred waiter 订阅当前同 hash 进度；旧 deadline 在重新注册前校验，过期的编排器请求不会成为 owner 或结算后来的 JS 请求 |
| 8 owner-only 进度事件 | 不采纳 | 支持路径在 JS 已按 hash 维持单一原生监听；常见 join 是无监听器的冷启动 engine + JS bridge。限制为 owner 发事件会在 engine 先成为 owner 时丢失 JS 进度 |
| 9 iOS 完成判定重复 | 已修复 | 抽取 `PushyHasCompletedVersionAtPath`，预检与冷启动编排器共用同一 bundle+marker 判定 |

**P2(三端时限模型的二阶问题,建议一并收口)**
1. **iOS 合流者继承 owner 剩余预算**:JS 同 hash 同类型合流到编排器下载时,
   共享会话带的是编排器所剩阶段预算(可能只剩几十秒),其超时会结算全部
   合流者——修改前 JS 独立下载固定 600s 的不变量对合流路径失效。
2. **Harmony await 无外层时限**:统一预算只管住 HTTP 流;解压/hpatch 卡死
   或串行链被长任务占用时 `await context.downloadX` 永不返回,救援轮次挂满
   进程生命周期,响应缓存也不落盘。修法:performAttempts 层对每个 await 包
   Promise.race 绝对 deadline。
3. **壁钟 vs 单调钟**:iOS/Harmony 的 deadline 锚壁钟(epoch/Date.now),
   Android 锚 nanoTime——首次联网触发 NTP 前跳(恰是救援检测时刻)会让
   iOS/Harmony 全部预算(含 full 保底)瞬时过期。修法:iOS 用
   systemUptime/mach 时基,Harmony 用相对定时器。

**P3**
4. **Android 按字面 "full" 判保底预算**,分发 else 分支却把任意非 diff/pdiff
   类型当 full 下载;iOS/Harmony 用排除法——三端对"谁享有 full 保底"不再
   一致,Android 改排除法即齐。
5. **noArtifact 遥测重复膨胀**:映射到 download_fail 聚合且每次
   downloadUpdate 调用都上报(静默策略下每个检查周期一条),需按 hash
   会话内去重或换不入聚合的事件类型。
6. **有 hash 无产物的死弹窗变体**:provider 只降级了无 hash 的 update;
   有 hash 但无任何产物 URL 的坏发布仍弹确认框、确认后静默。
7. **iOS deferred 的 UX 与陈旧 deadline**:异类型 deferred 请求无进度、
   延迟开始(UI 冻结);重启时携带编排器的旧 deadlineAt,排队期间过期则
   瞬时失败并连带结算 JS 合流者。JS 发起的请求不应携带编排器 deadline。

**P4**
8. **iOS 合流者进度块重复发事件**(N 合流者 = N 倍 RN 事件,事件发送应只由
   owner 承担)。
9. **完成判定(bundle+marker)在 iOS 两处手写**,抽 PushyHasCompletedVersion
   helper 防漂移。


---

## P1 — Android/Harmony 重复下载竞态,失败路径可删除已安装版本

**现状**:iOS 在 f679e11 引入了进程级在途下载注册表
（`PushyRegisterDownload`/`PushyFinishDownload`）,同一 hash 的并发下载合流。
Android 与 Harmony 只有任务串行化,没有按 hash 去重,也不保护已完成目录。

**风险**:JS 自动下载版本 H 进行中(单线程 executor 排队),原生检测 5 秒后
`hasCompletedVersion(H)` 为 false,再排入第二个 H 的下载任务。JS 任务完成、
写入 `.pushy-complete` 并 `setNeedUpdate(H)` 后,排队的重复任务重新下载 H
且中途失败(断网)时,`cleanUpAfterFailure` 删除 `rootDir/H`(含
`index.bundlejs` 与标记)。下次冷启动解析到 H 但 bundle 缺失 → 回滚——
**已成功安装的更新被静默丢失**。

**建议修法**(三选一,或组合):
1. 移植 iOS 的按 hash 在途注册表(Android 用
   `ConcurrentHashMap<String, List<Listener>>`,Harmony 用模块级 Map);
2. 更小的止血:`cleanUpAfterFailure` 里若目标目录已有
   `.pushy-complete` 标记则不删(失败的是重复下载,不是这份安装);
3. DownloadTask 开跑前再查一次 `hasCompletedVersion(hash)`,已完成即直接
   走成功回调。
方案 2+3 组合改动最小且互补;方案 1 语义最完整(还能省一次重复下载)。

---

## P2 — 响应缓存的 `ts` 锚在持久化时刻,而非响应到达时刻

**现状**:`persistResponseCache` 在原生下载/激活全部结束后才落盘,`ts` 取
当时时间。181952a 给 Android 加了整轮 600s deadline,把最坏偏移压到
~12 分钟,但锚点本身未改;iOS 仍是逐 URL 600s、Harmony 依赖下载任务自身
超时,无整轮上限。

**风险**:版本发布几分钟后被运营撤下/回滚时,一个"响应早已过时但 ts 很新"
的缓存会让 JS 在 120s 窗口内把已撤回的响应当新鲜结果复用,继续下载/激活
已撤回版本。

**建议修法**:响应到达时捕获 `responseAtSeconds`,作为参数传入
`persistResponseCache` 写进 `ts`(三端各一行改动,JS 读侧无需变)。

**复评补充(181952a 引入/暴露)——下载轮次时限应作为一个整体设计统一三端**:
1. 整轮 600s deadline 只落了 Android;iOS 仍逐 URL 600s(上界
   attempts×urls×600s,可达 90 分钟),Harmony 完全没有(慢滴 CDN 在每个
   60 秒窗口内返回至少一个字节即可绕过下载任务的不活动看门狗,轮次可跑数小时);
2. Android 的 deadline 在下一个下载**已发起后**才检查——超时轮次仍会
   多启动一个孤儿下载,浪费带宽且可能与 JS 重试并发写版本文件
   (修法:发起前先查);
3. 整轮预算会被 diff/pdiff 的失败耗尽,挤压救砖最后手段 full 的时间
   (原先 full 独享 600s)——建议 full 单独保底额度。

---

## P2 — JS 配置同步的回退竞态(181952a 引入)

**现状**:`syncNativeConfig` 的去重把当前配置与**最后一次已完成**的写入
(`syncedNativeConfigJson`)比较。

**风险**:已同步 A → setOptions 改为 B(写入在途)→ B 完成前又回退为 A:
回退因等于 `synced`(仍是 A)被直接丢弃,随后 B 完成、`synced=B`、pending
为空——原生 KV 永久持有错误的策略/endpoints(如 app 已切回 alert 却按
silent 激活),直到未来某次不同值的 setOptions 才被纠正。

**建议修法**(改动极小):去重时把在途/待写值一并纳入比较,或写入完成回调里
与"最新期望值"复核不符则重新入队。顺手删掉 `flushNativeConfig` 同步抛
catch 里的死代码递归"重试"(pending 已清空,必然早退,误导维护者)。

---

## P2 — iOS 合流下载的两个语义代价

**现状**:JS 的下载调用合流到冷启动引擎的在途下载后:
1. **收不到进度事件**——事件只由持有下载的实例发出,引擎实例
   `hasListeners=NO`,用户看到进度条冻在 0;
2. **继承异类 attempt 的失败**——引擎的 diff 尝试 404 时,JS 本可成功的
   full 下载调用被判失败(JS 策略链会继续下一策略+重试回退,最终多能成功,
   但单次调用的失败归因是错的)。

**建议修法**:注册表回调列表旁存进度回调,引擎下载的 NSURLSession 进度
透传给所有 join 者(解决 1);join 时携带请求类型,类型不同不合流、改为
排队串行(解决 2,代价是偶发的一次串行等待)。若认为 JS 策略链的自愈已
足够,可显式拍板只修 1。

---

## P3 — `.pushy-complete` 无迁移,存量已下载版本升级后重下一次

**现状**:旧版本库下载的版本目录没有标记文件;升级到新库后
`hasCompletedVersion` 判 false,原生检测整包重下一遍(下载完成后写标记,
自愈,每台受影响设备一次)。

**风险**:一次性流量成本,仅影响"已下载未激活"(alert 类策略)的存量设备。

**建议**:二选一显式拍板——(a) 接受成本,在 CHANGELOG 注明;(b) 加迁移:
首次运行时对"有 `index.bundlejs` 且 mtime 早于本次库安装"的目录补写标记
(无法区分半解压目录,有误判风险,故 (a) 可能更稳)。

---

## P3 — 启动状态解析抛异常时,救援检测永不调度

**现状**:f679e11 把 `schedule` 从 `getBundleUrl`/`+bundleURL` 顶部移到
各出口(为携带回滚快照),但若 `runStateCore`/回滚循环自身抛异常,所有
出口都到不了。

**风险**:持久化状态损坏(恰是救援机制存在的场景)时,救援检测在后续所有
启动中都不运行。

**建议修法**:状态解析段包 try/finally,finally 里以"空快照"调度
(rolledBackVersion 传 null 即可,宁可少守卫不可不调度——与"判定失败不
计数"同一取舍方向);三端同改。

---

## P3 — 无 hash 的灰度条目从"静默忽略"变成"死弹窗"(181952a 语义变更的副作用)

**现状**:`resolveCheckResult` 的非空 hash 守卫移除了旧的
`undefined === undefined` 等价:服务端误配出无 hash 的灰度条目时,内置包
设备(currentVersion 为空)从静默 upToDate 变为返回 `update:true` 且无
hash——已被再生成的金标向量固化。

**风险**:alert 策略下每次检查都弹"发现新版本",点确认后 `decideDownload`
因 `!hash` 判 noUpdate——死弹窗,按钮无效,每次检查重现。

**建议修法**:若新语义有意(暴露服务端错配),在 provider 层把无 hash 的
update 降级为日志 + 遥测而非弹窗;若无意,恢复"无 hash 条目不视为可更新"。
与下一条(noArtifact)同属"坏发布该以遥测暴露而非 UI 弹窗/静默"。

---

## P3 — `noArtifact` 分支静默返回,丢失 errorUpdate 遥测(181952a 引入)

**现状**:decideDownload 新增的 noArtifact 拒绝让 `downloadUpdate` 无日志、
无错误事件、无遥测地返回;旧的空 attempts 路径会上报
`{type:'errorUpdate'}`。

**风险**:服务端发出 update:true 有 hash 但无任何产物 URL 的坏发布,从
"控制台可见"退化为"客户端静默无事发生",坏发布隐形。

**建议修法**:noArtifact 分支恢复 report({type:'errorUpdate', ...}),保持
用户无感但平台可见。

---

## P4 — bundleHash 未就绪窗口的请求指纹失配(记录即可)

**现状**:JS 预取 bundleHash 未 settle 时构造的请求体缺 `bundleHash` 键,
与原生缓存的请求(原生同步计算,总带该键)键集不同 → 指纹不命中,走网络。
窗口极窄(通常仅首启,且该时刻缓存多半尚不存在);`overridePackageVersion`
的失配已在 181952a 通过配置携带 `packageVersion` 修复。

**建议**:在 `readNativeCheckCache` 注释里写明这是已知且有意的失配面,
不做代码改动。

---

## P4 — `readNativeCheckCache` 冗余解析(cleanup)

**现状**:调用方刚 stringify 的请求体被立即 parse 回来做结构比较,外加对
当前 config JSON 的一次重复解析——每次 release 路径 checkUpdate 的固定
开销。

**建议**:把现成的 `fetchBody` 对象传入,只 parse `entry.request` 一侧。

---

## P4 — 若干小项(复评新增)

- **斜杠变体 endpoint 重复请求**:尾斜杠归一化发生在 C++ 去重之后,且首轮
  循环只 add 不查 `tried`——`https://u.example.com` 与 `…com/` 会对同一
  URL POST 两次,还白占 8 次 HTTP 上限中的两次。修法:归一化提前进纯层
  (`orderEndpointCandidates` 前),或首轮也查 `tried`。
- **Harmony 检查请求缺整请求封顶**:只有 connect/read 超时,没有 Android
  `callTimeout(15s)` / iOS 超时取消的对应物,慢滴响应可拖长每次尝试。

---

## 2026-08-11 第四轮评审(60f5fd2..5f5d0cb)开放项

上一轮 9 项闭环全部属实(第 8 项"owner-only 进度事件"维护者明确不采纳,理由
成立)。以下为仍开放项;**前三条建议合入前处理**,其余可随小版本。

### 合并阻断 —— 已于 2026-08-11 修复(见下方"修复说明")

#### 原始问题描述

1. **原生检测无视 `checkStrategy`,并能撞销 `resetToPackagedBundle`**
   (CI 已红)。`getNativeConfig` 只用 `updateStrategy` 折算 `afterDownload`,
   从不读 `checkStrategy`;三端也没有 reset↔检测 的任何联动(无 generation、
   无取消,reset 也不清 `nativeCheckResp`)。e2e app 明写 `checkStrategy: null`
   却仍被原生自动下载+激活;`resetToPackagedBundle` 可被在飞的检测撤销。
   **证据**:e2e-ios 在 `0f4651e` 与 `5f5d0cb` 两次运行均挂在 `beforeEach`
   的 `bundleLabel: BINARY_BASE`,且两次挂的是不同用例(竞态签名);失败态
   `currentHash: e2e-full-v1` 恰是"reset 后从零检查会拿到的第一个版本";
   master 上 e2e-ios 为绿 → 本分支引入的回归。本分支新增的
   `hasCompletedVersion` 快路径(版本已落盘则跳过下载直接 switchVersion)
   把竞态窗口从"下载完"压到"5 秒后瞬间",是这轮才炸的原因。
   **修法**:`afterDownload` 计算纳入 `checkStrategy`(为 null 时降为
   `'none'`——只下载不激活,`forceBoot` 仍可救砖);`resetToPackagedBundle`
   bump 进程级 generation,编排器在 `switchVersion`/落缓存前比对,变了就
   放弃,并清掉响应缓存。

2. **iOS 同类型 join 分支实际不可达**。`deadlineUptime > ownerDeadline` 是
   严格大于,而 JS 发起的请求总晚于 owner 的计算时刻,因此永远走 deferred:
   P1"一个 hash 共享一次下载"的意图失效,退化为串行重下;CDN 黑洞时用户
   弹窗可转近 20 分钟(改前是合流后一次失败并回退下一候选 URL)。修法:比较
   加容忍阈值,或 JS 发起的请求不参与 deadline 比较。

3. **Harmony 用 `TimeType.STARTUP`**(计深度睡眠),而 iOS `systemUptime` /
   Android `nanoTime` 睡眠时停走——"三端统一单调钟"不成立。锁屏休眠数分钟
   即让预算过期、救援中止,同网络的另两端能续传完成。一行改
   `TimeType.ACTIVE`。

#### 修复说明(2026-08-11)

1. **checkStrategy + reset 竞态**:`getNativeConfig` 的 `afterDownload` 现在
   要求 `checkStrategy != null` —— 关掉自动检查的应用不会再被塞一次它没要
   过的版本切换;检测本身照跑(救砖能力不变),`forceBoot` 仍可激活。另加
   **reset 代数守卫**:`resetToPackagedBundle` 递增进程级计数并清掉响应缓存,
   编排器在开跑前采样、在激活与落缓存前比对,不一致即整轮丢弃。三端同构
   (iOS `std::atomic<uint64_t>`、Android `AtomicLong`、Harmony 静态计数)。
2. **iOS join 分支不可达**:比较从"绝对 deadline 严格大于"改为"剩余预算",
   仅当 owner 剩余不足新来者的一半时才 defer —— 正常情况(JS 晚几秒发起)
   恢复合流,只有真正濒临耗尽的 owner 才让位。
3. **Harmony 单调钟**:`TimeType.STARTUP` → `TimeType.ACTIVE`,与 iOS
   `systemUptime` / Android `nanoTime` 的"睡眠时停走"语义对齐。

**补强(2026-08-11,CodeRabbit 复核后)**:初版守卫是 compare-and-act,且
`hash_<hash>` 元信息写在守卫之前——reset 若落在"比对通过"与"写入"之间仍
可被覆盖。现改为**一次原子提交**:版本元信息 + 激活 + 响应缓存合并为
`commitNativeCheckResult(expectedGeneration, ...)`,内部先复核代数再落全部
写入;`resetToPackagedBundle` 与之互斥并**先失效代数再清状态**。互斥手段按
端选取:iOS 复用既有 `PushyWithStateLock`(为此把 switchVersion 拆出无锁核
`PushySwitchVersionLocked`,避免不可重入死锁)、Android 用共享
`commitLock`、Harmony 是 ArkTS 单线程且提交内无 await,天然原子(已注释说
明)。三处落点(元信息/激活/缓存)与三个调用点(nothing-to-do、未下载、成功)
全部走同一入口。

验证:JS 178 项(新增 2 项 checkStrategy 折算用例)、Biome/tsc/DevEco
strict、77 金标向量 + ASan/UBSan、`.so` 符号与 16KB 对齐、iOS clang
(DEBUG=0/1)、Android javac(main+oldarch)、OHOS 工具链语法。本轮不触
`cpp/`,无需重生成向量或重编 `.so`。

### 后续小版本

4. Harmony 超时只放弃编排器的 `await`,卡死的 DownloadTask 仍占 `taskChain`,
   后续 attempt 只是排队并空烧自己的新鲜预算(有效 full 产物 + 完整预算都在
   却仍救不回)。修法:超时真正取消底层任务,或救援轮次用独立链。
5. iOS/Harmony 的 `switchVersion` 仍可激活半完成安装(Android 本轮加了无标记
   拒绝守卫,三端 parity 分歧)。
6. iOS deferred 异类型 waiter 订阅了 owner 的进度流,收到的是另一种产物的
   字节数(进度条先到 100% 再回 0%)。修法:只向同类型合流者广播。
7. 缺 hash 守卫新加的 `!info.expired` 让 `{expired:true, update:true}` 且无
   hash 的畸形响应既不降级也不上报,却仍把 `update:true` 发给业务侧。
8. `getNativeConfigJson() ?? '{"disabled":true}'` 会把瞬时为空的
   `appKey`/`server.main` 变成持久 disabled 写入,覆盖上一份可用配置并长期
   关掉救砖能力。修法:仅在确实不可用(web/旧原生)时写 disabled。
9. `noArtifact` 上报位置从 `client.downloadUpdate`(实际尝试下载)移到
   `provider.checkUpdate`(只要检查就发),映射到服务端 `download_fail` 聚合
   后会把一次坏发布放大成全量设备级的健康下降。
10. 两处 cleanup:Android `switchVersion` 重写了同文件已有的
    `hasCompletedVersion` 谓词;provider 为一个是非问题重跑完整
    `decideDownload`(分配 URL 计划后丢弃)。

### 累计

四轮共 40 条发现:27 修复、2 显式接受、1 不采纳、10 开放(其中 3 条建议合入
前处理)。

---

## 发版清单(非代码缺陷,勿遗漏)

- [ ] e2e:坏 bundle → 原生拉修复版 → 下次启动复活的端到端用例
      (沿用 Example/e2etest 基建;harmony 走 hdc/uitest 链路)
- [ ] README / README-CN / CHANGELOG:原生冷启动检测、forceBoot、
      绑定依赖硬校验(RN 版本一致、rnu 不降级)
- [ ] 客户端 10.51.0 发版(admin 的 forceBoot 门槛与之对齐)
- [ ] 服务端已推送未激活:pushy 主机 `install-npm-release.sh` +
      `service-cli.sh restart all`(验 serverVersion);cresc 跑
      `update-cloudrun.sh`;两个 admin 走各自 CI
