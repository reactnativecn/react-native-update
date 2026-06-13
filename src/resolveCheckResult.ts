import { currentVersion, packageVersion } from './core';
import { isInRollout } from './isInRollout';
import { CheckResult } from './type';
import { log } from './utils';

export function resolveCheckResult(rootInfo: CheckResult): CheckResult {
  const { expVersion, ...rootResult } = rootInfo;
  const rollout = expVersion?.config?.rollout?.[packageVersion];
  if (rootResult.update && expVersion && typeof rollout === 'number') {
    if (isInRollout(rollout)) {
      log(`${expVersion.name} in ${rollout}% rollout, continue`);
      if (expVersion.hash === currentVersion) {
        return { upToDate: true };
      }
      const info: CheckResult = {
        update: true,
        ...expVersion,
      };
      if (rootResult.paths) {
        info.paths = rootResult.paths;
      }
      return info;
    }
    log(`${expVersion.name} not in ${rollout}% rollout, ignored`);
  }
  if (rootResult.update && rootResult.hash === currentVersion) {
    return { upToDate: true };
  }
  return rootResult;
}
