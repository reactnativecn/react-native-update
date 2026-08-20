package cn.reactnative.modules.update;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class PackageInstallerStatusReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        ApkInstaller.handleStatus(context, intent);
    }
}
