const fs = require('fs');

/**
 * 从 Hermes 字节码文件中读取 metadata
 * 支持两种方式：
 * 1. 从文件末尾的自定义 Meta 块读取（新方式，推荐）
 * 2. 从 Hermes -meta 参数注入的数据读取（旧方式，备用）
 */
function readBundleMetadata(filePath) {
  const buffer = fs.readFileSync(filePath);

  // 优先尝试从文件末尾的自定义 Meta 块读取
  const metaFromFooter = readMetadataFromHBCFooter(buffer);
  if (metaFromFooter) {
    return metaFromFooter;
  }

  // 如果末尾没有 Meta 块，尝试从 Hermes -meta 参数注入的数据读取（备用方案）
  console.log('No metadata footer found, trying to read from Hermes -meta parameter...');
  return readMetadataFromHermesMeta(buffer);
}

/**
 * 从 HBC 文件末尾的自定义 Meta 块读取元数据
 * 格式: [原始HBC][MAGIC_START][LENGTH][JSON_DATA][MAGIC_END]
 */
function readMetadataFromHBCFooter(buffer) {
  const MAGIC = Buffer.from('RNUPDATE', 'utf8'); // 8 bytes
  const MAGIC_SIZE = 8;
  const LENGTH_SIZE = 4;

  console.log(`\n[DEBUG] Reading metadata from HBC footer...`);
  console.log(`[DEBUG] File size: ${buffer.length} bytes`);
  console.log(`[DEBUG] Last 100 bytes (hex): ${buffer.slice(-100).toString('hex')}`);
  console.log(`[DEBUG] Last 50 bytes (utf8): ${buffer.slice(-50).toString('utf8', 0, 50).replace(/[^\x20-\x7E]/g, '.')}`);

  // 检查文件是否足够大以包含 meta 块
  // 最小大小: MAGIC_START(8) + LENGTH(4) + JSON(至少2字节"{}") + MAGIC_END(8) = 22 bytes
  if (buffer.length < 22) {
    console.log(`[DEBUG] File too small: ${buffer.length} < 22`);
    return null;
  }

  // 从文件末尾向前查找最后一个 MAGIC_END
  const lastMagicIndex = buffer.lastIndexOf(MAGIC);

  console.log(`[DEBUG] MAGIC string: "${MAGIC.toString('utf8')}"`);
  console.log(`[DEBUG] Last MAGIC index: ${lastMagicIndex}`);

  if (lastMagicIndex === -1) {
    console.log(`[DEBUG] MAGIC not found in file`);
    return null;
  }

  // MAGIC_END 应该在文件末尾
  console.log(`[DEBUG] Expected MAGIC_END at: ${buffer.length - MAGIC_SIZE}`);
  console.log(`[DEBUG] Found MAGIC_END at: ${lastMagicIndex}`);

  if (lastMagicIndex + MAGIC_SIZE !== buffer.length) {
    console.warn(`⚠️  Found MAGIC but not at file end (expected ${buffer.length - MAGIC_SIZE}, found ${lastMagicIndex})`);
    return null;
  }

  // 计算 MAGIC_START 的位置
  // 从 MAGIC_END 向前：MAGIC_END(8) + JSON(?) + LENGTH(4) + MAGIC_START(8)
  const magicEndStart = lastMagicIndex;

  // 读取长度字段（在 MAGIC_END 之前的 4 字节）
  const lengthStart = magicEndStart - LENGTH_SIZE;
  if (lengthStart < MAGIC_SIZE) {
    console.log(`[DEBUG] lengthStart too small: ${lengthStart} < ${MAGIC_SIZE}`);
    return null; // 文件太小
  }

  const jsonLength = buffer.readUInt32LE(lengthStart);
  console.log(`[DEBUG] JSON length from buffer: ${jsonLength}`);

  // 验证长度是否合理（JSON 数据应该小于 10KB）
  if (jsonLength > 10240 || jsonLength < 2) {
    console.warn(`⚠️  Invalid JSON length: ${jsonLength}`);
    return null;
  }

  // 计算 JSON 数据的起始位置
  const jsonStart = lengthStart - jsonLength;
  console.log(`[DEBUG] JSON start position: ${jsonStart}`);
  if (jsonStart < MAGIC_SIZE) {
    console.log(`[DEBUG] jsonStart too small: ${jsonStart} < ${MAGIC_SIZE}`);
    return null;
  }

  // 验证 MAGIC_START
  const magicStartPos = jsonStart - MAGIC_SIZE;
  console.log(`[DEBUG] MAGIC_START position: ${magicStartPos}`);
  const magicStart = buffer.slice(magicStartPos, jsonStart);
  console.log(`[DEBUG] MAGIC_START bytes: ${magicStart.toString('hex')}`);
  console.log(`[DEBUG] Expected MAGIC bytes: ${MAGIC.toString('hex')}`);

  if (!magicStart.equals(MAGIC)) {
    console.warn('⚠️  MAGIC_START mismatch');
    console.warn(`    Expected: ${MAGIC.toString('hex')}`);
    console.warn(`    Got: ${magicStart.toString('hex')}`);
    return null;
  }

  // 读取 JSON 数据
  try {
    const jsonBuffer = buffer.slice(jsonStart, lengthStart);
    const jsonString = jsonBuffer.toString('utf8');
    console.log(`[DEBUG] JSON string: ${jsonString}`);
    const metadata = JSON.parse(jsonString);

    console.log(`✅ Found metadata in HBC footer: contentHash=${metadata.contentHash?.slice(0, 16)}...`);
    console.log(`   Metadata: ${JSON.stringify(metadata, null, 2)}`);

    return metadata;
  } catch (error) {
    console.error('❌ Failed to parse metadata JSON:', error);
    return null;
  }
}

/**
 * 从 Hermes -meta 参数注入的数据读取（备用方案）
 */
function readMetadataFromHermesMeta(buffer) {
  const metadata = {};
  const searchPattern = Buffer.from('contentHash=', 'utf8');

  // 在整个文件中查找模式
  let index = buffer.indexOf(searchPattern);

  if (index !== -1) {
    // 找到了 "contentHash="，读取后面的 hash 值
    const hashStart = index + searchPattern.length;

    // Hash 应该是 64 个十六进制字符 (SHA256)
    let hashEnd = hashStart;
    while (hashEnd < buffer.length && hashEnd < hashStart + 64) {
      const byte = buffer[hashEnd];
      // 检查是否是有效的十六进制字符 (0-9, a-f, A-F)
      if ((byte >= 48 && byte <= 57) ||   // 0-9
          (byte >= 97 && byte <= 102) ||  // a-f
          (byte >= 65 && byte <= 70)) {   // A-F
        hashEnd++;
      } else {
        break;
      }
    }

    if (hashEnd > hashStart) {
      metadata.contentHash = buffer.toString('utf8', hashStart, hashEnd);
      console.log(`✅ Found contentHash in Hermes -meta: ${metadata.contentHash.slice(0, 16)}...`);
    }
  } else {
    console.warn('⚠️  contentHash not found in Hermes -meta parameter');
  }

  return metadata;
}

/**
 * 从普通 JS bundle 的注释中读取 metadata
 */
function readMetadataFromJSBundle(buffer) {
  const content = buffer.toString('utf8');
  const metadata = {};

  // 查找 //# BUNDLE_METADATA {...} 注释
  const metaMatch = content.match(/\/\/# BUNDLE_METADATA\s+(\{[^}]+\})/);
  if (metaMatch) {
    try {
      const metaObj = JSON.parse(metaMatch[1]);
      metadata.contentHash = metaObj.contentHash;
      console.log(`✅ Found contentHash in JS bundle comment: ${metadata.contentHash.slice(0, 16)}...`);
    } catch (e) {
      console.error('Failed to parse BUNDLE_METADATA comment:', e);
    }
  } else {
    console.warn('⚠️  BUNDLE_METADATA comment not found in JS bundle');
  }

  return metadata;
}

// 测试读取
const metadata = readBundleMetadata('./index.bundlejs');
console.log('Final metadata:', metadata);