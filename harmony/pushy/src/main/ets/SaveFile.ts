import resourceManager from '@ohos.resourceManager';
import fs, { ReadOptions } from '@ohos.file.fs';

export const saveFileToSandbox = (
  from: resourceManager.RawFileDescriptor,
  toPath: string,
) => {
  let to = fs.openSync(toPath, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE);

  let bufferSize = 30000;
  let buffer = new ArrayBuffer(bufferSize); // 创建buffer缓冲区
  // 要copy的文件的offset和length
  let currentOffset = from.offset;
  let readOption: ReadOptions = {
    offset: currentOffset, // 期望读取文件的位置。可选，默认从当前位置开始读
    length: bufferSize, // 每次期望读取数据的长度。可选，默认缓冲区长度
  };
  // 后面len会一直减，直到没有
  while (true) {
    // 读取buffer容量的内容
    let readLength = fs.readSync(from.fd, buffer, readOption);
    // 写入buffer容量的内容
    fs.writeSync(to.fd, buffer, { length: readLength });
    // 判断后续内容，修改读文件的参数
    // buffer没读满代表文件读完了
    if (readLength < bufferSize) {
      break;
    }
    if (readOption.offset) {
      readOption.offset += readLength;
    }
  }
  fs.close(to);
};
