# 原生冷启动检测:遗留改进项

> 来源:`agent/harden-native-check-update` 分支两轮评审
> （f679e11 初次评审 10 项 → 181952a 修复 4 项、缓解 1 项）。
> 本文只记**仍开放**的项;已修复项不再列。按优先级排序,每项含现状、
> 风险与建议修法。发版(10.51.0)前建议至少处理 P1;P2 可随小版本;
> P3/P4 显式拍板"接受"也算关闭。

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
`persistResponseCache` 写进 `ts`(三端各一行改动,JS 读侧无需变);顺手把
600s 整轮 deadline 补齐到 iOS/Harmony,消除三端 parity 缺口。

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

## 发版清单(非代码缺陷,勿遗漏)

- [ ] e2e:坏 bundle → 原生拉修复版 → 下次启动复活的端到端用例
      (沿用 Example/e2etest 基建;harmony 走 hdc/uitest 链路)
- [ ] README / README-CN / CHANGELOG:原生冷启动检测、forceBoot、
      绑定依赖硬校验(RN 版本一致、rnu 不降级)
- [ ] 客户端 10.51.0 发版(admin 的 forceBoot 门槛与之对齐)
- [ ] 服务端已推送未激活:pushy 主机 `install-npm-release.sh` +
      `service-cli.sh restart all`(验 serverVersion);cresc 跑
      `update-cloudrun.sh`;两个 admin 走各自 CI
