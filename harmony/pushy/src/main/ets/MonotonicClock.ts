import { systemDateTime } from '@kit.BasicServicesKit';

// Absolute deadlines must not use Date.now(): automatic time synchronization
// can move the wall clock while the cold-start rescue round is running.
export function monotonicNowMs(): number {
  return systemDateTime.getUptime(systemDateTime.TimeType.STARTUP);
}
