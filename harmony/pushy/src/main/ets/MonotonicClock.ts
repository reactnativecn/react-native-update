import { systemDateTime } from '@kit.BasicServicesKit';

// Absolute deadlines must not use Date.now(): automatic time synchronization
// can move the wall clock while the cold-start rescue round is running.
//
// TimeType.ACTIVE (not STARTUP) is the semantic match for the other two
// platforms: iOS NSProcessInfo.systemUptime and Android System.nanoTime both
// stop during deep sleep, so a device that sleeps mid-download resumes with
// its budget intact. STARTUP keeps counting through sleep and would abort a
// rescue that the same network completes on iOS/Android.
export function monotonicNowMs(): number {
  return systemDateTime.getUptime(systemDateTime.TimeType.ACTIVE);
}
