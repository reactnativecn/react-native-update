#include "RNOH/PackageProvider.h"
#include "PushyPackage.h"
using namespace rnoh;

std::vector<std::shared_ptr<Package>> PackageProvider::getPackages(Package::Context ctx) {
    return {
         std::make_shared<PushyPackage>(ctx)
    };
}