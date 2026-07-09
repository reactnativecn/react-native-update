// hbc_transform 宿主机测试:
// 1) 与 JS 参考实现(react-native-update-cli src/utils/hbcTransform.ts)
//    做 golden 对拍——fixtures/*.t.hbc 由 JS 实现生成;
// 2) 可逆性 property check;
// 3) 非法输入/非法描述表拒绝(buffer 必须保持原样);
// 4) wire 解析器(ParseHbcTransformMeta/BuildLayout)的正向/负向直测——
//    它解析的是随 patch 下发的不可信输入,拒绝分支必须逐条有覆盖。
#include "../hbc_transform.h"
#include "../hbc_transform_wire.h"

#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

namespace {

using pushy::hbc::BuildLayout;
using pushy::hbc::HbcDeltaField;
using pushy::hbc::HbcLayoutDesc;
using pushy::hbc::HbcSectionDesc;
using pushy::hbc::HbcTransformMeta;
using pushy::hbc::ParseHbcTransformMeta;
using pushy::hbc::TransformHbcInPlace;

int g_failures = 0;

#define CHECK(cond)                                                       \
  do {                                                                    \
    if (!(cond)) {                                                        \
      std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      ++g_failures;                                                       \
    }                                                                     \
  } while (0)

std::vector<uint8_t> ReadFileOrDie(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    std::fprintf(stderr, "cannot open fixture: %s\n", path.c_str());
    std::exit(1);
  }
  return std::vector<uint8_t>(
      (std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
}

// ---- 布局描述表(测试用常量;生产路径从 patch 元数据的 wire 格式构建)----
// 与 CLI 的 HBC_LAYOUTS 逐字段对应。counts 槽位约定:0 = fileLength,
// 最后一个 = debugInfoOffset。

const HbcDeltaField kFuncOffset25[] = {{0, 0, 25}};
const HbcDeltaField kFuncOffsets25x2[] = {{0, 0, 25}, {8, 0, 25}};
const HbcDeltaField kStringOffset23[] = {{0, 1, 23}};
const HbcDeltaField kPairOffset32[] = {{0, 0, 32}};

// v87~v96:19 个计数槽
// [0]fileLength [1]globalCodeIndex [2]functionCount [3]stringKindCount
// [4]identifierCount [5]stringCount [6]overflowStringCount
// [7]stringStorageSize [8]bigIntCount [9]bigIntStorageSize [10]regExpCount
// [11]regExpStorageSize [12]arrayBufferSize [13]objKeyBufferSize
// [14]objValueBufferSize [15]segmentID [16]cjsModuleCount
// [17]functionSourceCount [18]debugInfoOffset
const HbcSectionDesc kSectionsV96[] = {
    {2, 16, kFuncOffsets25x2, 2}, // functionHeaders
    {3, 4, nullptr, 0}, // stringKinds
    {4, 4, nullptr, 0}, // identifierHashes
    {5, 4, kStringOffset23, 1}, // smallStringTable
    {6, 8, kPairOffset32, 1}, // overflowStringTable
    {7, 1, nullptr, 0}, // stringStorage
    {12, 1, nullptr, 0}, // arrayBuffer
    {13, 1, nullptr, 0}, // objKeyBuffer
    {14, 1, nullptr, 0}, // objValueBuffer
    {8, 8, kPairOffset32, 1}, // bigIntTable
    {9, 1, nullptr, 0}, // bigIntStorage
    {10, 8, kPairOffset32, 1}, // regExpTable
    {11, 1, nullptr, 0}, // regExpStorage
    {16, 8, nullptr, 0}, // cjsModuleTable
    {17, 8, nullptr, 0}, // functionSourceTable
};
const HbcLayoutDesc kLayoutV96 = {19, kSectionsV96, 15};

// v98 早期变体(Static Hermes,19 槽):SmallFuncHeader 12B、
// objShapeTable 取代 objValueBuffer
const HbcSectionDesc kSectionsV98[] = {
    {2, 12, kFuncOffset25, 1}, // functionHeaders
    {3, 4, nullptr, 0}, // stringKinds
    {4, 4, nullptr, 0}, // identifierHashes
    {5, 4, kStringOffset23, 1}, // smallStringTable
    {6, 8, kPairOffset32, 1}, // overflowStringTable
    {7, 1, nullptr, 0}, // stringStorage
    {12, 1, nullptr, 0}, // literalValueBuffer
    {13, 1, nullptr, 0}, // objKeyBuffer
    {14, 8, kPairOffset32, 1}, // objShapeTable
    {8, 8, kPairOffset32, 1}, // bigIntTable
    {9, 1, nullptr, 0}, // bigIntStorage
    {10, 8, kPairOffset32, 1}, // regExpTable
    {11, 1, nullptr, 0}, // regExpStorage
    {16, 8, nullptr, 0}, // cjsModuleTable
    {17, 8, nullptr, 0}, // functionSourceTable
};
const HbcLayoutDesc kLayoutV98 = {19, kSectionsV98, 15};

// v98 晚期变体(生产主流,20 槽):槽 15 = numStringSwitchImms,
// 其后 segmentID/cjs/functionSource/debugInfo 依次后移一位
const HbcSectionDesc kSectionsV98Late[] = {
    {2, 12, kFuncOffset25, 1}, // functionHeaders
    {3, 4, nullptr, 0}, // stringKinds
    {4, 4, nullptr, 0}, // identifierHashes
    {5, 4, kStringOffset23, 1}, // smallStringTable
    {6, 8, kPairOffset32, 1}, // overflowStringTable
    {7, 1, nullptr, 0}, // stringStorage
    {12, 1, nullptr, 0}, // literalValueBuffer
    {13, 1, nullptr, 0}, // objKeyBuffer
    {14, 8, kPairOffset32, 1}, // objShapeTable
    {8, 8, kPairOffset32, 1}, // bigIntTable
    {9, 1, nullptr, 0}, // bigIntStorage
    {10, 8, kPairOffset32, 1}, // regExpTable
    {11, 1, nullptr, 0}, // regExpStorage
    {17, 8, nullptr, 0}, // cjsModuleTable
    {18, 8, nullptr, 0}, // functionSourceTable
};
const HbcLayoutDesc kLayoutV98Late = {20, kSectionsV98Late, 15};

void TestGoldenPair(
    const std::string& dir,
    const char* plainName,
    const char* goldenName,
    const HbcLayoutDesc& layout) {
  const std::vector<uint8_t> plain = ReadFileOrDie(dir + plainName);
  const std::vector<uint8_t> golden = ReadFileOrDie(dir + goldenName);
  CHECK(plain.size() == golden.size());

  // T(plain) == golden(与 JS 实现逐字节一致)
  std::vector<uint8_t> forward = plain;
  CHECK(TransformHbcInPlace(forward.data(), forward.size(), layout, false));
  CHECK(forward == golden);
  CHECK(forward != plain); // 确实改写了字节

  // T⁻¹(golden) == plain
  std::vector<uint8_t> backward = golden;
  CHECK(TransformHbcInPlace(backward.data(), backward.size(), layout, true));
  CHECK(backward == plain);
}

void TestRejections(const std::string& dir) {
  const std::vector<uint8_t> good = ReadFileOrDie(dir + "v98.hbc");

  // 太短
  {
    std::vector<uint8_t> buf(good.begin(), good.begin() + 64);
    CHECK(!TransformHbcInPlace(buf.data(), buf.size(), kLayoutV98, false));
  }
  // 坏 magic → 拒绝且 buffer 不被修改
  {
    std::vector<uint8_t> buf = good;
    buf[0] ^= 0xff;
    const std::vector<uint8_t> before = buf;
    CHECK(!TransformHbcInPlace(buf.data(), buf.size(), kLayoutV98, false));
    CHECK(buf == before);
  }
  // fileLength 与实际大小不符(截断)
  {
    std::vector<uint8_t> buf(good.begin(), good.end() - 8);
    const std::vector<uint8_t> before = buf;
    CHECK(!TransformHbcInPlace(buf.data(), buf.size(), kLayoutV98, false));
    CHECK(buf == before);
  }
  // 计数爆表 → 段越界
  {
    std::vector<uint8_t> buf = good;
    buf[32 + 2 * 4] = 0xff;
    buf[32 + 2 * 4 + 1] = 0xff;
    buf[32 + 2 * 4 + 2] = 0xff;
    buf[32 + 2 * 4 + 3] = 0x0f;
    const std::vector<uint8_t> before = buf;
    CHECK(!TransformHbcInPlace(buf.data(), buf.size(), kLayoutV98, false));
    CHECK(buf == before);
  }
  // 非法描述表:countIndex 越界
  {
    std::vector<uint8_t> buf = good;
    const HbcSectionDesc bad[] = {{99, 4, nullptr, 0}};
    const HbcLayoutDesc badLayout = {19, bad, 1};
    CHECK(!TransformHbcInPlace(buf.data(), buf.size(), badLayout, false));
  }
  // 非法描述表:差分字段超出条目
  {
    std::vector<uint8_t> buf = good;
    const HbcDeltaField badField[] = {{4, 0, 32}}; // byte 4 + 4 > entrySize 4
    const HbcSectionDesc bad[] = {{5, 4, badField, 1}};
    const HbcLayoutDesc badLayout = {19, bad, 1};
    CHECK(!TransformHbcInPlace(buf.data(), buf.size(), badLayout, false));
  }
  // 非法描述表:位域越过 32 位
  {
    std::vector<uint8_t> buf = good;
    const HbcDeltaField badField[] = {{0, 8, 25}};
    const HbcSectionDesc bad[] = {{5, 4, badField, 1}};
    const HbcLayoutDesc badLayout = {19, bad, 1};
    CHECK(!TransformHbcInPlace(buf.data(), buf.size(), badLayout, false));
  }
  // CP2-1 回归:bit=0xFFFFFFFF 时 bit+bits 的 uint32 求和回绕为 0,
  // 曾绕过 >32 检查进入改写阶段(移位量 ≥32 的 UB)。必须拒绝且不改字节。
  {
    std::vector<uint8_t> buf = good;
    const std::vector<uint8_t> before = buf;
    const HbcDeltaField badField[] = {{0, 0xffffffffu, 1}};
    const HbcSectionDesc bad[] = {{5, 4, badField, 1}};
    const HbcLayoutDesc badLayout = {19, bad, 1};
    CHECK(!TransformHbcInPlace(buf.data(), buf.size(), badLayout, false));
    CHECK(buf == before);
  }
  // bit=31 本身合法,但 bit+bits=33 不回绕也必须拒绝
  {
    std::vector<uint8_t> buf = good;
    const HbcDeltaField badField[] = {{0, 31, 2}};
    const HbcSectionDesc bad[] = {{5, 4, badField, 1}};
    const HbcLayoutDesc badLayout = {19, bad, 1};
    CHECK(!TransformHbcInPlace(buf.data(), buf.size(), badLayout, false));
  }
  // 非法描述表:bits=0
  {
    std::vector<uint8_t> buf = good;
    const HbcDeltaField badField[] = {{0, 0, 0}};
    const HbcSectionDesc bad[] = {{5, 4, badField, 1}};
    const HbcLayoutDesc badLayout = {19, bad, 1};
    CHECK(!TransformHbcInPlace(buf.data(), buf.size(), badLayout, false));
  }
}

// ---- wire 解析器直测 ----

std::string ReadTextFileOrDie(const std::string& path) {
  const std::vector<uint8_t> raw = ReadFileOrDie(path);
  return std::string(raw.begin(), raw.end());
}

void TestWireParser(const std::string& dir) {
  // 正向:真实 fixture 解析 + BuildLayout 后与手写 kLayoutV96 等效
  // (对 v96.hbc 变换产物与 golden 逐字节一致 = 端到端等效性证明)
  {
    HbcTransformMeta meta;
    CHECK(ParseHbcTransformMeta(ReadTextFileOrDie(dir + "v96.meta.json"), &meta));
    CHECK(meta.v == 1);
    CHECK(meta.hbcVersion == 96);
    CHECK(meta.headerCountFields == 19);
    CHECK(meta.sections.size() == 15);
    std::vector<HbcSectionDesc> scratch;
    const HbcLayoutDesc layout = BuildLayout(meta, &scratch);
    std::vector<uint8_t> buf = ReadFileOrDie(dir + "v96.hbc");
    CHECK(TransformHbcInPlace(buf.data(), buf.size(), layout, false));
    CHECK(buf == ReadFileOrDie(dir + "v96.t.hbc"));
  }

  const std::string minimalLayout =
      R"("layout":{"counts":19,"sections":[[5,4,[]]]})";
  const std::string minimal =
      R"({"v":1,"hbcVersion":96,)" + minimalLayout + "}";

  // 正向:最小合法输入;未知键(各种值形态)被跳过;边界位域 [0,31,1] 合法
  {
    HbcTransformMeta meta;
    CHECK(ParseHbcTransformMeta(minimal, &meta));
    CHECK(ParseHbcTransformMeta(
        R"({"v":1,"hbcVersion":96,"future":{"a":[1,"s\"x",true,null],"b":-1.5e3},)" +
            minimalLayout + "}",
        &meta));
    CHECK(ParseHbcTransformMeta(
        R"({"v":1,"hbcVersion":96,"layout":{"counts":19,"sections":[[5,4,[[0,31,1]]]]}})",
        &meta));
    CHECK(meta.sections[0].deltaFields[0].bit == 31);
  }

  // 负向:每条拒绝分支单测,解析必须返回 false
  const char* rejects[] = {
      // 非 JSON / 结构破损
      "not json",
      "",
      "{",
      R"({"v":1,"hbcVersion":96})", // 缺 layout
      R"({"v":1,"layout":{"counts":19,"sections":[[5,4,[]]]}})", // 缺 hbcVersion
      R"({"hbcVersion":96,"layout":{"counts":19,"sections":[[5,4,[]]]}})", // 缺 v
      R"({"v":1,"hbcVersion":96,"layout":{"counts":19}})", // 缺 sections
      R"({"v":1,"hbcVersion":96,"layout":{"sections":[[5,4,[]]]}})", // 缺 counts
      R"({"v":1,"hbcVersion":96,"layout":{"counts":19,"sections":[]}})", // 空 sections
      R"({"v":1,"hbcVersion":96,"layout":{"counts":0,"sections":[[5,4,[]]]}})", // counts=0
      R"({"v":1,"hbcVersion":96,"layout":[1,2]})", // layout 非对象
      // 尾部多余内容
      R"({"v":1,"hbcVersion":96,"layout":{"counts":19,"sections":[[5,4,[]]]}} x)",
      // 键含转义(本格式的键不允许反斜杠;raw string 里 \x 就是两个字符)
      R"({"v\x":1,"v":1,"hbcVersion":96,"layout":{"counts":19,"sections":[[5,4,[]]]}})",
      // ParseUInt 溢出(>0xffffffff)与负数
      R"({"v":4294967296,"hbcVersion":96,"layout":{"counts":19,"sections":[[5,4,[]]]}})",
      R"({"v":-1,"hbcVersion":96,"layout":{"counts":19,"sections":[[5,4,[]]]}})",
      // 位域语义:CP2-1 的 bit 溢出、bit+bits>32、bits=0、bits=33
      R"({"v":1,"hbcVersion":96,"layout":{"counts":19,"sections":[[5,4,[[0,4294967295,1]]]]}})",
      R"({"v":1,"hbcVersion":96,"layout":{"counts":19,"sections":[[5,4,[[0,31,2]]]]}})",
      R"({"v":1,"hbcVersion":96,"layout":{"counts":19,"sections":[[5,4,[[0,0,0]]]]}})",
      R"({"v":1,"hbcVersion":96,"layout":{"counts":19,"sections":[[5,4,[[0,0,33]]]]}})",
      // delta field 元组长度不对
      R"({"v":1,"hbcVersion":96,"layout":{"counts":19,"sections":[[5,4,[[0,0]]]]}})",
  };
  for (const char* json : rejects) {
    HbcTransformMeta meta;
    if (ParseHbcTransformMeta(json, &meta)) {
      std::fprintf(stderr, "FAIL: wire parser accepted: %s\n", json);
      ++g_failures;
    }
  }

  // 负向:输入尺寸上限(64KB)
  {
    std::string huge = minimal;
    huge.insert(1, std::string(65 * 1024, ' '));
    HbcTransformMeta meta;
    CHECK(!ParseHbcTransformMeta(huge, &meta));
  }
  // 负向:未知键的值嵌套深度超限(kMaxDepth=8)
  {
    std::string deep = R"({"v":1,"hbcVersion":96,"x":)";
    for (int i = 0; i < 12; ++i) deep += '[';
    deep += '1';
    for (int i = 0; i < 12; ++i) deep += ']';
    deep += ',' + minimalLayout + "}";
    HbcTransformMeta meta;
    CHECK(!ParseHbcTransformMeta(deep, &meta));
  }
  // 负向:sections 超过 64 个
  {
    std::string many = R"({"v":1,"hbcVersion":96,"layout":{"counts":19,"sections":[)";
    for (int i = 0; i < 65; ++i) {
      if (i) many += ',';
      many += "[5,4,[]]";
    }
    many += "]}}";
    HbcTransformMeta meta;
    CHECK(!ParseHbcTransformMeta(many, &meta));
  }
  // 负向:单段 deltaFields 超过 8 个
  {
    std::string many = R"({"v":1,"hbcVersion":96,"layout":{"counts":19,"sections":[[5,64,[)";
    for (int i = 0; i < 9; ++i) {
      if (i) many += ',';
      many += "[0,0,8]";
    }
    many += "]]]}}";
    HbcTransformMeta meta;
    CHECK(!ParseHbcTransformMeta(many, &meta));
  }
}

} // namespace

int main(int argc, char** argv) {
  std::string fixturesDir = "cpp/patch_core/tests/fixtures/";
  if (argc > 1) {
    fixturesDir = argv[1];
    if (!fixturesDir.empty() && fixturesDir.back() != '/') {
      fixturesDir += '/';
    }
  }

  TestGoldenPair(fixturesDir, "v96.hbc", "v96.t.hbc", kLayoutV96);
  TestGoldenPair(fixturesDir, "v98.hbc", "v98.t.hbc", kLayoutV98);
  TestGoldenPair(fixturesDir, "v98b.hbc", "v98b.t.hbc", kLayoutV98Late);
  TestRejections(fixturesDir);
  TestWireParser(fixturesDir);

  // 变体互斥:19 槽布局作用于 20 槽文件(或反之)必须被结构校验拒绝
  {
    std::vector<uint8_t> late = ReadFileOrDie(fixturesDir + "v98b.hbc");
    CHECK(!TransformHbcInPlace(late.data(), late.size(), kLayoutV98, false));
    std::vector<uint8_t> early = ReadFileOrDie(fixturesDir + "v98.hbc");
    CHECK(
        !TransformHbcInPlace(early.data(), early.size(), kLayoutV98Late, false));
  }

  if (g_failures > 0) {
    std::fprintf(stderr, "hbc_transform_test: %d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("hbc_transform_test: all checks passed\n");
  return 0;
}
