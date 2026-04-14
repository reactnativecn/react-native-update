import { describe, it, expect } from '@ohos/hypium';
import { DownloadTaskParams } from '../main/ets/DownloadTaskParams';

export default function downloadTaskParamsTest() {
  describe('DownloadTaskParams', () => {
    it('has correct task type constants', 0, () => {
      expect(DownloadTaskParams.TASK_TYPE_CLEANUP).assertEqual(0);
      expect(DownloadTaskParams.TASK_TYPE_PATCH_FULL).assertEqual(1);
      expect(DownloadTaskParams.TASK_TYPE_PATCH_FROM_APP).assertEqual(2);
      expect(DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK).assertEqual(3);
      expect(DownloadTaskParams.TASK_TYPE_PLAIN_DOWNLOAD).assertEqual(4);
    });

    it('has correct default values', 0, () => {
      const params = new DownloadTaskParams();
      expect(params.type).assertEqual(DownloadTaskParams.TASK_TYPE_CLEANUP);
      expect(params.url).assertEqual('');
      expect(params.hash).assertEqual('');
      expect(params.originHash).assertEqual('');
      expect(params.targetFile).assertEqual('');
      expect(params.unzipDirectory).assertEqual('');
      expect(params.originDirectory).assertEqual('');
    });

    it('allows setting all fields', 0, () => {
      const params = new DownloadTaskParams();
      params.type = DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK;
      params.url = 'https://example.com/patch.ppk';
      params.hash = 'abc123';
      params.originHash = 'def456';
      params.targetFile = '/data/patch.ppk';
      params.unzipDirectory = '/data/abc123';
      params.originDirectory = '/data/def456';

      expect(params.type).assertEqual(3);
      expect(params.url).assertEqual('https://example.com/patch.ppk');
      expect(params.hash).assertEqual('abc123');
      expect(params.originHash).assertEqual('def456');
      expect(params.targetFile).assertEqual('/data/patch.ppk');
      expect(params.unzipDirectory).assertEqual('/data/abc123');
      expect(params.originDirectory).assertEqual('/data/def456');
    });
  });
}
