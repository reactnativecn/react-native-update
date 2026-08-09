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

代码验证基线：JS 完整回归 172 项、Biome/TypeScript/Harmony strict 类型检查、
77 项 flow core ASan/UBSan、29 项 patch core、Android Release Java 编译、
iOS Release simulator 构建均通过。

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
   attempts×urls×600s,可达 90 分钟),Harmony 完全没有(慢滴 CDN 每
   <60s 一字节即可绕过下载任务的不活动看门狗,轮次可跑数小时);
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

## 发版清单(非代码缺陷,勿遗漏)

- [ ] e2e:坏 bundle → 原生拉修复版 → 下次启动复活的端到端用例
      (沿用 Example/e2etest 基建;harmony 走 hdc/uitest 链路)
- [ ] README / README-CN / CHANGELOG:原生冷启动检测、forceBoot、
      绑定依赖硬校验(RN 版本一致、rnu 不降级)
- [ ] 客户端 10.51.0 发版(admin 的 forceBoot 门槛与之对齐)
- [ ] 服务端已推送未激活:pushy 主机 `install-npm-release.sh` +
      `service-cli.sh restart all`(验 serverVersion);cresc 跑
      `update-cloudrun.sh`;两个 admin 走各自 CI
