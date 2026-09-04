# JNI-constructed result classes: cpp/patch_core/update_core_android.cpp
# resolves them by FindClass + GetMethodID("<init>") + GetFieldID, so the
# no-arg constructor and every field must survive shrinking with their names
# (a -keepnames rule alone lets R8 strip the unreferenced constructor/fields).
-keep class cn.reactnative.modules.update.StateCoreResult { <init>(); <fields>; }
-keep class cn.reactnative.modules.update.ArchivePatchPlanResult { <init>(); <fields>; }
-keep class cn.reactnative.modules.update.CopyGroupResult { <init>(); <fields>; }

# JNI entry points are bound by their mangled Java names.
-keepclasseswithmembernames class cn.reactnative.modules.update.** {
    native <methods>;
}

# Instantiated by React Native / Expo / the system by name.
-keep class cn.reactnative.modules.update.UpdateModule { *; }
-keep class cn.reactnative.modules.update.UpdatePackage { *; }
-keep class cn.reactnative.modules.update.PackageInstallerStatusReceiver { *; }
-keep class expo.modules.pushy.** { *; }

# Reflection targets of ReactReloadManager / UpdateEventEmitter. Only the
# members looked up by name are pinned; React Native's own consumer rules
# decide what else of com.facebook.react.** survives.
-keepclassmembers class com.facebook.react.ReactInstanceManager {
    *** mBundleLoader;
    *** bundleLoader;
    *** mJSBundleFile;
    *** jsBundleFile;
}
-keepclassmembers class com.facebook.react.ReactActivity {
    *** getReactDelegate();
}
-keepclassmembers class com.facebook.react.ReactDelegate {
    *** mReactHost;
    *** reactHost;
}
-keepclassmembers class com.facebook.react.ReactNativeHost {
    *** getBundleAssetName();
    *** isNewArchEnabled();
}
-keepclassmembers class * extends com.facebook.react.ReactNativeHost {
    *** getBundleAssetName();
    *** isNewArchEnabled();
}
-keepclassmembers class com.facebook.react.runtime.ReactHostImpl {
    *** mUseDevSupport;
    *** useDevSupport;
    *** mReactHostDelegate;
    *** reactHostDelegate;
    *** reload(java.lang.String);
}
# reload(String) returns TaskInterface<Void> (not void) and is looked up on
# the runtime class of whatever ReactHost the app provides; the `***` return
# type is what makes the rule match — verified against an R8-minified
# RN 0.85 build, where `void reload(...)` silently kept nothing.
-keepclassmembers class * implements com.facebook.react.ReactHost {
    *** reload(java.lang.String);
}
-keepclassmembers class * implements com.facebook.react.runtime.ReactHostDelegate {
    *** jsBundleLoader;
    *** _jsBundleLoader;
}
-keepclassmembers class * implements com.facebook.react.ReactApplication {
    *** getReactHost();
}
-keepclassmembers class com.facebook.react.bridge.ReactContext {
    *** hasActiveReactInstance();
}
# The host app's BuildConfig is located by name (Class.forName) and its
# new-architecture flag read by reflection.
-keep class **.BuildConfig {
    public static boolean IS_NEW_ARCHITECTURE_ENABLED;
}

-keepnames class expo.modules.ExpoReactHostFactory$ExpoReactHostDelegate { *; }
