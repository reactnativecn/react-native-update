#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "hbc_transform.h"

namespace pushy {
namespace hbc {

// 客户端当前支持的变换规范版本。生成端(CLI)在 __diff.json 里写入 v;
// v 不在支持范围时调用方必须放弃 diff 应用(回退整包),不能忽略元数据。
constexpr uint32_t kHbcTransformSupportedVersion = 1;

// __diff.json 中单个 bundle patch 条目的 hbcTransform 元数据:
// {"v":1,"hbcVersion":96,"layout":{"counts":19,"sections":[[ci,es,[[b,bi,bits],...]],...]}}
// 解析结果自持有存储;BuildLayout 产出的描述指向本结构,生存期须不短于使用期。
struct HbcTransformMeta {
  uint32_t v = 0;
  uint32_t hbcVersion = 0;
  uint32_t headerCountFields = 0;
  struct Section {
    uint32_t countIndex = 0;
    uint32_t entrySize = 0;
    std::vector<HbcDeltaField> deltaFields;
  };
  std::vector<Section> sections;
};

// 严格解析(元数据视为不可信输入):结构、类型、数量全部受限,
// 任何偏离返回 false。允许对象中出现未知键(数字/字符串/嵌套值会被跳过),
// 为未来元数据扩展留余地。
bool ParseHbcTransformMeta(const std::string& json, HbcTransformMeta* out);

// 由 meta 构建解释器输入。sections_scratch 由调用方持有,生存期须覆盖
// layout 的使用期(layout 内部指针指向 meta 与 scratch)。
HbcLayoutDesc BuildLayout(
    const HbcTransformMeta& meta,
    std::vector<HbcSectionDesc>* sections_scratch);

} // namespace hbc
} // namespace pushy
