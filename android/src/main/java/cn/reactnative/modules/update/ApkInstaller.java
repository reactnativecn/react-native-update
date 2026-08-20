package cn.reactnative.modules.update;

import android.Manifest;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Process;
import android.provider.Settings;
import android.util.Log;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import java.io.File;
import java.io.FileInputStream;
import java.io.OutputStream;
import java.util.concurrent.ConcurrentHashMap;

final class ApkInstaller {
    private static final int COPY_BUFFER_SIZE = 64 * 1024;
    private static final String SESSION_ID_EXTRA =
        "cn.reactnative.modules.update.extra.PACKAGE_INSTALLER_SESSION_ID";
    private static final ConcurrentHashMap<Integer, Promise> pendingPromises =
        new ConcurrentHashMap<Integer, Promise>();

    private ApkInstaller() {
    }

    static boolean ensureInstallPermission(
        ReactApplicationContext reactContext,
        Promise promise
    ) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
            promise.reject(
                ErrorCodes.UNSUPPORTED_PLATFORM,
                "APK installation requires Android 5.0 or newer"
            );
            return false;
        }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return true;
        }

        PackageManager packageManager = reactContext.getPackageManager();
        if (!declaresInstallPermission(reactContext, packageManager)) {
            promise.reject(
                ErrorCodes.APK_INSTALL_PERMISSION_REQUIRED,
                "Declare android.permission.REQUEST_INSTALL_PACKAGES in AndroidManifest.xml"
            );
            return false;
        }

        try {
            if (packageManager.canRequestPackageInstalls()) {
                return true;
            }

            Intent settingsIntent = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + reactContext.getPackageName())
            );
            settingsIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            reactContext.startActivity(settingsIntent);
            promise.reject(
                ErrorCodes.APK_INSTALL_PERMISSION_REQUIRED,
                "Allow this app to install unknown apps in system settings, then retry"
            );
        } catch (Throwable error) {
            promise.reject(
                ErrorCodes.APK_INSTALL_PERMISSION_REQUIRED,
                "Unable to open the unknown app sources settings",
                error
            );
        }
        return false;
    }

    private static boolean declaresInstallPermission(
        Context context,
        PackageManager packageManager
    ) {
        try {
            PackageInfo packageInfo = packageManager.getPackageInfo(
                context.getPackageName(),
                PackageManager.GET_PERMISSIONS
            );
            String[] requestedPermissions = packageInfo.requestedPermissions;
            if (requestedPermissions == null) {
                return false;
            }
            for (String permission : requestedPermissions) {
                if (Manifest.permission.REQUEST_INSTALL_PACKAGES.equals(permission)) {
                    return true;
                }
            }
        } catch (PackageManager.NameNotFoundException error) {
            Log.e(UpdateContext.TAG, "Unable to inspect requested permissions", error);
        }
        return false;
    }

    static void install(
        ReactApplicationContext reactContext,
        File apkFile,
        String sourceUrl,
        Promise promise
    ) {
        if (!apkFile.isFile() || apkFile.length() <= 0) {
            promise.reject(ErrorCodes.APK_INSTALL_FAILED, "Downloaded APK is empty or missing");
            return;
        }

        PackageInstaller packageInstaller = reactContext
            .getPackageManager()
            .getPackageInstaller();
        PackageInstaller.SessionParams sessionParams = new PackageInstaller.SessionParams(
            PackageInstaller.SessionParams.MODE_FULL_INSTALL
        );
        sessionParams.setAppPackageName(reactContext.getPackageName());
        sessionParams.setSize(apkFile.length());
        if (sourceUrl != null && !sourceUrl.isEmpty()) {
            sessionParams.setOriginatingUri(Uri.parse(sourceUrl));
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            sessionParams.setOriginatingUid(Process.myUid());
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            sessionParams.setInstallReason(PackageManager.INSTALL_REASON_USER);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            sessionParams.setRequireUserAction(
                PackageInstaller.SessionParams.USER_ACTION_REQUIRED
            );
        }

        int sessionId = -1;
        boolean committed = false;
        try {
            sessionId = packageInstaller.createSession(sessionParams);
            try (
                PackageInstaller.Session session = packageInstaller.openSession(sessionId);
                FileInputStream input = new FileInputStream(apkFile);
                OutputStream output = session.openWrite("base.apk", 0, apkFile.length())
            ) {
                byte[] buffer = new byte[COPY_BUFFER_SIZE];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    output.write(buffer, 0, count);
                }
                session.fsync(output);

                Intent statusIntent = new Intent(
                    reactContext,
                    PackageInstallerStatusReceiver.class
                );
                statusIntent.putExtra(SESSION_ID_EXTRA, sessionId);
                int pendingIntentFlags = PendingIntent.FLAG_UPDATE_CURRENT;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    pendingIntentFlags |= PendingIntent.FLAG_MUTABLE;
                }
                PendingIntent statusPendingIntent = PendingIntent.getBroadcast(
                    reactContext,
                    sessionId,
                    statusIntent,
                    pendingIntentFlags
                );
                pendingPromises.put(sessionId, promise);
                session.commit(statusPendingIntent.getIntentSender());
                committed = true;
            }
        } catch (Throwable error) {
            if (sessionId != -1) {
                pendingPromises.remove(sessionId);
                if (!committed) {
                    try {
                        packageInstaller.abandonSession(sessionId);
                    } catch (Throwable abandonError) {
                        Log.w(UpdateContext.TAG, "Unable to abandon failed install session", abandonError);
                    }
                }
            }
            promise.reject(ErrorCodes.APK_INSTALL_FAILED, "Unable to stage APK installation", error);
        }
    }

    static void handleStatus(Context context, Intent intent) {
        int sessionId = intent.getIntExtra(SESSION_ID_EXTRA, -1);
        int status = intent.getIntExtra(
            PackageInstaller.EXTRA_STATUS,
            PackageInstaller.STATUS_FAILURE
        );

        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirmationIntent = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirmationIntent == null) {
                rejectPending(sessionId, "System installer did not provide a confirmation screen");
                return;
            }
            try {
                confirmationIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(confirmationIntent);
                resolvePending(sessionId);
            } catch (Throwable error) {
                rejectPending(sessionId, "Unable to open the system install confirmation", error);
            }
            return;
        }

        if (status == PackageInstaller.STATUS_SUCCESS) {
            resolvePending(sessionId);
            return;
        }

        String statusMessage = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        rejectPending(
            sessionId,
            statusMessage == null ? "Package installation failed" : statusMessage
        );
    }

    private static void resolvePending(int sessionId) {
        Promise promise = pendingPromises.remove(sessionId);
        if (promise != null) {
            promise.resolve(null);
        }
    }

    private static void rejectPending(int sessionId, String message) {
        rejectPending(sessionId, message, null);
    }

    private static void rejectPending(int sessionId, String message, Throwable error) {
        Promise promise = pendingPromises.remove(sessionId);
        if (promise != null) {
            if (error == null) {
                promise.reject(ErrorCodes.APK_INSTALL_FAILED, message);
            } else {
                promise.reject(ErrorCodes.APK_INSTALL_FAILED, message, error);
            }
        } else {
            Log.e(UpdateContext.TAG, message, error);
        }
    }
}
