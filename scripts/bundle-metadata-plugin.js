const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
console.log(`[Bundle Metadata] Project root: ${PROJECT_ROOT}`);

function calculateContentHash(bundleCode) {
  const hash = crypto.createHash('sha256');
  hash.update(bundleCode, 'utf8');
  return hash.digest('hex');
}

function generateMetadataInjection(contentHash) {
  return `// Auto-injected bundle metadata by Metro plugin
  var __BUNDLE_METADATA__ = {
    contentHash: '${contentHash}'
  };
`;
}

function generateMetadataComment(contentHash) {
  return `\n//# BUNDLE_METADATA ${JSON.stringify({
  contentHash
})}`;
}

function setupSingleHermesc(hermescPath, locationName) {
  const hermescDir = path.dirname(hermescPath);
  const backupHermescPath = path.join(hermescDir, '_hermesc');
  const wrapperSourcePath = path.join(__dirname, 'hermesc-wrapper.js');

  if (fs.existsSync(backupHermescPath)) {
    console.log(`⏭️  [Hermesc Setup] ${locationName} already configured, skipping...`);
    return true;
  }

  if (!fs.existsSync(hermescPath)) {
    console.log(`ℹ️  [Hermesc Setup] ${locationName} hermesc not found at: ${hermescPath}`);
    return false;
  }

  if (!fs.existsSync(wrapperSourcePath)) {
    console.error(`❌ [Hermesc Setup] Wrapper script not found at: ${wrapperSourcePath}`);
    return false;
  }

  try {
    console.log(`🔧 [Hermesc Setup] Setting up hermesc wrapper for ${locationName}...`);

    fs.renameSync(hermescPath, backupHermescPath);
    console.log(`✅ [Hermesc Setup] ${locationName}: Renamed hermesc -> _hermesc`);

    const shellScript = `#!/bin/bash
# Hermesc wrapper script - auto-generated
# This script calls the Node.js wrapper which handles post-processing

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WRAPPER_SCRIPT="${wrapperSourcePath}"

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi

  local NODE_PATHS=(
    "/usr/local/bin/node"
    "/opt/homebrew/bin/node"
    "$HOME/.nvm/versions/node/$(ls -t "$HOME/.nvm/versions/node" 2>/dev/null | head -1)/bin/node"
    "/usr/bin/node"
  )

  for node_path in "\${NODE_PATHS[@]}"; do
    if [ -x "$node_path" ]; then
      echo "$node_path"
      return 0
    fi
  done

  echo "Error: node executable not found" >&2
  echo "Please ensure Node.js is installed and accessible" >&2
  exit 1
}

NODE_BIN=$(find_node)
exec "$NODE_BIN" "$WRAPPER_SCRIPT" "$@"
`;

    fs.writeFileSync(hermescPath, shellScript, { mode: 0o755 });
    console.log(`✅ [Hermesc Setup] ${locationName}: Created hermesc wrapper shell script`);

    console.log(`🎉 [Hermesc Setup] ${locationName} configured successfully!`);
    console.log(`📋 [Hermesc Setup] ${locationName} details:`);
    console.log(`   - Original: ${backupHermescPath}`);
    console.log(`   - Wrapper: ${hermescPath}`);
    console.log(`   - Handler: ${wrapperSourcePath}`);

    return true;
  } catch (error) {
    console.error(`❌ [Hermesc Setup] Failed to setup hermesc wrapper for ${locationName}:`, error);

    if (fs.existsSync(backupHermescPath) && !fs.existsSync(hermescPath)) {
      try {
        fs.renameSync(backupHermescPath, hermescPath);
        console.log(`🔄 [Hermesc Setup] ${locationName}: Rolled back changes`);
      } catch (rollbackError) {
        console.error(`❌ [Hermesc Setup] ${locationName}: Rollback failed:`, rollbackError);
      }
    }

    return false;
  }
}

function setupHermescWrapper() {
  const wrapperSourcePath = path.join(__dirname, 'hermesc-wrapper.js');

  if (!fs.existsSync(wrapperSourcePath)) {
    console.error(`❌ [Hermesc Setup] Wrapper script not found at: ${wrapperSourcePath}`);
    return;
  }

  try {
    fs.chmodSync(wrapperSourcePath, 0o755);
  } catch (error) {
    console.error('❌ [Hermesc Setup] Failed to set execute permissions on wrapper:', error);
  }

  console.log('🔧 [Hermesc Setup] Starting hermesc wrapper setup...');

  // 使用项目根目录来定位 hermesc
  const hermescLocations = [
    {
      path: path.join(PROJECT_ROOT, 'node_modules/react-native/sdks/hermesc/osx-bin/hermesc'),
      name: 'Node Modules'
    },
    {
      path: path.join(PROJECT_ROOT, 'ios/Pods/hermes-engine/destroot/bin/hermesc'),
      name: 'iOS Pods'
    }
  ];

  console.log('😁hermescLocations', hermescLocations);
  let successCount = 0;
  let totalProcessed = 0;

  for (const location of hermescLocations) {
    const success = setupSingleHermesc(location.path, location.name);
    if (success) {
      successCount++;
    }
    totalProcessed++;
  }

  console.log(`\n📊 [Hermesc Setup] Summary: ${successCount}/${totalProcessed} locations configured successfully`);
}

function metadataSerializer(entryPoint, preModules, graph, options) {
  console.log('😁metadataSerializer - Starting bundle serialization');
  setupHermescWrapper();
  const baseJSBundle = require('metro/src/DeltaBundler/Serializers/baseJSBundle');
  const bundleToString = require('metro/src/lib/bundleToString');
  const bundle = baseJSBundle(entryPoint, preModules, graph, options);
  const { code: bundleCode } = bundleToString(bundle);
  const contentHash = calculateContentHash(bundleCode);
  const metadataInjection = generateMetadataInjection(contentHash);
  const metadataComment = generateMetadataComment(contentHash);

  // hash 文件保存在项目根目录
  const hashFilePath = path.join(PROJECT_ROOT, 'bundle-hash.json');

  try {
    const hashData = {
      contentHash,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(hashFilePath, JSON.stringify(hashData, null, 2));
    console.log(`✅ [Metro] Saved hash to: ${hashFilePath}`);
    console.log(`🔐 [Metro] Hash: ${contentHash.slice(0, 16)}...`);
  } catch (error) {
    console.error('❌ [Metro] Failed to save hash file:', error);
  }

  return bundleCode + metadataInjection + metadataComment;
}

module.exports = {
  metadataSerializer,
};
