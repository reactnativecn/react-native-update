import { describe, beforeAll, it, expect } from '@ohos/hypium';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { abilityDelegatorRegistry } from '@kit.TestKit';

const TAG = 'AbilityTest';
const delegator = abilityDelegatorRegistry.getAbilityDelegator();

export default function abilityTest() {
  describe('AbilityLaunchTest', () => {
    beforeAll(async () => {
      hilog.info(0x0000, TAG, 'AbilityLaunchTest beforeAll');
      const want = {
        bundleName: 'com.example.harmony_use_pushy',
        abilityName: 'EntryAbility',
      };
      await delegator.startAbility(want);
      // Allow the RN surface time to initialize
      await new Promise<void>(resolve => setTimeout(resolve, 3000));
    });

    it('ability should launch successfully', 0, async () => {
      hilog.info(0x0000, TAG, 'checking ability launch');
      const currentAbility = delegator.getCurrentTopAbility();
      expect(currentAbility).assertNotNull();
      hilog.info(0x0000, TAG, 'ability launched: %{public}s', JSON.stringify(currentAbility.context?.abilityInfo?.name));
    });

    it('ability context should have valid filesDir', 0, async () => {
      const currentAbility = delegator.getCurrentTopAbility();
      const context = currentAbility.context;
      expect(context).assertNotNull();
      expect(context.filesDir).assertContain('/files');
      hilog.info(0x0000, TAG, 'filesDir: %{public}s', context.filesDir);
    });
  });
}
