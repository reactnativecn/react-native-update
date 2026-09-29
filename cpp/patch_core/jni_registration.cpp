// Registers the Android native methods from JNI_OnLoad instead of exporting
// Java_<package>_<class>_<method> symbols: the shared library then exports only
// JNI_OnLoad, and the class names, method names and signatures used for
// registration are stored encoded (obscured_text.h,
// scripts/encode-native-text.ts). Regenerate the table when a native method
// is added or its Java signature changes.
#include <jni.h>

#include <string>
#include <vector>

#include "jni_natives.h"
#include "obscured_text.h"

namespace {

struct NativeMethod {
  const char* name;
  const char* signature;
  void* function;
};

struct NativeClass {
  const char* name;
  std::vector<NativeMethod> methods;
};

const std::vector<NativeClass>& NativeClasses() {
  static const std::vector<NativeClass> classes = {
  {"3919bbc3ab8a6b512c3e08f0c0b6df60452311edfbc8f780624b2d1de38c8ebc8e7e42342de4daa0",  // NativeCore
   {
       {"3d12e0e2bb9b784a302b19fdf2ba966b7c2216f2f7d4b6", "725edd",
        reinterpret_cast<void*>(&pushy::jni_natives::SupportedDiffVersion)},
   }},
  {"3919bbc3ab8a6b512c3e08f0c0b6df60452311edfbc8f780624b2d1de38c95ad9e7640342de4c6b1878768",  // UpdateContext
   {
       {"290efad29d9f6951270815edde9199634b351dd7fbc9ab9c7d41", "723bfed0b88a274923311bb6e5a7826444205fcdf4daae943d432d07e18c93a9887e5a3655c7cbabcd8d79583507feccbe8e7244113617f1c7a3897a09361019fbc3b1de5d5f2911e7dcd3ab9341553e1febd0faf7b77b5b7d1de9c8a5976e7c4e3e02f481a687615753390ab9c6a0896b53214e2defd9a1974c433b03d1c5ceaf9b600a",
        reinterpret_cast<void*>(&pushy::jni_natives::SyncStateWithBinaryVersion)},
       {"2802fae2ba8a7c4001300efc", "723ed8d2a0c47a40233c08f7d7a7997b4f6809eefaceb49061003919e2c2b4b8d54440301aeeebaa909a4e5c2506fcd9f1ab6e40483a57f9d3a18b2675371214f4d0efab54020406ecb0cebc977044230bf3cdb7bbd4755a361ae0ccb5cc756d5e3600f481989c64565a1f16e4d682887952281545",
        reinterpret_cast<void*>(&pushy::jni_natives::RunStateCore)},
   }},
  {"3919bbc3ab8a6b512c3e08f0c0b6df60452311edfbc8f780624b2d1de38c84b28d79583e0feffca49194",  // DownloadTask
   {
       {"3802fdddaaaa7a462a360afce6bf9163", "723ecffda48a7e446d331df7d1fca379582e0ae6a5e0949f73592d46eac2aebad544402307e5cffeb9b376582012bfc1ab89630e6d2f0afcdca8d7526a29010bfb98b890604c6736f6edd5b79128190109e98bb3bb9a7b413c0ef8c0b0862f70553301fdcbb8c770525b3d0df39c919f694f2d171bcbd9a191677c2507edf2d8a982784575",
        reinterpret_cast<void*>(&pushy::jni_natives::BuildArchivePlan)},
       {"3802fdddaaa867553b180ef6c3a383", "722cd8dbaf9d690a2e3e12fe9980847f432903bac5f7b294644e6305e7cda7f2a963463800ec93ecb9b37f577901f5cca9936a404a320ef09da2836d532f050eb5c2a4956f5f2d4ac1f0cca0b1615f381ad5c1b2ab976c0e",
        reinterpret_cast<void*>(&pushy::jni_natives::BuildCopyGroups)},
       {"3b07e4ddb7af6d49363e3aebd9bea3625f3507e4", "723bfed0b88a274923311bb6e5a7826444205fcdf4daae943d432d07e18c93a9887e5a3655c7c2a4949e3355371df78299937648503c43d9d8ae9a68092f0113fd9887857c422602b9d3d6b880721f210be9c3ee8d8f6a5c3c08b7e5ac82767c153b15ffc9e4bb715056321eade98ba16046320051f7d9bb95207f3d14eacedae1ac585b2f1de98aaebe927e190004ffc3a9833a45773214e4cee385674d277229e3c6b8806c1309081eead8f99f71432d48d7d5ccb2967209663a",
        reinterpret_cast<void*>(&pushy::jni_natives::ApplyDeltaFromSource)},
       {"391bf1d0a09e786a2e3b39f7c2a1996859", "723bfed0b88a274923311bb6e5a7826444205fcdf4daae943d432d07e18c93a9887e5a3655c7c2a4949e3355371df78299937648503c43dc9b99",
        reinterpret_cast<void*>(&pushy::jni_natives::CleanupOldEntries)},
   }},
  {"3919bbc3ab8a6b512c3e08f0c0b6df60452311edfbc8f780624b2d1de38c86b19560762307efcfa0",  // FlowBridge
   {
       {"3802fdddaab96d54373a0fedf4bc9474", "723bfed0b88a274923311bb6e5a7826444205fa8d2d1b98373002008e8c4ef8e8e655d3f09b0",
        reinterpret_cast<void*>(&pushy::jni_natives::FlowBuildRequestBody)},
       {"3505f0d4bcae6641323015f7c29091634e2e00e0eadeab", "723bfed0b88a274923311bb6e5a7826444205fc5b7f7b294644e6305e7cda7f2a963463800ec93",
        reinterpret_cast<void*>(&pushy::jni_natives::FlowOrderEndpointCandidates)},
       {"3304c2d0a2826c77272c0cf6d8a095", "723bfed0b88a274923311bb6e5a7826444205fa8c4",
        reinterpret_cast<void*>(&pushy::jni_natives::FlowIsValidResponse)},
       {"3216fad5a28e5a40312f13f7c5b6", "723bfed0b88a274923311bb6e5a7826444205fcdf4daae943d432d07e18c93a9887e5a3655c7c2a4949e3355371df78299937648503c43bcfea58d7f476c0c1cf4d0fba27a59210be5a4",
        reinterpret_cast<void*>(&pushy::jni_natives::FlowHandleResponse)},
   }},
  };
  return classes;
}

// Registers each method on its own: a host's R8 build may drop an unused
// class or native method, which must not prevent the rest from binding.
void RegisterAll(JNIEnv* env) {
  for (const NativeClass& native_class : NativeClasses()) {
    const std::string class_name = pushy::text::Reveal(native_class.name);
    jclass clazz = env->FindClass(class_name.c_str());
    if (clazz == nullptr) {
      env->ExceptionClear();
      continue;
    }
    for (const NativeMethod& method : native_class.methods) {
      const std::string name = pushy::text::Reveal(method.name);
      const std::string signature = pushy::text::Reveal(method.signature);
      const JNINativeMethod entry = {
          const_cast<char*>(name.c_str()),
          const_cast<char*>(signature.c_str()),
          method.function,
      };
      if (env->RegisterNatives(clazz, &entry, 1) != JNI_OK) {
        env->ExceptionClear();
      }
    }
    env->DeleteLocalRef(clazz);
  }
}

}  // namespace

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  JNIEnv* env = nullptr;
  if (vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK) {
    return JNI_ERR;
  }
  RegisterAll(env);
  return JNI_VERSION_1_6;
}
