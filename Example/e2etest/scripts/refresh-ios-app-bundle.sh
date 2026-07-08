#!/usr/bin/env bash
#
# 在缓存命中的 .app 里重新注入当前源码的 JS bundle + assets,跳过整个
# pod install + xcodebuild(native 输入没变时它们只会产出同样的二进制)。
# 复刻 react-native-xcode.sh 的 release 流程:metro bundle → hermesc
# (-emit-binary -max-diagnostic-width=80 -O)。模拟器 app 不做签名校验,
# 替换资源后可直接安装运行;注入结果由 e2e 套件本身验证(BINARY_BASE
# 断言 + 完整更新流)。
set -euo pipefail

cd "$(dirname "$0")/.."

APP=ios/build/Build/Products/Release-iphonesimulator/AwesomeProject.app
# 构建后由 workflow 从 Pods/hermes-engine 拷贝进缓存区(缓存命中时无 Pods)
HERMESC=ios/build/hermesc

if [ ! -d "$APP" ]; then
  echo "error: cached app not found: $APP" >&2
  exit 1
fi
if [ ! -x "$HERMESC" ]; then
  echo "error: cached hermesc not found: $HERMESC" >&2
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

bunx react-native bundle \
  --platform ios \
  --dev false \
  --entry-file index.js \
  --bundle-output "$TMP/main.jsbundle" \
  --assets-dest "$APP"

"$HERMESC" -emit-binary -max-diagnostic-width=80 -O \
  -out "$APP/main.jsbundle" "$TMP/main.jsbundle"

echo "refreshed JS bundle in $APP"
