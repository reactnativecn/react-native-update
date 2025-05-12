/**
 * MIT License
 *
 * Copyright (C) 2023 Huawei Device Co., Ltd.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

#ifndef GEO_LOCATION_PACKAGE_H
#define GEO_LOCATION_PACKAGE_H

#include "RNOH/Package.h"
#include "PushyTurboModule.h"

using namespace rnoh;
using namespace facebook;

class PushyTurboModuleFactoryDelegate : public TurboModuleFactoryDelegate {
public:
    SharedTurboModule createTurboModule(Context ctx, const std::string &name) const override
    {
        if (name == "Pushy") {
        return std::make_shared<PushyTurboModule>(ctx, name);
        }
        return nullptr;
    };
};

namespace rnoh {
class PushyPackage : public Package {
public:
    PushyPackage(Package::Context ctx) : Package(ctx){}
    std::unique_ptr<TurboModuleFactoryDelegate> createTurboModuleFactoryDelegate() override
    {
    return std::make_unique<PushyTurboModuleFactoryDelegate>();
    }
};
} // namespace rnoh
#endif
