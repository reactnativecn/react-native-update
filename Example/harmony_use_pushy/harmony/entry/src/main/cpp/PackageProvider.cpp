#include "RNOH/PackageProvider.h"

#if __has_include("PushyPackage.h")
#include "PushyPackage.h"
#define HAS_PUSHY_PACKAGE 1
#else
#define HAS_PUSHY_PACKAGE 0
#endif

using namespace rnoh;

std::vector<std::shared_ptr<Package>> PackageProvider::getPackages(Package::Context ctx) {
#if HAS_PUSHY_PACKAGE
    return {
         std::make_shared<PushyPackage>(ctx)
    };
#else
    return {};
#endif
}
