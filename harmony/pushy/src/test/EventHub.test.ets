import { describe, it, expect, beforeEach } from '@ohos/hypium';
import { EventHub } from '../main/ets/EventHub';

export default function eventHubTest() {
  describe('EventHub', () => {
    it('is a singleton', 0, () => {
      const a = EventHub.getInstance();
      const b = EventHub.getInstance();
      expect(a === b).assertEqual(true);
    });

    it('does not throw when emitting without rnInstance', 0, () => {
      const hub = EventHub.getInstance();
      hub.setRNInstance(undefined);
      let threw = false;
      try {
        hub.emit('test', { foo: 'bar' });
      } catch {
        threw = true;
      }
      expect(threw).assertEqual(false);
    });

    it('calls emitDeviceEvent on rnInstance when set', 0, () => {
      const hub = EventHub.getInstance();
      let capturedEvent = '';
      let capturedData: any = null;
      const mockRnInstance = {
        emitDeviceEvent(event: string, data: any) {
          capturedEvent = event;
          capturedData = data;
        },
      };
      hub.setRNInstance(mockRnInstance);
      hub.emit('RCTPushyDownloadProgress', { received: 100, total: 200 });
      expect(capturedEvent).assertEqual('RCTPushyDownloadProgress');
      expect(capturedData.received).assertEqual(100);
      expect(capturedData.total).assertEqual(200);
      hub.setRNInstance(undefined);
    });

    it('on/off manages listeners', 0, () => {
      const hub = EventHub.getInstance();
      let callCount = 0;
      const callback = () => { callCount++; };
      hub.on('test-event', callback);
      hub.off('test-event', callback);
      expect(callCount).assertEqual(0);
    });
  });
}
